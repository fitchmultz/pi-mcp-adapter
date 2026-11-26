import type { GetPromptResult, PromptMessage } from "@modelcontextprotocol/client";
import type { ContentBlock } from "./types.ts";
import { classifyResourceBlob, isImageMimeType, normalizeMimeType } from "./mcp-output-media.ts";

/**
 * Flatten a `GetPromptResult` into a single string suitable for plain-text
 * callers. Preserves role attribution as inline markers for multi-message
 * prompts or non-user roles.
 */
export function formatPromptResult(result: GetPromptResult): string {
  const lines: string[] = [];
  for (const message of result.messages) {
    const text = extractMessageText(message);
    if (text === "") {
      continue;
    }
    if (message.role === "user" && result.messages.length === 1) {
      lines.push(text);
    } else {
      lines.push(`[${message.role}] ${text}`);
    }
  }
  return lines.join("\n\n").trim();
}

/**
 * Render a `GetPromptResult` into native Pi content blocks, preserving
 * vision-safe image blocks and embedded image resource blobs as native
 * `ImageContent` while keeping text and role attribution intact.
 */
export function formatPromptContent(result: GetPromptResult): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let pendingText: string[] = [];
  const singleMessage = result.messages.length === 1;

  for (const message of result.messages) {
    const rendered = renderPromptMessageBlock(message);
    if (!rendered) {
      continue;
    }
    if (rendered.type === "text") {
      appendRoleText(pendingText, message.role, rendered.text, singleMessage);
      continue;
    }
    if (message.role !== "user") {
      pendingText.push(`[${message.role}]`);
    }
    const textBlock = buildFlushedTextBlock(pendingText);
    pendingText = [];
    if (textBlock) {
      blocks.push(textBlock);
    }
    blocks.push(rendered);
  }

  const trailing = buildFlushedTextBlock(pendingText);
  if (trailing) {
    blocks.push(trailing);
  }
  return blocks;
}

function appendRoleText(
  pendingText: string[],
  role: PromptMessage["role"],
  text: string,
  singleMessage: boolean,
): void {
  if (text === "") {
    return;
  }
  pendingText.push(singleMessage && role === "user" ? text : `[${role}] ${text}`);
}

function buildFlushedTextBlock(pendingText: readonly string[]): ContentBlock | undefined {
  if (pendingText.length === 0) {
    return undefined;
  }
  const combined = pendingText.join("\n\n").trim();
  return combined !== "" ? { type: "text", text: combined } : undefined;
}

function renderPromptMessageBlock(message: PromptMessage): ContentBlock | null {
  const content = message.content;
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return renderPromptImage(content.data, content.mimeType);
    case "resource":
      return renderPromptResource(content.resource);
    case "resource_link":
      return { type: "text", text: formatPromptResourceLink(content) };
    case "audio":
      return { type: "text", text: `[audio ${content.mimeType}]` };
    default:
      return null;
  }
}

function renderPromptImage(data: string, mimeType: string): ContentBlock {
  if (data !== "" && isImageMimeType(mimeType)) {
    return {
      type: "image",
      data,
      mimeType: normalizeMimeType(mimeType) ?? "image/png",
    };
  }
  return {
    type: "text",
    text: `[image ${mimeType}${data !== "" ? " (embedded)" : ""}]`,
  };
}

function renderPromptResource(
  resource: Extract<PromptMessage["content"], { type: "resource" }>["resource"],
): ContentBlock {
  if ("text" in resource && typeof resource.text === "string") {
    return { type: "text", text: `[resource ${resource.uri}]\n${resource.text}` };
  }
  const classified = classifyResourceBlob(resource);
  if (classified?.kind === "image") {
    return { type: "image", data: classified.data, mimeType: classified.mimeType };
  }
  if (classified?.kind === "text") {
    return { type: "text", text: `[resource ${resource.uri}]\n${classified.text}` };
  }
  return { type: "text", text: `[resource ${resource.uri}]` };
}

function formatPromptResourceLink(
  content: Extract<PromptMessage["content"], { type: "resource_link" }>,
): string {
  const header = `[resource_link ${content.uri}${content.name !== "" ? ` — ${content.name}` : ""}]`;
  const lines = [header];
  const fields: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Title", content.title],
    ["Description", content.description],
    ["MIME type", content.mimeType],
  ];
  for (const [label, value] of fields) {
    if (value !== undefined && value !== "") {
      lines.push(`${label}: ${value}`);
    }
  }
  if (typeof content.size === "number" && Number.isFinite(content.size) && content.size >= 0) {
    lines.push(`Size: ${content.size} bytes`);
  }
  return lines.join("\n");
}

function extractMessageText(message: PromptMessage): string {
  const content = message.content;
  switch (content.type) {
    case "text":
      return content.text;
    case "resource": {
      const resource = content.resource;
      if ("text" in resource && typeof resource.text === "string") {
        return `[resource ${resource.uri}]\n${resource.text}`;
      }
      const classified = classifyResourceBlob(resource);
      if (classified?.kind === "text") {
        return `[resource ${resource.uri}]\n${classified.text}`;
      }
      return `[resource ${resource.uri}]`;
    }
    case "resource_link":
      return formatPromptResourceLink(content);
    case "image":
      return `[image ${content.mimeType}${content.data !== "" ? " (embedded)" : ""}]`;
    case "audio":
      return `[audio ${content.mimeType}]`;
    default:
      return "";
  }
}
