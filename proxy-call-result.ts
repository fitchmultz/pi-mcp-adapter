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
import type { ToolMetadata } from "./types.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";
import { formatSchema } from "./tool-metadata.ts";

// Match the leading diagnostic, not provider messages that quote validation terms inside an API error.
const INPUT_VALIDATION =
  /^(?:error:\s*)?(?:(?:input|argument|parameter|schema) validation error\b|validation error(?::|$)|validating "(?:arguments|params)":|(?:invalid|missing|unrecognized|unknown|unexpected) (?:required )?(?:arguments?|params?|parameters?|keys?|fields?|enum(?: value)?|types?)\b)/i;

export function inputValidationHint(
  schema: ToolMetadata["inputSchema"],
  diagnostic: string,
): string {
  return schema && INPUT_VALIDATION.test(diagnostic.trimStart())
    ? `\n\nExpected parameters:\n${formatSchema(schema)}`
    : "";
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
  return {
    content: guarded.content,
    ...(isError ? { isError: true } : {}),
    details: { ...details, ...guardedMcpDetails(guarded) },
  };
}

function resultAffixes(
  result: Record<string, unknown>,
  request: CallResultRequest,
  uiSummary: UiSessionResultSummary | undefined,
): McpOutputGuardOptions {
  if (result.isError === true) {
    const blocks = result.content;
    const diagnostic = isUnknownArray(blocks)
      ? blocks.map(asObjectRecord).find((block) => block?.type === "text")?.text
      : undefined;
    return {
      prefix: "Error: ",
      suffix:
        typeof diagnostic === "string"
          ? inputValidationHint(request.target.inputSchema, diagnostic)
          : "",
      emptyTextFallback: "Tool execution failed",
    };
  }
  return uiSummary ? { suffix: `\n\n${uiSummary.message}` } : {};
}
