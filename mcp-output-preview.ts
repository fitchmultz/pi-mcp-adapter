import type { McpOutputGuardDetails } from "./mcp-output-contracts.ts";
import type { ContentBlock } from "./types.ts";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";

type TruncatedArtifactTarget =
  | { kind: "retained"; ref?: string; error?: string }
  | { kind: "output"; path?: string; error?: string };

interface TruncatedOutputInput {
  text: string;
  stats: { bytes: number; lines: number };
  target: TruncatedArtifactTarget;
  imageBlocks: ContentBlock[];
  maxBytes: number;
  maxLines: number;
}

export function truncatedOutput({
  text,
  stats,
  target,
  imageBlocks,
  maxBytes,
  maxLines,
}: TruncatedOutputInput): { content: ContentBlock[]; outputGuard: McpOutputGuardDetails } {
  const notice = formatTruncationNotice(stats, target);
  const previewBudget = reserveBudget(maxBytes, maxLines, notice);
  // Preserve a partial final line within the byte budget; Pi then enforces the line budget.
  const byteHead = new StringDecoder("utf8").write(
    Buffer.from(text, "utf8").subarray(0, previewBudget.maxBytes),
  );
  const head = truncateHead(byteHead, previewBudget).content;
  const finalText = head === "" ? notice : `${head}\n\n${notice}`;
  const finalStats = textStats(finalText);
  return {
    content: [{ type: "text" as const, text: finalText }, ...imageBlocks],
    outputGuard: {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      ...targetDetails(target),
    },
  };
}

function targetDetails(
  target: TruncatedArtifactTarget,
): Pick<McpOutputGuardDetails, "fullOutputPath" | "writeError"> {
  if (target.kind === "retained") {
    return target.ref === undefined && target.error !== undefined
      ? { writeError: target.error }
      : {};
  }
  return {
    ...(target.path !== undefined ? { fullOutputPath: target.path } : {}),
    ...(target.error !== undefined ? { writeError: target.error } : {}),
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
  target: TruncatedArtifactTarget,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (target.kind === "retained") {
    if (target.ref !== undefined && target.ref !== "") {
      return `${base} Full result saved: ${JSON.stringify(target.ref)}. Inspect without repeating the call using mcp action "read-result" with this ref (optional path, offset, limit).]`;
    }
    return `${base} Full result could not be saved: ${target.error ?? "unknown error"}]`;
  }
  if (target.path !== undefined && target.path !== "") {
    return `${base} Full text saved to: ${target.path} — use read with offset/limit or grep to inspect.]`;
  }
  return `${base} Full output could not be saved: ${target.error ?? "unknown error"}]`;
}

export function textStats(text: string): { bytes: number; lines: number } {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
