// MCP protocol content to model-visible content.
import type { McpContent, ContentBlock } from "./types.ts";
import { formatMcpPayloadFile, type McpPayloadFile } from "./mcp-output-guard.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

function stringProperty(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : fallback;
}

function renderResource(value: unknown): ContentBlock {
  const resource = asObjectRecord(value);
  const resourceUri = stringProperty(resource, "uri", "(no URI)");
  const resourceContent = stringProperty(
    resource,
    "text",
    resource?.blob !== undefined ? "[Binary content; not rendered]" : "(no content)",
  );
  return { type: "text", text: `[Resource: ${resourceUri}]\n${resourceContent}` };
}

function renderContent(value: unknown): ContentBlock {
  const block = asObjectRecord(value);
  switch (block?.type) {
    case "text":
      return { type: "text", text: stringProperty(block, "text", "") };
    case "image":
      return {
        type: "image",
        data: stringProperty(block, "data", ""),
        mimeType: stringProperty(block, "mimeType", "image/png"),
      };
    case "resource":
      return renderResource(block.resource);
    case "resource_link": {
      const linkName = stringProperty(block, "name", stringProperty(block, "uri", "unknown"));
      const linkUri = stringProperty(block, "uri", "(no URI)");
      return { type: "text", text: `[Resource Link: ${linkName}]\nURI: ${linkUri}` };
    }
    case "audio":
      return {
        type: "text",
        text: `[Audio content: ${stringProperty(block, "mimeType", "audio/*")}; not rendered]`,
      };
    default:
      const rendered: unknown = JSON.stringify(value);
      return { type: "text", text: typeof rendered === "string" ? rendered : String(value) };
  }
}

/** Transform MCP content types to Pi content blocks. */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(renderContent);
}

/** Human content and structured content are complementary protocol fields. */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
  const blocks = isUnknownArray(result.content) ? result.content.map(renderContent) : [];
  if (result.structuredContent !== undefined) {
    blocks.push({ type: "text", text: stringifyStructuredContent(result.structuredContent) });
  }
  return blocks;
}

function renderResourceContent(resource: unknown): unknown {
  const record = asObjectRecord(resource);
  return typeof record?.text === "string"
    ? { type: "text", text: record.text }
    : { type: "resource", resource };
}

/** Persist content the model cannot consume; never imply an audio/blob payload was rendered. */
export function renderMcpResultContent(
  result: Record<string, unknown>,
  payloadFiles: McpPayloadFile[] = [],
): ContentBlock[] {
  let content: unknown[] = [];
  if (isUnknownArray(result.contents)) {
    content = result.contents.map(renderResourceContent);
  } else if (isUnknownArray(result.content)) {
    content = result.content;
  }
  const rendered = content.map((block, index) => {
    const payload = payloadFiles.find((candidate) => candidate.index === index);
    return payload ? { type: "text", text: formatMcpPayloadFile(payload) } : block;
  });
  return resolveMcpResultContent({ ...result, content: rendered });
}

function stringifyStructuredContent(value: unknown): string {
  try {
    const rendered: unknown = JSON.stringify(value, null, 2);
    return typeof rendered === "string" ? rendered : String(value);
  } catch {
    return String(value);
  }
}
