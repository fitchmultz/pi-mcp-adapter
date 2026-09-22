// MCP protocol content to model-visible content.

import type { McpContent, ContentBlock } from "./types.ts";
import { formatMcpPayloadFile, type McpPayloadFile } from "./mcp-output-guard.ts";

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      const resourceContent = c.resource?.text ?? (c.resource?.blob !== undefined ? "[Binary content; not rendered]" : "(no content)");
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${c.mimeType ?? "audio/*"}; not rendered]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/** Human content and structured content are complementary protocol fields. */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
  const blocks = transformMcpContent((Array.isArray(result.content) ? result.content : []) as McpContent[]);
  if (result.structuredContent !== undefined) {
    blocks.push({ type: "text", text: stringifyStructuredContent(result.structuredContent) });
  }
  return blocks;
}

/** Persist content the model cannot consume; never imply an audio/blob payload was rendered. */
export function renderMcpResultContent(result: Record<string, unknown>, payloadFiles: McpPayloadFile[] = []): ContentBlock[] {
  const content: McpContent[] = Array.isArray(result.contents)
    ? result.contents.map(resource => typeof resource.text === "string" ? { type: "text", text: resource.text } : { type: "resource", resource })
    : Array.isArray(result.content) ? result.content : [];
  const rendered = content.map((block, index) => {
    const file = payloadFiles.find(file => file.index === index);
    return file ? { type: "text" as const, text: formatMcpPayloadFile(file) } : block;
  });
  return resolveMcpResultContent({ ...result, content: rendered });
}

function stringifyStructuredContent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
