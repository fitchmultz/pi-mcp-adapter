import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static, type TUnion, type TUnsafe } from "typebox";
import { Value } from "typebox/value";
import { toolErrorOverride } from "./error-signal.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

function outputReceipt() {
  return Type.Object(
    {
      mcpAdapter: Type.Object(
        {
          omitted: Type.Literal(true),
          resultRef: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

/** Keep the server's declared output and the existing fallback receipt for its consumers. */
export function nativeMcpOutputSchema(
  schema: Record<string, unknown>,
): TUnion<[TUnsafe, ReturnType<typeof outputReceipt>]> {
  return Type.Union([Type.Unsafe(schema), outputReceipt()]);
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

const jsonValueSchema = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Refine(Type.Unknown(), (value) => typeof value === "number"),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Json",
);
function isJsonValue(value: unknown): value is JsonValue {
  return Value.Check(jsonValueSchema, value);
}

function receiptFields(details: Record<string, unknown>) {
  return {
    ...(typeof details.resultRef === "string" ? { resultRef: details.resultRef } : {}),
    ...(typeof details.error === "string" ? { error: details.error } : {}),
  };
}

function declaredOutput(details: Record<string, unknown>): JsonValue {
  const raw = asObjectRecord(details.mcpResult);
  const guarded = Boolean(details.outputGuard);
  const failed = Boolean(details.error);
  if (
    !guarded &&
    (!failed || details.error === "tool_error") &&
    raw?.structuredContent !== undefined &&
    isJsonValue(raw.structuredContent)
  ) {
    return raw.structuredContent;
  }
  return { mcpAdapter: { omitted: true, ...receiptFields(details) } };
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

function inlinePayload(value: unknown): JsonValue | undefined {
  const raw = asObjectRecord(value);
  // The guard's compact summary has neither of the MCP tool/resource result block arrays.
  if (raw === undefined || !(Array.isArray(raw.content) || Array.isArray(raw.contents))) {
    return undefined;
  }
  const { _meta: _private, ...payload } = raw;
  if (isUnknownArray(payload.content)) {
    payload.content = payload.content.map(withoutBlockMetadata);
  }
  if (isUnknownArray(payload.contents)) {
    payload.contents = payload.contents.map(withoutBlockMetadata);
  }
  return isJsonValue(payload) ? payload : undefined;
}

export function withMcpScriptOutput(
  result: AgentToolResult<Record<string, unknown>>,
): AgentToolResult<Record<string, unknown>> {
  const { details } = result;
  const receipt = receiptFields(details);
  const payload = inlinePayload(details.mcpResult);
  const outputPath = asObjectRecord(details.outputGuard)?.fullOutputPath;
  const diagnostic = result.content[0];
  return {
    ...result,
    structuredContent: {
      ...(payload !== undefined ? { mcpResult: payload } : {}),
      mcpAdapter: {
        omitted: payload === undefined,
        ...receipt,
        ...(typeof outputPath === "string" ? { outputPath } : {}),
        ...(payload === undefined && receipt.error !== undefined && diagnostic?.type === "text"
          ? { message: diagnostic.text }
          : {}),
      },
      ...(result.isError === true || toolErrorOverride(details) !== undefined
        ? { isError: true }
        : {}),
    },
  };
}

export function nativeMcpResult(
  result: AgentToolResult<Record<string, unknown>>,
  hasDeclaredOutput = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    ...result,
    ...toolErrorOverride(result.details),
    ...(hasDeclaredOutput ? { structuredContent: declaredOutput(result.details) } : {}),
  };
}
