import type { ContentBlock } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

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

export type RetainedMcpResult = Pick<
  GuardedMcpOutput,
  "mcpResult" | "resultRef" | "resultWriteError" | "payloadFiles"
>;
