import {
  type McpOutputGuardOptions,
  type RetainedMcpResult,
  guardMcpOutput,
  guardedMcpDetails,
  retainMcpResult,
} from "./mcp-output-guard.ts";
import { renderMcpResultContent } from "./tool-registrar.ts";
import type { UiSessionResultSummary } from "./ui-session.ts";
import type { ProxyToolResult } from "./proxy-result.ts";

interface CallResultRequest {
  target: { resourceUri?: string; uiResourceUri?: string };
  uiSummary: UiSessionResultSummary | undefined;
  detailsBase: Record<string, unknown>;
  outputGuardOptions: McpOutputGuardOptions;
  schemaSuffix: () => string;
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
      ...resultAffixes(record.isError === true, request, uiSummary),
    },
  );
  return {
    content: guarded.content,
    ...(isError ? { isError: true } : {}),
    details: { ...details, ...guardedMcpDetails(guarded) },
  };
}

function resultAffixes(
  isError: boolean,
  request: CallResultRequest,
  uiSummary: UiSessionResultSummary | undefined,
): McpOutputGuardOptions {
  if (isError) {
    return {
      prefix: "Error: ",
      suffix: request.schemaSuffix(),
      emptyTextFallback: "Tool execution failed",
    };
  }
  return uiSummary ? { suffix: `\n\n${uiSummary.message}` } : {};
}
