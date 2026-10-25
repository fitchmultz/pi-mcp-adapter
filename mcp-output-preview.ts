import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GuardedMcpOutput, McpOutputGuardDetails, McpOutputGuardOptions } from "./mcp-output-guard.ts";
import type { ContentBlock } from "./types.ts";

// mcp-code.ts is imported on first use. A Pi process that loaded an older mcp-output-guard.ts
// before an update links the updated mcp-code.ts against it, so the spool cannot live there.

const SPOOL_WRITE_CHUNK = 1024 * 1024;

/**
 * Guard output that arrives one block at a time without retaining all of it. Blocks stay in
 * memory while they fit the model-visible limits. After that, the joined text is appended to
 * one private output artifact and only the preview head and image blocks are kept. Writes are
 * synchronous, so a producer may be released as soon as push() returns.
 */
export function createMcpOutputSpool(options: Pick<McpOutputGuardOptions, "enabled" | "outputDirectory"> & Required<Pick<McpOutputGuardOptions, "maxBytes" | "maxLines">>) {
  const { maxBytes, maxLines } = options;
  let retained: ContentBlock[] | undefined = [];
  const images: ContentBlock[] = [];
  let pushed = 0, textBlocks = 0, bytes = 0, newlines = 0, written = 0;
  let head = "", headBytes = 0;
  let artifact: { path?: string; error?: string } = {};
  let fd: number | undefined;
  let pending: string[] = [], pendingLength = 0;
  const lines = () => bytes === 0 ? 0 : newlines + 1;

  const fail = (error: unknown) => {
    artifact = { error: error instanceof Error ? error.message : String(error) };
    if (fd !== undefined) try { closeSync(fd); } catch { /* the write error is the reported failure */ }
    fd = undefined;
  };
  const flush = () => {
    if (fd !== undefined && pending.length > 0) {
      try { writeFileSync(fd, pending.length === 1 ? pending[0]! : pending.join("")); } catch (error) { fail(error); }
    }
    pending = [];
    pendingLength = 0;
  };
  const append = (piece: string) => {
    if (headBytes <= maxBytes) {
      // Each UTF-16 unit is at least one UTF-8 byte, so the head exceeds every preview budget.
      let end = Math.min(piece.length, maxBytes + 1 - headBytes);
      const last = piece.charCodeAt(end - 1);
      if (end < piece.length && last >= 0xd800 && last <= 0xdbff) end++;
      const part = piece.slice(0, end);
      head += part;
      headBytes += byteLength(part);
    }
    if (fd === undefined) return;
    if (pendingLength + piece.length > SPOOL_WRITE_CHUNK) flush();
    pending.push(piece);
    pendingLength += piece.length;
  };
  const appendText = (text: string) => {
    if (written++ > 0) append("\n");
    append(text);
  };
  const spill = (blocks: ContentBlock[]) => {
    try {
      const parent = options.outputDirectory === undefined ? tmpdir() : resolve(options.outputDirectory);
      if (options.outputDirectory !== undefined) mkdirSync(parent, { recursive: true, mode: 0o700 });
      const path = join(mkdtempSync(join(parent, "pi-mcp-output-")), `output-${randomBytes(4).toString("hex")}.txt`);
      fd = openSync(path, "wx", 0o600);
      artifact = { path };
    } catch (error) { fail(error); }
    for (const block of blocks) {
      if (block.type === "image") images.push(block);
      else appendText(block.text);
    }
  };

  return {
    get empty() { return pushed === 0; },
    push(block: ContentBlock): void {
      pushed++;
      if (block.type === "image") {
        (retained ?? images).push(...sanitizeContent([block]));
        return;
      }
      const separator = textBlocks++ > 0 ? 1 : 0;
      bytes += separator + byteLength(block.text);
      newlines += separator + countNewlines(block.text);
      if (!retained) appendText(block.text);
      else {
        retained.push(block);
        if (options.enabled !== false && (bytes > maxBytes || lines() > maxLines)) {
          const blocks = retained;
          retained = undefined;
          spill(blocks);
        }
      }
    },
    finish(): GuardedMcpOutput {
      if (retained) return { content: retained };
      flush();
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { artifact = { error: error instanceof Error ? error.message : String(error) }; }
        fd = undefined;
      }
      return truncatedOutput(head, { bytes, lines: lines() }, artifact, images, maxBytes, maxLines);
    },
  };
}

export function truncatedOutput(
  text: string,
  stats: { bytes: number; lines: number },
  { path: fullOutputPath, error: writeError }: { path?: string; error?: string },
  imageBlocks: ContentBlock[],
  maxBytes: number,
  maxLines: number,
  referenceSuffix = "",
): { content: ContentBlock[]; outputGuard: McpOutputGuardDetails } {
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

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

export function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim().slice(0, 100)
      : "image/png";
    return { ...block, mimeType };
  });
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string): { maxBytes: number; maxLines: number } {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
  };
}

function truncateHead(text: string, maxBytes: number, maxLines: number): { content: string; bytes: number; lines: number } {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    if (output.length >= maxLines) break;
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
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
  stats: { bytes: number; lines: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
  if (fullOutputPath) {
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
