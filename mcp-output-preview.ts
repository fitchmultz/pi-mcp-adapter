import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  GuardedMcpOutput,
  McpOutputGuardDetails,
  McpOutputGuardOptions,
} from "./mcp-output-contracts.ts";
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
type OutputSpoolOptions = Pick<McpOutputGuardOptions, "enabled" | "outputDirectory"> &
  Required<Pick<McpOutputGuardOptions, "maxBytes" | "maxLines">>;

interface McpOutputSpool {
  readonly empty: boolean;
  push: (block: ContentBlock) => void;
  finish: () => GuardedMcpOutput;
}

export function createMcpOutputSpool(options: OutputSpoolOptions): McpOutputSpool {
  const spool = new OutputSpoolState(options);
  return {
    get empty() {
      return spool.empty;
    },
    push: spool.push,
    finish: spool.finish,
  };
}

class OutputSpoolState {
  private readonly options: OutputSpoolOptions;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private retained: ContentBlock[] | undefined = [];
  private readonly images: ContentBlock[] = [];
  private pushed = 0;
  private textBlocks = 0;
  private bytes = 0;
  private newlines = 0;
  private written = 0;
  private head = "";
  private headBytes = 0;
  private artifact: { path?: string; error?: string } = {};
  private fd: number | undefined;
  private pending: string[] = [];
  private pendingLength = 0;

  constructor(options: OutputSpoolOptions) {
    this.options = options;
    this.maxBytes = options.maxBytes;
    this.maxLines = options.maxLines;
  }

  get empty(): boolean {
    return this.pushed === 0;
  }

  private get lines(): number {
    return this.bytes === 0 ? 0 : this.newlines + 1;
  }

  private fail(error: unknown): void {
    this.artifact = { error: error instanceof Error ? error.message : String(error) };
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* the write error is the reported failure */
      }
    }
    this.fd = undefined;
  }

  private flush(): void {
    if (this.fd !== undefined && this.pending.length > 0) {
      try {
        writeFileSync(
          this.fd,
          this.pending.length === 1 ? (this.pending[0] ?? "") : this.pending.join(""),
        );
      } catch (error) {
        this.fail(error);
      }
    }
    this.pending = [];
    this.pendingLength = 0;
  }

  private append(piece: string): void {
    const maxBytes = this.maxBytes;
    if (this.headBytes <= maxBytes) {
      // Each UTF-16 unit is at least one UTF-8 byte, so the head exceeds every preview budget.
      let end = Math.min(piece.length, maxBytes + 1 - this.headBytes);
      const last = piece.charCodeAt(end - 1);
      if (end < piece.length && last >= 0xd800 && last <= 0xdbff) {
        end++;
      }
      const part = piece.slice(0, end);
      this.head += part;
      this.headBytes += byteLength(part);
    }
    if (this.fd === undefined) {
      return;
    }
    if (this.pendingLength + piece.length > SPOOL_WRITE_CHUNK) {
      this.flush();
    }
    this.pending.push(piece);
    this.pendingLength += piece.length;
  }

  private appendText(text: string): void {
    if (this.written++ > 0) {
      this.append("\n");
    }
    this.append(text);
  }

  private spill(blocks: ContentBlock[]): void {
    try {
      const parent =
        this.options.outputDirectory === undefined
          ? tmpdir()
          : resolve(this.options.outputDirectory);
      if (this.options.outputDirectory !== undefined) {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
      }
      const path = join(
        mkdtempSync(join(parent, "pi-mcp-output-")),
        `output-${randomBytes(4).toString("hex")}.txt`,
      );
      this.fd = openSync(path, "wx", 0o600);
      this.artifact = { path };
    } catch (error) {
      this.fail(error);
    }
    for (const block of blocks) {
      if (block.type === "image") {
        this.images.push(block);
      } else {
        this.appendText(block.text);
      }
    }
  }

  readonly push = (block: ContentBlock): void => {
    this.pushed++;
    if (block.type === "image") {
      (this.retained ?? this.images).push(...sanitizeContent([block]));
      return;
    }
    const separator = this.textBlocks++ > 0 ? 1 : 0;
    this.bytes += separator + byteLength(block.text);
    this.newlines += separator + countNewlines(block.text);
    if (this.retained === undefined) {
      this.appendText(block.text);
      return;
    }
    this.retained.push(block);
    if (
      this.options.enabled !== false &&
      (this.bytes > this.maxBytes || this.lines > this.maxLines)
    ) {
      const blocks = this.retained;
      this.retained = undefined;
      this.spill(blocks);
    }
  };

  readonly finish = (): GuardedMcpOutput => {
    if (this.retained !== undefined) {
      return { content: this.retained };
    }
    this.flush();
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch (error) {
        this.artifact = { error: error instanceof Error ? error.message : String(error) };
      }
      this.fd = undefined;
    }
    return truncatedOutput({
      text: this.head,
      stats: { bytes: this.bytes, lines: this.lines },
      artifact: this.artifact,
      imageBlocks: this.images,
      maxBytes: this.maxBytes,
      maxLines: this.maxLines,
    });
  };
}

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

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
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
