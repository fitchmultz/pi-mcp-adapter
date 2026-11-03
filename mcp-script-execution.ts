import { Worker } from "node:worker_threads";
import type { createMcpOutputSpool } from "./mcp-output-preview.ts";
import { parseWorkerMessage } from "./mcp-script-protocol.ts";
import { toScriptContentBlock } from "./mcp-script-values.mjs";
import type { ScriptOperations } from "./mcp-script-operations.ts";
import { abortable, throwIfAborted } from "./abort.ts";

/** UTF-16 units of emitted output, plus 256 per emit, the worker may queue before waiting for the host. */
const SCRIPT_OUTPUT_WINDOW = 4 * 1024 * 1024;
export class McpScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`mcp_script timed out after ${timeoutMs}ms`);
    this.name = "McpScriptTimeoutError";
  }
}
type Completion = { resolve: () => void; reject: (reason: unknown) => void };
type ExecutionOptions = {
  operations: ScriptOperations;
  output: ReturnType<typeof createMcpOutputSpool>;
  externalSignal: AbortSignal | undefined;
  timeoutController: AbortController;
};

export class ScriptExecution {
  private readonly options: ExecutionOptions;
  private readonly pending = new Set<Promise<void>>();
  private readonly outputFlow = new Int32Array(new SharedArrayBuffer(4));
  private worker: Worker | undefined;
  private termination: Promise<number> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private removeAbortListener: (() => void) | undefined;
  private completed = false;

  constructor(options: ExecutionOptions) {
    this.options = options;
  }

  private stopWorker(): void {
    if (this.worker && !this.termination) {
      this.termination = this.worker.terminate();
    }
  }

  private async respond(message: Parameters<ScriptOperations["dispatch"]>[0]): Promise<void> {
    const envelope = await this.options.operations.dispatch(message);
    this.worker?.postMessage({ type: "result", id: message.id, envelope });
  }

  private receive(value: unknown, completion: Completion): void {
    const message = parseWorkerMessage(value);
    if (!message || this.completed) {
      return;
    }
    switch (message.type) {
      case "emit": {
        this.options.output.push(toScriptContentBlock(message.block));
        const queued = Atomics.sub(this.outputFlow, 0, message.size) - message.size;
        if (queued <= SCRIPT_OUTPUT_WINDOW / 2) {
          Atomics.notify(this.outputFlow, 0);
        }
        return;
      }
      case "done":
        this.completed = true;
        if ("returnBlock" in message) {
          this.options.output.push(toScriptContentBlock(message.returnBlock));
        }
        completion.resolve();
        return;
      case "error":
        this.completed = true;
        completion.reject(new Error(message.message));
        return;
      case "call":
      case "describe":
      case "search":
      case "resources":
      case "readResource":
      case "readResult": {
        const operation = this.respond(message);
        this.pending.add(operation);
        operation
          .then(
            () => this.pending.delete(operation),
            (error: unknown) => {
              this.pending.delete(operation);
              completion.reject(error);
            },
          )
          .catch(completion.reject);
      }
    }
  }

  private execution(code: string): Promise<void> {
    const worker = new Worker(new URL("./mcp-script-worker.mjs", import.meta.url), {
      workerData: { code, outputFlow: this.outputFlow, outputWindow: SCRIPT_OUTPUT_WINDOW },
      env: {},
    });
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      const completion: Completion = { resolve, reject };
      worker.on("message", (value: unknown) => this.receive(value, completion));
      worker.once("error", reject);
      worker.once("exit", (exitCode) => {
        if (!this.completed && exitCode !== 0) {
          reject(new Error(`mcp_script worker exited with code ${exitCode}`));
        }
      });
    });
  }

  private timeout(timeoutMs: number): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const error = new McpScriptTimeoutError(timeoutMs);
      this.timer = setTimeout(() => {
        this.options.timeoutController.abort(error);
        this.stopWorker();
        reject(error);
      }, timeoutMs);
    });
  }

  private watchAbort(signal: AbortSignal): void {
    const onAbort = (): void => this.stopWorker();
    signal.addEventListener("abort", onAbort, { once: true });
    this.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  async run(code: string, timeoutMs: number | null): Promise<void> {
    const { externalSignal } = this.options;
    throwIfAborted(externalSignal);
    const races = [this.execution(code)];
    if (timeoutMs !== null) {
      races.push(this.timeout(timeoutMs));
    }
    if (externalSignal) {
      this.watchAbort(externalSignal);
    }
    await abortable(Promise.race(races), externalSignal);
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.removeAbortListener?.();
    this.worker?.removeAllListeners("message");
    // A script may return without joining dispatched calls. Cancel them and drain their outcome receipts.
    this.options.timeoutController.abort(new Error("mcp_script finished"));
    await Promise.allSettled(this.pending);
    this.stopWorker();
    await this.termination;
  }
}
