import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static, type TUnsafe } from "typebox";
import { toolErrorOverride } from "./error-signal.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

/**
 * MCP content blocks as one compact schema covering the fields codemode scripts inspect most,
 * matching Pi's built-in MCP CallToolResult schema.
 */
const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

/** JSON Schema keywords whose values are literal data rather than subschemas. */
const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
/** JSON Schema keywords whose entries map arbitrary names to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

function relocateEntry(key: string, value: unknown, pointer: string): unknown {
  if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
    return `${pointer}${value.slice(1)}`;
  }
  if (SCHEMA_DATA_KEYWORDS.has(key)) {
    return value;
  }
  if (SCHEMA_MAP_KEYWORDS.has(key)) {
    const map = asObjectRecord(value);
    if (map !== undefined && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(map).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
      );
    }
  }
  return relocateSchema(value, pointer);
}

/** Rewrite local JSON Pointer `$ref`s so an embedded server outputSchema stays valid. */
function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => relocateSchema(item, pointer));
  }
  const record = asObjectRecord(schema);
  if (record === undefined) {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, relocateEntry(key, value, pointer)]),
  );
}

/**
 * CallToolResult output schema for every direct and deferred MCP tool, matching Pi's built-in MCP
 * contract. Relocates local `$ref`s when the server declares an outputSchema.
 */
export function nativeMcpOutputSchema(
  structuredContentSchema?: Record<string, unknown>,
): TUnsafe<Record<string, unknown>> {
  return Type.Unsafe<Record<string, unknown>>({
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      structuredContent: structuredContentSchema
        ? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    additionalProperties: true,
  });
}

const scriptContentBlock = Type.Object(
  {
    type: Type.String(),
    text: Type.Optional(Type.String()),
    data: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const mcpScriptOutputSchema = Type.Object({
  mcpResult: Type.Optional(
    Type.Object(
      {
        content: Type.Optional(Type.Array(scriptContentBlock)),
        contents: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
        structuredContent: Type.Optional(Type.Unknown()),
        isError: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: true, description: "Inline provider result without protocol _meta." },
    ),
  ),
  mcpAdapter: Type.Object({
    omitted: Type.Boolean({ description: "No provider result is available inline." }),
    resultRef: Type.Optional(Type.String({ description: "Saved MCP protocol envelope." })),
    outputPath: Type.Optional(
      Type.String({ description: "Saved rendered text, not an MCP envelope." }),
    ),
    error: Type.Optional(Type.String()),
    message: Type.Optional(Type.String({ description: "Human-readable diagnostic." })),
  }),
  isError: Type.Optional(Type.Literal(true)),
});

export const mcpReadPageSchema = Type.Object({
  text: Type.String({ description: "Page text without the display notice." }),
  ref: Type.String(),
  path: Type.Optional(Type.String()),
  offset: Type.Integer(),
  nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  totalCharacters: Type.Integer(),
});
export type McpReadPage = Static<typeof mcpReadPageSchema>;

/** Untruncated raw MCP payloads held transiently in memory so `details` stays bounded for JSONL. */
const rawMcpResults = new WeakMap<object, Record<string, unknown>>();

export function attachRawMcpResult<T extends AgentToolResult<Record<string, unknown>>>(
  result: T,
  raw: Record<string, unknown>,
): T {
  rawMcpResults.set(result, raw);
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  const record = asObjectRecord(value);
  return record !== undefined && Object.values(record).every(isJsonValue);
}

/** Narrow already-JSON MCP payloads to JsonValue without pulling Zod into cold startup or stripping own __proto__ keys. */
function asJsonValue(value: unknown): JsonValue | undefined {
  if (isJsonValue(value)) {
    return value;
  }
  try {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== "string") {
      return undefined;
    }
    const parsed: unknown = JSON.parse(serialized);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function receiptFields(details: Record<string, unknown>) {
  return {
    ...(typeof details.resultRef === "string" ? { resultRef: details.resultRef } : {}),
    ...(typeof details.error === "string" ? { error: details.error } : {}),
  };
}

function withoutBlockMetadata(value: unknown): unknown {
  const raw = asObjectRecord(value);
  if (raw === undefined) {
    return value;
  }
  const { _meta: _private, ...block } = raw;
  const resource = asObjectRecord(block.resource);
  if (block.type === "resource" && resource !== undefined) {
    const { _meta: _resourceMetadata, ...contents } = resource;
    return { ...block, resource: contents };
  }
  return block;
}

function toScriptCallToolResult(value: unknown): JsonValue | undefined {
  const raw = asObjectRecord(value);
  // The guard's compact summary has neither content nor structuredContent.
  if (raw === undefined || (!Array.isArray(raw.content) && raw.structuredContent === undefined)) {
    return undefined;
  }
  const { _meta: _private, ...payload } = raw;
  payload.content = isUnknownArray(payload.content)
    ? payload.content.map(withoutBlockMetadata)
    : [];
  return asJsonValue(payload);
}

function inlinePayload(value: unknown): JsonValue | undefined {
  const raw = asObjectRecord(value);
  // The guard's compact summary has neither of the MCP tool/resource result block arrays.
  if (
    raw === undefined ||
    !(
      Array.isArray(raw.content) ||
      Array.isArray(raw.contents) ||
      raw.structuredContent !== undefined
    )
  ) {
    return undefined;
  }
  const { _meta: _private, ...payload } = raw;
  if (isUnknownArray(payload.content)) {
    payload.content = payload.content.map(withoutBlockMetadata);
  }
  if (isUnknownArray(payload.contents)) {
    payload.contents = payload.contents.map(withoutBlockMetadata);
  }
  return asJsonValue(payload);
}

function buildAdapterReceipt(
  result: AgentToolResult<Record<string, unknown>>,
  payload: JsonValue | undefined,
): Record<string, JsonValue> {
  const { details } = result;
  const receipt = receiptFields(details);
  const outputPath = asObjectRecord(details.outputGuard)?.fullOutputPath;
  const diagnostic = result.content[0];
  const message =
    payload === undefined && receipt.error !== undefined && diagnostic?.type === "text"
      ? diagnostic.text
      : undefined;
  return {
    omitted: payload === undefined,
    ...receipt,
    ...(typeof outputPath === "string" ? { outputPath } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export function withMcpScriptOutput(
  result: AgentToolResult<Record<string, unknown>>,
): AgentToolResult<Record<string, unknown>> {
  const payload = inlinePayload(rawMcpResults.get(result) ?? result.details.mcpResult);
  const isError = result.isError === true || toolErrorOverride(result.details) !== undefined;
  return {
    ...result,
    structuredContent: {
      ...(payload !== undefined ? { mcpResult: payload } : {}),
      mcpAdapter: buildAdapterReceipt(result, payload),
      ...(isError ? { isError: true } : {}),
    },
  };
}

export function nativeMcpResult(
  result: AgentToolResult<Record<string, unknown>>,
  detailsOverride?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  const details = detailsOverride ?? result.details;
  const payload = toScriptCallToolResult(rawMcpResults.get(result) ?? details.mcpResult);
  if (payload !== undefined) {
    return {
      ...result,
      details,
      ...toolErrorOverride(details),
      structuredContent: payload,
    };
  }
  return {
    ...result,
    details,
    isError: true,
  };
}
