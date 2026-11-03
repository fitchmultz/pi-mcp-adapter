// mcp-output-summary.ts - Compact summaries that replace oversized raw MCP results.
import { byteLength, textStats } from "./mcp-output-preview.ts";
import type { McpResultSummary } from "./mcp-output-contracts.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = Record<string, unknown>;

export function summarizeMcpResult(
  result: unknown,
  rawBytes: number,
  artifact: { path?: string; error?: string },
): McpResultSummary {
  const { path: fullResultPath, error: resultWriteError } = artifact;
  const record = asObjectRecord(result);
  const content = isUnknownArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason:
      "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record?.isError === true,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    ...(fullResultPath !== undefined ? { fullResultPath } : {}),
    ...(resultWriteError !== undefined ? { resultWriteError } : {}),
  };

  if (!record) {
    return summary;
  }
  return { ...summary, ...summarizeRecordExtras(record) };
}

/** Summarize optional structuredContent/_meta/extra fields. */
function summarizeRecordExtras(
  record: Recordish,
): Pick<McpResultSummary, "structuredContentSummary" | "meta" | "extraFields"> {
  const structuredContentSummary =
    "structuredContent" in record ? summarizeValue(record.structuredContent) : undefined;
  const meta = "_meta" in record ? summarizeValue(record._meta) : undefined;
  const extraFields = summarizeExtraFields(record);
  return {
    ...(structuredContentSummary !== undefined ? { structuredContentSummary } : {}),
    ...(meta !== undefined ? { meta } : {}),
    ...(extraFields.length > 0 ? { extraFields } : {}),
  };
}

/** Non-standard top-level keys, previewed compactly. */
function summarizeExtraFields(record: Recordish): Array<Record<string, unknown>> {
  const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
  return Object.keys(record)
    .filter((key) => !standard.has(key))
    .slice(0, KEY_PREVIEW_LIMIT)
    .map((key) => ({
      key: truncateKey(key),
      type: typeof record[key],
      estimatedBytes: estimateValueBytes(record[key]),
      omitted: true,
    }));
}

function summarizeContent(content: unknown[]): Array<Record<string, unknown>> {
  const summaries: Array<Record<string, unknown>> = content
    .slice(0, CONTENT_SUMMARY_LIMIT)
    .map((block) => {
      const record = asObjectRecord(block);
      if (!record) {
        return { type: typeof block, omitted: true };
      }
      if (record.type === "text") {
        const text = typeof record.text === "string" ? record.text : "";
        return {
          type: "text",
          bytes: byteLength(text),
          lines: textStats(text).lines,
          textOmitted: true,
        };
      }
      if (record.type === "image") {
        const data = typeof record.data === "string" ? record.data : "";
        return {
          type: "image",
          mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
          dataBytes: byteLength(data),
          dataOmitted: true,
        };
      }
      return {
        type: typeof record.type === "string" ? record.type : "unknown",
        estimatedBytes: estimateValueBytes(record),
        omitted: true,
      };
    });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asObjectRecord(value);
  if (!record) {
    return {
      type: value === null ? "null" : typeof value,
      estimatedBytes: estimateValueBytes(value),
      omitted: true,
    };
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

/** Byte size of a primitive leaf, or undefined when value is composite. */
function primitiveValueBytes(value: unknown): number | undefined {
  if (typeof value === "string") {
    return byteLength(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return byteLength(String(value));
  }
  return undefined;
}

function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const primitiveBytes = primitiveValueBytes(value);
  if (primitiveBytes !== undefined) {
    return primitiveBytes;
  }
  const record = asObjectRecord(value);
  if (!record || depth >= 2) {
    return 0;
  }
  const values = isUnknownArray(value)
    ? value.slice(0, KEY_PREVIEW_LIMIT)
    : Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce(
    (total: number, item: unknown) => total + estimateValueBytes(item, depth + 1),
    0,
  );
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}
