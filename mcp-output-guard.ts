import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { byteLength, sanitizeContent, textStats, truncatedOutput } from "./mcp-output-preview.ts";
import type { ContentBlock, McpSettings } from "./types.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

type Recordish = Record<string, unknown>;

import {
  DEFAULT_MCP_DETAILS_MAX_BYTES,
  DEFAULT_MCP_OUTPUT_MAX_BYTES,
  DEFAULT_MCP_OUTPUT_MAX_LINES,
  type McpOutputGuardDetails,
  type McpResultSummary,
  type McpOutputGuardOptions,
  type GuardedMcpOutput,
  type McpPayloadFile,
  type RetainedMcpResult,
} from "./mcp-output-contracts.ts";
import { summarizeMcpResult } from "./mcp-output-summary.ts";

export type {
  McpOutputGuardDetails,
  McpResultSummary,
  McpOutputGuardOptions,
  GuardedMcpOutput,
  McpPayloadFile,
  RetainedMcpResult,
};

export function resolveMcpOutputGuardOptions(
  settings?: McpSettings,
  outputDirectory?: string,
): Pick<McpOutputGuardOptions, "enabled" | "detailsMaxBytes" | "outputDirectory"> &
  Required<Pick<McpOutputGuardOptions, "maxBytes" | "maxLines">> {
  const configured = settings?.outputGuard;
  const tuning = typeof configured === "object" ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    ...(outputDirectory !== undefined ? { outputDirectory } : {}),
    ...outputGuardLimits(tuning),
  };
}

/** Fall back to the documented defaults for every unset guard limit. */
function outputGuardLimits(
  tuning: { maxBytes?: unknown; maxLines?: unknown; detailsMaxBytes?: unknown } | undefined,
): Required<Pick<McpOutputGuardOptions, "maxBytes" | "maxLines" | "detailsMaxBytes">> {
  return {
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
    ...(guarded.resultRef !== undefined && guarded.resultRef !== ""
      ? { resultRef: guarded.resultRef }
      : {}),
    ...(guarded.resultWriteError !== undefined && guarded.resultWriteError !== ""
      ? { resultWriteError: guarded.resultWriteError }
      : {}),
    ...(guarded.payloadFiles !== undefined && guarded.payloadFiles.length > 0
      ? { payloadFiles: guarded.payloadFiles }
      : {}),
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
  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  const retained = await resolveRetainedResult(options);
  const reference = referenceForRetained(retained);
  const withReference = (blocks: ContentBlock[]) =>
    reference !== undefined && reference !== ""
      ? [...blocks, { type: "text" as const, text: reference }]
      : blocks;
  const affixes = { prefix: options.prefix ?? "", suffix: options.suffix ?? "" };
  if (options.enabled === false) {
    return {
      content: withReference(addAffixes(normalizedContent, affixes.prefix, affixes.suffix)),
      ...retained,
    };
  }

  const { content: guardedContent, outputGuard } = await boundedTextOutput(normalizedContent, {
    ...affixes,
    reference,
    maxBytes: options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    outputDirectory: options.outputDirectory,
  });

  return {
    content: withReference(guardedContent),
    ...(outputGuard ? { outputGuard } : {}),
    ...retained,
  };
}

/** Use the caller-provided retention or retain the raw result through the details guard. */
async function resolveRetainedResult(options: McpOutputGuardOptions): Promise<RetainedMcpResult> {
  return (
    options.retainedMcpResult ??
    (options.rawMcpResult === undefined ? {} : await retainMcpResult(options.rawMcpResult, options))
  );
}

function referenceForRetained(retained: RetainedMcpResult): string | undefined {
  if (retained.resultRef !== undefined && retained.resultRef !== "") {
    return formatMcpResultReference(retained.resultRef);
  }
  if (retained.resultWriteError !== undefined && retained.resultWriteError !== "") {
    return `[MCP result could not be saved: ${retained.resultWriteError}]`;
  }
  return undefined;
}

interface BoundedOutputContext {
  prefix: string;
  suffix: string;
  reference: string | undefined;
  maxBytes: number;
  maxLines: number;
  outputDirectory: string | undefined;
}

/** Cap the composed text output, spilling to an artifact when oversized. */
async function boundedTextOutput(
  normalizedContent: ContentBlock[],
  ctx: BoundedOutputContext,
): Promise<{ content: ContentBlock[]; outputGuard: McpOutputGuardDetails | undefined }> {
  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const composedOutput = `${ctx.prefix}${textOutput}${ctx.suffix}`;
  const stats = textStats(composedOutput);
  const referenceSuffix =
    ctx.reference !== undefined && ctx.reference !== "" ? `\n${ctx.reference}` : "";
  const totalStats = textStats(
    composedOutput !== "" ? composedOutput + referenceSuffix : (ctx.reference ?? ""),
  );

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, ctx.prefix, ctx.suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  if (totalStats.bytes > ctx.maxBytes || totalStats.lines > ctx.maxLines) {
    const artifact = await saveArtifact("output", composedOutput, ctx.outputDirectory);
    ({ content: guardedContent, outputGuard } = truncatedOutput({
      text: composedOutput,
      stats,
      artifact,
      imageBlocks,
      maxBytes: ctx.maxBytes,
      maxLines: ctx.maxLines,
      referenceSuffix,
    }));
  }

  return { content: guardedContent, outputGuard };
}

function withEmptyTextFallback(
  content: ContentBlock[],
  fallback: string | undefined,
): ContentBlock[] {
  if (fallback === undefined || fallback === "") {
    return content;
  }
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (textOutput !== "") {
    return content;
  }
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (prefix === "" && suffix === "") {
    return content;
  }
  const blocks = [...content];
  if (prefix !== "") {
    const index = blocks.findIndex((block) => block.type === "text");
    const block = blocks[index];
    if (block?.type === "text") {
      blocks[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      blocks.unshift({ type: "text", text: prefix });
    }
  }
  if (suffix !== "") {
    const index = blocks.findLastIndex((block: ContentBlock | undefined) => block?.type === "text");
    const block = blocks[index];
    if (block?.type === "text") {
      blocks[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      blocks.push({ type: "text", text: suffix });
    }
  }
  return blocks;
}

/** Content blocks from a raw result's content/contents members. */
function resultContent(record: Recordish | undefined): unknown[] {
  if (isUnknownArray(record?.content)) {
    return record.content;
  }
  if (isUnknownArray(record?.contents)) {
    return record.contents.map((resource) => ({ type: "resource", resource }));
  }
  return [];
}

/** Inline data of an audio/resource block, when present as base64 text. */
function payloadData(item: Recordish | undefined, resource: Recordish | undefined): unknown {
  if (item?.type === "audio") {
    return item.data;
  }
  if (item?.type === "resource") {
    return resource?.blob;
  }
  return undefined;
}

function payloadKind(
  item: Recordish | undefined,
  resource: Recordish | undefined,
): "audio" | "resource" {
  return (item?.type ?? resource?.type) === "audio" ? "audio" : "resource";
}

function payloadFileFields(
  resource: Recordish | undefined,
  mimeType: unknown,
): { uri?: string; mimeType?: string } {
  return {
    ...(typeof resource?.uri === "string" ? { uri: resource.uri } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
  };
}

/** Spill one audio/resource payload block to a file, or skip it. */
async function payloadFileFor(
  block: unknown,
  index: number,
  options: McpOutputGuardOptions,
): Promise<McpPayloadFile | undefined> {
  const item = asObjectRecord(block);
  const resource = asObjectRecord(item?.resource);
  const data = payloadData(item, resource);
  if (typeof data !== "string") {
    return undefined;
  }
  const mimeType = item?.mimeType ?? resource?.mimeType;
  return {
    index,
    kind: payloadKind(item, resource),
    ...payloadFileFields(resource, mimeType),
    ...(await saveArtifact("payload", Buffer.from(data, "base64"), options.outputDirectory)),
  };
}

/** True when the raw result must be spilled: oversized, or not a plain text result. */
function retentionRequired(
  record: Recordish | undefined,
  content: unknown[],
  oversized: boolean,
): boolean {
  if (oversized || !record) {
    return true;
  }
  if (Object.keys(record).some((key) => key !== "content" && key !== "isError")) {
    return true;
  }
  return content.some((block) => {
    const item = asObjectRecord(block);
    return (
      item?.type !== "text" || Object.keys(item).some((key) => key !== "type" && key !== "text")
    );
  });
}

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a temp file.
 */
export async function retainMcpResult(
  result: unknown,
  options: McpOutputGuardOptions = {},
): Promise<RetainedMcpResult> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  const record = asObjectRecord(result);
  const content = resultContent(record);
  const oversized =
    options.enabled !== false &&
    rawBytes > (options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES);
  if (!retentionRequired(record, content, oversized)) {
    return { mcpResult: result };
  }
  const [rawPayloadFiles, artifact] = await Promise.all([
    Promise.all(content.map((block, index) => payloadFileFor(block, index, options))),
    saveArtifact("mcp-result", raw, options.outputDirectory),
  ]);
  const payloadFiles = rawPayloadFiles.filter((file): file is McpPayloadFile => file !== undefined);
  return retainedResultEnvelope({
    result,
    rawBytes,
    artifact,
    payloadFiles,
    summarize: oversized,
  });
}

function retainedResultEnvelope(ctx: {
  result: unknown;
  rawBytes: number;
  artifact: { path?: string; error?: string };
  payloadFiles: McpPayloadFile[];
  summarize: boolean;
}): RetainedMcpResult {
  return {
    mcpResult: ctx.summarize
      ? summarizeMcpResult(ctx.result, ctx.rawBytes, ctx.artifact)
      : ctx.result,
    ...(ctx.artifact.path !== undefined && ctx.artifact.path !== ""
      ? { resultRef: ctx.artifact.path }
      : {}),
    ...(ctx.artifact.error !== undefined && ctx.artifact.error !== ""
      ? { resultWriteError: ctx.artifact.error }
      : {}),
    ...(ctx.payloadFiles.length > 0 ? { payloadFiles: ctx.payloadFiles } : {}),
  };
}

export function formatMcpPayloadFile(file: McpPayloadFile): string {
  return `[MCP ${file.kind === "audio" ? "audio" : "binary resource"}${file.uri !== undefined && file.uri !== "" ? ` (${file.uri})` : ""}: ${file.mimeType ?? "unknown MIME type"}; not rendered. ${file.path !== undefined && file.path !== "" ? `Saved file: ${file.path}` : `Could not save: ${String(file.error)}`}]`;
}

export function formatMcpResultReference(ref: string): string {
  return `[MCP result saved: ${JSON.stringify(ref)}. Inspect without repeating the call using mcp action "read-result" with this ref. Optionally select a JSON Pointer with path.]`;
}

async function saveArtifact(
  kind: string,
  text: string | Uint8Array,
  outputDirectory?: string,
): Promise<{ path?: string; error?: string }> {
  try {
    const parent = outputDirectory === undefined ? tmpdir() : resolve(outputDirectory);
    if (outputDirectory !== undefined) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    }
    const dir = await mkdtemp(join(parent, "pi-mcp-output-"));
    const path = join(
      dir,
      `${kind}-${randomBytes(4).toString("hex")}.${typeof text === "string" ? "txt" : "bin"}`,
    );
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Stream histories through the same private output-artifact and paged-reader boundary. */
export async function saveMcpOutputStream(
  chunks: AsyncIterable<string>,
  outputDirectory?: string,
): Promise<{ path?: string; error?: string }> {
  const artifact = await saveArtifact("output", "", outputDirectory);
  if (artifact.path === undefined || artifact.path === "") {
    return artifact;
  }
  try {
    const file = await open(artifact.path, "a");
    try {
      for await (const chunk of chunks) {
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    return artifact;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export { readMcpResult, type ReadMcpResultInput } from "./mcp-output-reader.ts";
export {
  DEFAULT_MCP_OUTPUT_MAX_BYTES,
  DEFAULT_MCP_OUTPUT_MAX_LINES,
  DEFAULT_MCP_DETAILS_MAX_BYTES,
} from "./mcp-output-contracts.ts";

function safeStringify(value: unknown): string {
  try {
    // The output guard measures and spills raw MCP results; it does not render this JSON for the model.
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  return undefined;
}
