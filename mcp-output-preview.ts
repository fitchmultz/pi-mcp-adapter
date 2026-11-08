import type { McpOutputGuardDetails } from "./mcp-output-contracts.ts";
import type { ContentBlock } from "./types.ts";

interface TruncatedOutputInput {
  text: string;
  stats: { bytes: number; lines: number };
  artifact: { path?: string; error?: string };
  imageBlocks: ContentBlock[];
  maxBytes: number;
  maxLines: number;
  referenceSuffix?: string;
}

export function truncatedOutput({
  text,
  stats,
  artifact: { path: fullOutputPath, error: writeError },
  imageBlocks,
  maxBytes,
  maxLines,
  referenceSuffix = "",
}: TruncatedOutputInput): { content: ContentBlock[]; outputGuard: McpOutputGuardDetails } {
  const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
  const previewBudget = reserveBudget(maxBytes, maxLines, notice + referenceSuffix);
  const preview = truncateHead(text, previewBudget.maxBytes, previewBudget.maxLines);
  const finalText = `${preview.content}\n\n${notice}`;
  const finalStats = textStats(finalText + referenceSuffix);
  return {
    content: [{ type: "text" as const, text: finalText }, ...imageBlocks],
    outputGuard: {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
      ...(writeError !== undefined ? { writeError } : {}),
    },
  };
}

export function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") {
      return block;
    }
    const mimeType =
      typeof block.mimeType === "string" && block.mimeType.trim() !== ""
        ? block.mimeType.trim().slice(0, 100)
        : "image/png";
    return { ...block, mimeType };
  });
}

function reserveBudget(
  maxBytes: number,
  maxLines: number,
  notice: string,
): { maxBytes: number; maxLines: number } {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(
  text: string,
  maxBytes: number,
  maxLines: number,
): { content: string; bytes: number; lines: number } {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) {
      break;
    }
    const separatorBytes = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      const remaining = maxBytes - bytes - separatorBytes;
      if (remaining > 0) {
        output.push(truncateStringToBytes(line, remaining));
      }
      break;
    }
    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  const content = output.join("\n");
  const stats = textStats(content);
  return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8");
  let end = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: { bytes: number; lines: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath !== undefined && fullOutputPath !== "") {
    return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

export function textStats(text: string): { bytes: number; lines: number } {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
