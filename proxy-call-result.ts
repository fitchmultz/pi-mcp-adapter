import type { Progress } from "@modelcontextprotocol/client";
import {
  type McpOutputGuardOptions,
  type RetainedMcpResult,
  guardMcpOutput,
  guardedMcpDetails,
  retainMcpResult,
} from "./mcp-output-guard.ts";
import { attachRawMcpResult } from "./mcp-script-output.ts";
import { renderMcpResultContent } from "./tool-registrar.ts";
import type { UiSessionResultSummary } from "./ui-session.ts";
import type { ProxyToolResult } from "./proxy-result.ts";
import type { ToolMetadata } from "./types.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";
import { formatSchema } from "./tool-metadata.ts";
import { sanitizeTerminalText } from "./utils.ts";

export function formatProgressText(progress: Progress): string {
  const message = progress.message === undefined ? "" : sanitizeTerminalText(progress.message);
  if (message !== "") {
    return message;
  }
  const total = progress.total === undefined ? "" : `/${progress.total}`;
  return `Progress ${progress.progress}${total}`;
}

function formatTimeoutDuration(timeoutMs: number): string {
  const rounded = Math.ceil(timeoutMs);
  return rounded >= 1000 && rounded % 1000 === 0
    ? `${rounded / 1000}s (${rounded}ms)`
    : `${rounded}ms`;
}

export function formatInterruptedTimeoutMessage(
  serverName: string,
  toolName: string,
  timeoutMs: number,
): string {
  return `MCP tool "${toolName}" on "${serverName}" timed out after ${formatTimeoutDuration(timeoutMs)}. The outcome is unknown after the call was interrupted. Read back the original operation using its saved arguments and provider identity before continuing. Do not blindly repeat the call. Raise requestTimeoutMs per server or globally in settings if this tool needs more time between progress updates.`;
}

export function formatTimeoutMessage(
  serverName: string,
  target: Pick<ToolMetadata, "originalName" | "resourceUri">,
  timeoutMs: number,
): string {
  const resourceUri = target.resourceUri;
  const subject =
    resourceUri !== undefined && resourceUri.length > 0
      ? `MCP resource "${resourceUri}"`
      : `MCP tool "${target.originalName}"`;
  return `${subject} on "${serverName}" timed out after ${formatTimeoutDuration(timeoutMs)}. Raise requestTimeoutMs per server or globally in settings if this request needs more time between progress updates.`;
}

// Match the leading diagnostic, not provider messages that quote validation terms inside an API error.
const INPUT_VALIDATION =
  /^(?:error:\s*)?(?:(?:input|argument|parameter|schema) validation error\b|validation error(?::|$)|validating "(?:arguments|params)":|(?:invalid|missing|unrecognized|unknown|unexpected) (?:required )?(?:arguments?|params?|parameters?|keys?|fields?|enum(?: value)?|types?)\b)/i;

export function expectedParametersHint(schema: ToolMetadata["inputSchema"]): string {
  return schema ? `\n\nExpected parameters:\n${formatSchema(schema)}` : "";
}

export function inputValidationHint(
  schema: ToolMetadata["inputSchema"],
  diagnostic: string,
): string {
  return schema && INPUT_VALIDATION.test(diagnostic.trimStart())
    ? expectedParametersHint(schema)
    : "";
}

export async function guardGenericCallFailure(options: {
  message: string;
  stderrTail: string;
  aborted: boolean;
  suffix: string;
  detailsBase: Record<string, unknown>;
  outputGuardOptions: McpOutputGuardOptions;
}): Promise<ProxyToolResult> {
  const { message, stderrTail, aborted, suffix, detailsBase, outputGuardOptions } = options;
  const guarded = await guardMcpOutput([{ type: "text", text: message }], {
    ...outputGuardOptions,
    prefix: "Failed to call tool: ",
    suffix,
  });
  return {
    content: guarded.content,
    isError: true,
    details: {
      ...detailsBase,
      error: aborted ? "aborted" : "call_failed",
      message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
      ...stderrDetails(stderrTail),
      ...guardedMcpDetails(guarded),
    },
  };
}

interface CallResultRequest {
  target: Pick<ToolMetadata, "resourceUri" | "inputSchema">;
  uiSummary: UiSessionResultSummary | undefined;
  detailsBase: Record<string, unknown>;
  outputGuardOptions: McpOutputGuardOptions;
}
export async function toolCallResult(
  result: Record<string, unknown>,
  request: CallResultRequest,
): Promise<ProxyToolResult> {
  const record = result;
  const isError = record.isError === true;
  const { uiSummary } = request;
  const details = {
    ...request.detailsBase,
    ...(isError ? { error: "tool_error" } : {}),
    ...(uiSummary
      ? { uiOpen: uiSummary.uiOpen, uiViewer: uiSummary.uiViewer, uiUrl: uiSummary.uiUrl }
      : {}),
  };
  const retained = await retainMcpResult(result, request.outputGuardOptions);
  return renderedCallResult(record, request, { details, retained, uiSummary });
}
async function renderedCallResult(
  record: Record<string, unknown>,
  request: CallResultRequest,
  {
    details,
    retained,
    uiSummary,
  }: {
    details: Record<string, unknown>;
    retained: RetainedMcpResult;
    uiSummary: UiSessionResultSummary | undefined;
  },
): Promise<ProxyToolResult> {
  const isError = record.isError === true;
  const content = renderMcpResultContent(record, retained.payloadFiles);
  const guarded = await guardMcpOutput(
    content.length > 0
      ? content
      : [
          {
            type: "text",
            text:
              (request.target.resourceUri ?? "").length > 0 ? "(empty resource)" : "(empty result)",
          },
        ],
    {
      ...request.outputGuardOptions,
      retainedMcpResult: retained,
      ...resultAffixes(record, request, uiSummary),
    },
  );
  return attachRawMcpResult(
    {
      content: guarded.content,
      ...(isError ? { isError: true } : {}),
      details: { ...details, ...guardedMcpDetails(guarded) },
    },
    record,
  );
}

function textDiagnostics(blocks: unknown): string[] {
  if (!isUnknownArray(blocks)) {
    return [];
  }
  const diagnostics: string[] = [];
  for (const block of blocks) {
    const record = asObjectRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      diagnostics.push(record.text);
    }
  }
  return diagnostics;
}

function resultAffixes(
  result: Record<string, unknown>,
  request: CallResultRequest,
  uiSummary: UiSessionResultSummary | undefined,
): McpOutputGuardOptions {
  if (result.isError === true) {
    const hasValidationError = textDiagnostics(result.content).some((diagnostic) =>
      INPUT_VALIDATION.test(diagnostic.trimStart()),
    );
    return {
      prefix: "Error: ",
      suffix: hasValidationError ? expectedParametersHint(request.target.inputSchema) : "",
      emptyTextFallback: "Tool execution failed",
    };
  }
  return uiSummary ? { suffix: `\n\n${uiSummary.message}` } : {};
}

export function appendStderrTail(baseMessage: string, stderrTail: string): string {
  return stderrTail.length > 0 && !baseMessage.includes(stderrTail)
    ? `${baseMessage}\n\nRecent server stderr:\n${stderrTail}`
    : baseMessage;
}

export function stderrDetails(stderrTail: string): { stderr?: string } {
  return stderrTail.length > 0 ? { stderr: stderrTail } : {};
}

export function createNoProgressBudget(
  callerSignal: AbortSignal,
  remainingTimeoutMs: number | undefined,
  createTimeoutError: () => Error,
  combine: (a: AbortSignal, b: AbortSignal) => AbortSignal | undefined,
): { signal: AbortSignal; clear?: () => void } {
  if (remainingTimeoutMs === undefined) {
    return { signal: callerSignal };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(createTimeoutError());
  }, remainingTimeoutMs);
  timer.unref();
  return {
    signal: combine(callerSignal, controller.signal) ?? controller.signal,
    clear: () => clearTimeout(timer),
  };
}
