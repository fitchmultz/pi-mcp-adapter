import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  guardedMcpDetails,
  resolveMcpOutputGuardOptions,
  formatMcpResultReference,
} from "./mcp-output-guard.ts";
import { createMcpOutputSpool } from "./mcp-output-preview.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import type { ContentBlock, McpOperationContext } from "./types.ts";
import { DEFAULT_MCP_SCRIPT_TIMEOUT_MS } from "./utils.ts";
import {
  McpScriptCaptureError,
  ScriptOperations,
  type ScriptOperation,
} from "./mcp-script-operations.ts";
import { McpScriptTimeoutError, ScriptExecution } from "./mcp-script-execution.ts";

type ScriptArguments = [
  state: McpExtensionState,
  code: string,
  timeoutMs?: number | null,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
  toolCallId?: string,
  beforeDispatch?: (
    signal: AbortSignal | undefined,
    operation: McpOperationContext,
  ) => Promise<void>,
];
type ScriptFailure = {
  error: "timeout" | "aborted" | "script_error" | "call_capture_failed";
  message: string;
  recovery?: unknown;
};
type ScriptResult = {
  content: ContentBlock[];
  details: {
    mode: string;
    timeoutMs: number | null;
    resultRefs?: string[];
    error?: ScriptFailure["error"];
    message?: string;
    recovery?: unknown;
    calls?: ScriptOperation[];
  } & ReturnType<typeof guardedMcpDetails>;
};

function resolveTimeout(timeoutMs: number | null): number | null {
  if (timeoutMs === null) {
    return null;
  }
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MCP_SCRIPT_TIMEOUT_MS;
}

function scriptFailure(error: unknown, signal: AbortSignal | undefined): ScriptFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof McpScriptCaptureError) {
    return { error: "call_capture_failed", message, recovery: error.recovery };
  }
  if (error instanceof McpScriptTimeoutError) {
    return { error: "timeout", message };
  }
  return { error: signal?.aborted === true ? "aborted" : "script_error", message };
}

async function runScript(options: {
  args: ScriptArguments;
  output: ReturnType<typeof createMcpOutputSpool>;
}): Promise<ScriptResult> {
  const [
    state,
    code,
    timeoutMs = DEFAULT_MCP_SCRIPT_TIMEOUT_MS,
    getPiTools,
    signal,
    toolCallId,
    beforeDispatch,
  ] = options.args;
  const { output } = options;
  const resolvedTimeoutMs = resolveTimeout(timeoutMs);
  const externalSignal = combineAbortSignals(state.owner.signal, signal);
  const timeoutController = new AbortController();
  const operations = new ScriptOperations(
    {
      state,
      getPiTools,
      signal: combineAbortSignals(externalSignal, timeoutController.signal),
      toolCallId,
      beforeDispatch,
    },
    output,
  );
  const execution = new ScriptExecution({ operations, output, externalSignal, timeoutController });
  let failure: ScriptFailure | undefined;
  try {
    await execution.run(code, resolvedTimeoutMs);
  } catch (error) {
    failure = scriptFailure(error, externalSignal);
    output.push({ type: "text", text: failure.message });
  } finally {
    await execution.close();
  }
  return finishScript(output, operations, resolvedTimeoutMs, failure);
}

function finishScript(
  output: ReturnType<typeof createMcpOutputSpool>,
  operations: ScriptOperations,
  timeoutMs: number | null,
  failure: ScriptFailure | undefined,
): ScriptResult {
  const calls = operations.snapshot();
  if (output.empty) {
    output.push({ type: "text", text: "(no output)" });
  }
  for (const text of operations.payloadNotices) {
    output.push({ type: "text", text });
  }
  for (const ref of operations.resultRefs) {
    output.push({ type: "text", text: formatMcpResultReference(ref) });
  }
  const guarded = output.finish();
  return {
    content: guarded.content,
    details: {
      mode: "script",
      ...(operations.resultRefs.size > 0 ? { resultRefs: [...operations.resultRefs] } : {}),
      ...(failure ? { error: failure.error, message: failure.message } : {}),
      timeoutMs,
      ...(failure?.recovery !== undefined ? { recovery: failure.recovery } : {}),
      ...(calls.length > 0 ? { calls } : {}),
      ...guardedMcpDetails(guarded),
    },
  };
}

export async function runMcpScript(...args: ScriptArguments): Promise<ScriptResult> {
  const [state] = args;
  state.activeScripts++;
  try {
    const output = createMcpOutputSpool(
      resolveMcpOutputGuardOptions(state.config.settings, state.outputDirectory),
    );
    return await runScript({ args, output });
  } finally {
    state.activeScripts--;
  }
}
