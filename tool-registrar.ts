// MCP protocol content to model-visible content.
import type { McpContent, ContentBlock } from "./types.ts";
import { formatMcpPayloadFile, type McpPayloadFile } from "./mcp-output-guard.ts";
import { classifyResourceBlob } from "./mcp-output-media.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

function stringProperty(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function renderResource(value: unknown): ContentBlock {
  const resource = asObjectRecord(value);
  const resourceUri = stringProperty(resource, "uri", "(no URI)");
  if (typeof resource?.text === "string") {
    return { type: "text", text: `[Resource: ${resourceUri}]\n${resource.text}` };
  }
  const classified = classifyResourceBlob(resource);
  if (classified?.kind === "image") {
    return { type: "image", data: classified.data, mimeType: classified.mimeType };
  }
  if (classified?.kind === "text") {
    return { type: "text", text: `[Resource: ${resourceUri}]\n${classified.text}` };
  }
  const fallback = resource?.blob !== undefined ? "[Binary content; not rendered]" : "(no content)";
  return { type: "text", text: `[Resource: ${resourceUri}]\n${fallback}` };
}

function renderResourceLink(block: Record<string, unknown> | undefined): ContentBlock {
  const linkName = stringProperty(block, "name", stringProperty(block, "uri", "unknown"));
  const linkUri = stringProperty(block, "uri", "(no URI)");
  const lines = [`[Resource Link: ${linkName}]`, `URI: ${linkUri}`];
  const labeledFields: Array<[string, unknown]> = [
    ["Title", block?.title],
    ["Description", block?.description],
    ["MIME type", block?.mimeType],
  ];
  for (const [label, rawValue] of labeledFields) {
    const value = nonEmptyString(rawValue);
    if (value !== undefined) {
      lines.push(`${label}: ${value}`);
    }
  }
  const size = block?.size;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
    lines.push(`Size: ${size} bytes`);
  }
  return { type: "text", text: lines.join("\n") };
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
    case "resource_link":
      return renderResourceLink(block);
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

function hasVisibleContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => block.type !== "text" || block.text.trim() !== "");
}

/** Fall back to structuredContent only when content has no visible blocks (matching Pi's builtin:mcp). */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
  const blocks = isUnknownArray(result.content) ? result.content.map(renderContent) : [];
  if (!hasVisibleContent(blocks) && result.structuredContent !== undefined) {
    return [{ type: "text", text: stringifyStructuredContent(result.structuredContent) }];
  }
  return blocks;
}

function renderResourceContent(resource: unknown): unknown {
  const record = asObjectRecord(resource);
  if (typeof record?.text === "string") {
    return { type: "text", text: record.text };
  }
  const classified = classifyResourceBlob(record);
  if (classified?.kind === "image") {
    return { type: "image", data: classified.data, mimeType: classified.mimeType };
  }
  if (classified?.kind === "text") {
    return { type: "text", text: classified.text };
  }
  return { type: "resource", resource };
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
