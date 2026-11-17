import type { McpOutputGuardDetails } from "./mcp-output-contracts.ts";
import type { ContentBlock } from "./types.ts";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

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
  const preview = truncateHead(text, previewBudget);
  // Pi yields nothing when a single line alone exceeds the budget; keep a byte-bounded head instead.
  const head =
    preview.firstLineExceedsLimit && previewBudget.maxBytes > 0
      ? Buffer.from(text, "utf8").subarray(0, previewBudget.maxBytes).toString("utf8")
      : preview.content;
  const finalText = `${head}\n\n${notice}`;
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
