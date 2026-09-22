import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = Record<string, unknown>;

export interface McpOutputGuardDetails {
  truncated: true;
  originalBytes: number;
  returnedBytes: number;
  originalLines: number;
  returnedLines: number;
  /** Number of image content blocks returned untouched alongside the truncated text. */
  imageBlocksPassedThrough?: number;
  fullOutputPath?: string;
  writeError?: string;
}

export interface McpResultSummary {
  omitted: true;
  reason: string;
  isError: boolean;
  contentBlocks: number;
  contentSummary: Array<Record<string, unknown>>;
  structuredContentSummary?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  extraFields?: Array<Record<string, unknown>>;
  rawResultBytes: number;
  fullResultPath?: string;
  resultWriteError?: string;
}

export interface McpOutputGuardOptions {
  enabled?: boolean;
  outputDirectory?: string;
  prefix?: string;
  suffix?: string;
  emptyTextFallback?: string;
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
  /**
   * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
   * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
   * with a compact summary and spilled to a file. Payloads that are not fully
   * visible as plain text also get a model-visible reference for local readback.
   */
  rawMcpResult?: unknown;
  retainedMcpResult?: RetainedMcpResult;
}

export interface GuardedMcpOutput {
  content: ContentBlock[];
  outputGuard?: McpOutputGuardDetails;
  mcpResult?: unknown;
  resultRef?: string;
  resultWriteError?: string;
  payloadFiles?: McpPayloadFile[];
}

export interface McpPayloadFile {
  index: number;
  kind: "audio" | "resource";
  uri?: string;
  mimeType?: string;
  path?: string;
  error?: string;
}
export type RetainedMcpResult = Pick<GuardedMcpOutput, "mcpResult" | "resultRef" | "resultWriteError" | "payloadFiles">;

export function resolveMcpOutputGuardOptions(settings?: McpSettings, outputDirectory?: string): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes" | "outputDirectory"> {
  const configured = settings?.outputGuard;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    ...(outputDirectory !== undefined ? { outputDirectory } : {}),
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** Spread helper for tool-result details: includes mcpResult/outputGuard only when present. */
export function guardedMcpDetails(guarded: GuardedMcpOutput): Record<string, unknown> {
  return {
    ...(guarded.mcpResult !== undefined ? { mcpResult: guarded.mcpResult } : {}),
    ...(guarded.outputGuard ? { outputGuard: guarded.outputGuard } : {}),
    ...(guarded.resultRef ? { resultRef: guarded.resultRef } : {}),
    ...(guarded.resultWriteError ? { resultWriteError: guarded.resultWriteError } : {}),
    ...(guarded.payloadFiles?.length ? { payloadFiles: guarded.payloadFiles } : {}),
  };
}

/**
 * Bound model-facing MCP output. Text output is capped at maxBytes/maxLines and
 * spilled to a temp file when oversized. Image blocks pass through untouched —
 * they are delivered to the provider as native image content, not text context.
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  const retained = options.retainedMcpResult ?? (options.rawMcpResult === undefined ? {} : await retainMcpResult(options.rawMcpResult, options));
  const reference = retained.resultRef ? formatMcpResultReference(retained.resultRef)
    : retained.resultWriteError ? `[MCP result could not be saved: ${retained.resultWriteError}]` : undefined;
  const withReference = (blocks: ContentBlock[]) => reference ? [...blocks, { type: "text" as const, text: reference }] : blocks;
  if (options.enabled === false) return { content: withReference(addAffixes(normalizedContent, prefix, suffix)), ...retained };

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (stats.bytes > maxBytes || stats.lines > maxLines) {
    const { path: fullOutputPath, error: writeError } = await saveArtifact("output", composedOutput, options.outputDirectory);
    const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, notice);
    const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
    const finalText = `${preview.content}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    outputGuard = {
      truncated: true,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
      ...(writeError !== undefined ? { writeError } : {}),
    };
  }

  return {
    content: withReference(guardedContent),
    ...(outputGuard ? { outputGuard } : {}),
    ...retained,
  };
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim().slice(0, 100)
      : "image/png";
    return { ...block, mimeType };
  });
}

function withEmptyTextFallback(content: ContentBlock[], fallback: string | undefined): ContentBlock[] {
  if (!fallback) return content;
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  if (textOutput) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (block?.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]?.type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (block?.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
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

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a temp file.
 */
export async function retainMcpResult(result: unknown, options: McpOutputGuardOptions = {}, rawResult = false): Promise<RetainedMcpResult> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content
    : Array.isArray(record?.contents) ? record.contents.map(resource => ({ type: "resource", resource })) : [];
  const payloadFiles = (await Promise.all(content.map(async (block, index): Promise<McpPayloadFile | undefined> => {
    const item = asRecord(block);
    const resource = asRecord(item?.resource);
    const data = item?.type === "audio" ? item.data : item?.type === "resource" ? resource?.blob : undefined;
    if (typeof data !== "string") return undefined;
    const mimeType = item?.mimeType ?? resource?.mimeType;
    return { index, kind: item!.type as "audio" | "resource", ...(typeof resource?.uri === "string" ? { uri: resource.uri } : {}), ...(typeof mimeType === "string" ? { mimeType } : {}), ...await saveMcpPayload(data, options.outputDirectory) };
  }))).filter((file): file is McpPayloadFile => file !== undefined);
  const oversized = options.enabled !== false && rawBytes > (options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES);
  const shouldSave = oversized || !record || Object.keys(record).some(key => key !== "content" && key !== "isError")
    || content.some(block => {
      const item = asRecord(block);
      return item?.type !== "text" || Object.keys(item).some(key => key !== "type" && key !== "text");
    });
  if (!shouldSave) return { mcpResult: result };
  const artifact = await saveArtifact("mcp-result", raw, options.outputDirectory);
  return {
    mcpResult: oversized && !rawResult ? summarizeMcpResult(result, rawBytes, artifact) : result,
    ...(artifact.path ? { resultRef: artifact.path } : {}),
    ...(artifact.error ? { resultWriteError: artifact.error } : {}),
    ...(payloadFiles.length ? { payloadFiles } : {}),
  };
}

export function formatMcpPayloadFile(file: McpPayloadFile): string {
  return `[MCP ${file.kind === "audio" ? "audio" : "binary resource"}${file.uri ? ` (${file.uri})` : ""}: ${file.mimeType ?? "unknown MIME type"}; not rendered. ${file.path ? `Saved file: ${file.path}` : `Could not save: ${file.error}`}]`;
}

export function formatMcpResultReference(ref: string): string {
  return `[MCP result saved: ${ref}. Inspect without repeating the call: mcp({ action: "read-result", ref: ${JSON.stringify(ref)}, path: "/structuredContent" }) or await tools.readResult({ ref: ${JSON.stringify(ref)}, path: "/structuredContent" }). Omit path to read the whole result.]`;
}

function summarizeMcpResult(result: unknown, rawBytes: number, artifact: { path?: string; error?: string }): McpResultSummary {
  const { path: fullResultPath, error: resultWriteError } = artifact;
  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason: "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record?.isError === true,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    ...(fullResultPath !== undefined ? { fullResultPath } : {}),
    ...(resultWriteError !== undefined ? { resultWriteError } : {}),
  };

  if (record && "structuredContent" in record) {
    summary.structuredContentSummary = summarizeValue(record.structuredContent);
  }
  if (record && "_meta" in record) {
    summary.meta = summarizeValue(record._meta);
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = Object.keys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key) => ({ key: truncateKey(key), type: typeof record[key], estimatedBytes: estimateValueBytes(record[key]), omitted: true }));
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: unknown[]): Array<Record<string, unknown>> {
  const summaries: Array<Record<string, unknown>> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
    const record = asRecord(block);
    if (!record) return { type: typeof block, omitted: true };
    if (record.type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      return { type: "text", bytes: byteLength(text), lines: textStats(text).lines, textOmitted: true };
    }
    if (record.type === "image") {
      const data = typeof record.data === "string" ? record.data : "";
      return { type: "image", mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined, dataBytes: byteLength(data), dataOmitted: true };
    }
    return { type: typeof record.type === "string" ? record.type : "unknown", estimatedBytes: estimateValueBytes(record), omitted: true };
  });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return { type: value === null ? "null" : typeof value, estimatedBytes: estimateValueBytes(value), omitted: true };
  }
  const keys = Object.keys(record);
  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return byteLength(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return byteLength(String(value));
  const record = asRecord(value);
  if (!record || depth >= 2) return 0;
  const values = Array.isArray(value) ? value.slice(0, KEY_PREVIEW_LIMIT) : Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

async function saveMcpPayload(data: string, outputDirectory?: string): Promise<{ path?: string; error?: string }> {
  return saveArtifact("payload", Buffer.from(data, "base64"), outputDirectory);
}

async function saveArtifact(kind: string, text: string | Uint8Array, outputDirectory?: string): Promise<{ path?: string; error?: string }> {
  try {
    const parent = outputDirectory === undefined ? tmpdir() : resolve(outputDirectory);
    if (outputDirectory !== undefined) await mkdir(parent, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(parent, "pi-mcp-output-"));
    const path = join(dir, `${kind}-${randomBytes(4).toString("hex")}.${typeof text === "string" ? "txt" : "bin"}`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ReadMcpResultInput {
  ref: string;
  /** RFC 6901 JSON Pointer. Omit to read the entire retained result. */
  path?: string;
  fields?: string[];
  /** Zero-based character offset in the selected, pretty-printed value. */
  offset?: number;
  /** Maximum characters, additionally bounded by the configured output limits. */
  limit?: number;
}

export async function readMcpResult(input: ReadMcpResultInput, options: McpOutputGuardOptions = {}) {
  try {
    if (!input || typeof input.ref !== "string") throw new Error("ref must be a retained MCP result path");
    // Script-only hosts deliberately have no general filesystem capability.
    const root = await realpath(options.outputDirectory === undefined ? tmpdir() : resolve(options.outputDirectory));
    const ref = await realpath(resolve(input.ref));
    if (dirname(dirname(ref)) !== root || !/^pi-mcp-output-/.test(basename(dirname(ref)))
      || !/^(mcp-result|output)-[a-f0-9]+\.txt$/.test(basename(ref))) throw new Error("ref is not an MCP output artifact in this host's output directory");
    let rendered = await readFile(ref, "utf8");
    if (input.path !== undefined || input.fields !== undefined || basename(ref).startsWith("mcp-result-")) {
      let value: unknown = JSON.parse(rendered);
      if (input.path !== undefined && input.path !== "") {
        if (typeof input.path !== "string" || !input.path.startsWith("/") || /~(?:[^01]|$)/.test(input.path)) throw new Error("path must be an RFC 6901 JSON Pointer");
        for (const token of input.path.slice(1).split("/")) {
          const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
          if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`JSON Pointer does not exist: ${input.path}`);
          value = (value as Record<string, unknown>)[key];
        }
      }
      if (input.fields !== undefined) {
        if (!Array.isArray(input.fields) || input.fields.some(field => typeof field !== "string")) throw new Error("fields must be an array of keys");
        const select = (item: unknown) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("fields requires an object or array of objects");
          return Object.fromEntries(input.fields!.filter(key => Object.hasOwn(item, key)).map(key => [key, (item as Record<string, unknown>)[key]]));
        };
        value = Array.isArray(value) ? value.map(select) : select(value);
      }
      rendered = JSON.stringify(value, null, 2);
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 12_000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("offset must be a non-negative integer and limit a positive integer");
    const page = truncateHead(rendered.slice(offset, offset + limit), options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES, options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES).content;
    // A line limit can stop just before a newline; consume it so even a one-line page advances.
    if (!page && offset < rendered.length && rendered[offset] !== "\n") throw new Error("Output byte limit is too small for the next character");
    const end = offset + page.length;
    const consumed = end < rendered.length && rendered[end] === "\n" ? `${page}\n` : page;
    const nextOffset = offset + consumed.length < rendered.length ? offset + consumed.length : null;
    return { content: [{ type: "text" as const, text: consumed }, ...(nextOffset !== null ? [{ type: "text" as const, text: `[MCP result page: ${offset}–${offset + consumed.length} of ${rendered.length} characters. Continue with offset: ${nextOffset}.]` }] : [])], details: { ref, offset, nextOffset, totalCharacters: rendered.length, ...(input.path !== undefined ? { path: input.path } : {}) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], details: { error: "result_read_failed", message } };
  }
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function safeStringify(value: unknown): string {
  try {
    // The output guard measures and spills raw MCP results; it does not render this JSON for the model.
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textStats(text: string): { bytes: number; lines: number } {
  return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
