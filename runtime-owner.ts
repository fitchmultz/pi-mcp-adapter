import type { McpCheckpointEvent } from "./checkpoint.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatTerminalError } from "./utils.ts";

export interface McpRuntimeOwner {
  readonly signal: AbortSignal;
  isActive(): boolean;
  addCleanup(cleanup: () => void | Promise<void>): void;
  stop(reason?: string): Promise<void>;
  throwIfInactive(): void;
  beforeActivity(): void;
  holdCheckpoint(event: McpCheckpointEvent): () => void;
  runCallback<T>(kind: "beforeExecute" | "onToolCall", run: () => Promise<T>): Promise<T>;
  getCheckpointBlocker(): string | undefined;
}

export function createMcpRuntimeOwner(): McpRuntimeOwner {
  const controller = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let stopPromise: Promise<void> | undefined;
  let checkpoint: McpCheckpointEvent | undefined;
  const beforeActivity = () => checkpoint?.invalidate();
  // These two host hooks can outlive abortable() at their call sites. Count their underlying
  // promises through settlement, without cancelling, serializing, or replaying callback work.
  const callbacks = { beforeExecute: 0, onToolCall: 0 };
  const getCheckpointBlocker = () => {
    if (callbacks.beforeExecute) return "MCP beforeExecute callback is pending";
    if (callbacks.onToolCall) return "MCP onToolCall callback is pending";
    return undefined;
  };

  const reportCleanupFailure = (error: unknown, late: boolean) => {
    console.error(`MCP: ${late ? "late " : ""}runtime cleanup failed: ${formatTerminalError(error)}`);
  };

  return {
    signal: controller.signal,
    beforeActivity,
    getCheckpointBlocker,
    runCallback: async (kind, run) => {
      beforeActivity();
      // Invocation/cancellation policy stays at the call site. In particular, an accepted
      // tool's outcome callback may still need to persist its result during shutdown.
      callbacks[kind]++;
      try { return await run(); } finally { callbacks[kind]--; }
    },
    holdCheckpoint: event => {
      if (checkpoint) throw new Error("MCP checkpoint is already held");
      checkpoint = event;
      return () => { if (checkpoint === event) checkpoint = undefined; };
    },
    isActive: () => !controller.signal.aborted,
    addCleanup: cleanup => {
      if (controller.signal.aborted) {
        void Promise.resolve().then(cleanup).catch(error => reportCleanupFailure(error, true));
        return;
      }
      cleanups.push(cleanup);
    },
    stop: (reason = "MCP extension runtime stopped") => {
      if (stopPromise) return stopPromise;
      beforeActivity();
      controller.abort(new Error(reason));
      const pendingCleanups = cleanups.splice(0).reverse().map(cleanup =>
        Promise.resolve().then(cleanup),
      );
      stopPromise = Promise.allSettled(pendingCleanups).then(results => {
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        const pendingCallback = getCheckpointBlocker();
        if (pendingCallback) failures.push(new Error(pendingCallback));
        if (failures.length > 0) {
          const aggregate = new AggregateError(failures, "MCP runtime cleanup failed");
          console.error(`MCP: runtime cleanup failed: ${formatTerminalError(aggregate)}`);
          throw aggregate;
        }
      });
      return stopPromise;
    },
    throwIfInactive: () => { beforeActivity(); controller.signal.throwIfAborted(); },
  };
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

/** Fence session-bound UI calls after the owning extension runtime stops. */
export function createOwnedUi(ui: ExtensionUIContext, owner: McpRuntimeOwner): ExtensionUIContext {
  const proxies = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return value;
    }
    const object = value as object;
    const existing = proxies.get(object);
    if (existing) return existing;

    const proxy = new Proxy(object, {
      get(target, property, receiver) {
        if (!owner.isActive()) return undefined;
        const member = Reflect.get(target, property, receiver);
        if (typeof member === "function") {
          return (...args: unknown[]) => {
            if (!owner.isActive()) return undefined;
            return Reflect.apply(member, target, args);
          };
        }
        return owner.isActive() ? wrap(member) : undefined;
      },
    });
    proxies.set(object, proxy);
    return proxy;
  };
  return wrap(ui) as ExtensionUIContext;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === "MCP extension runtime stopped");
}
