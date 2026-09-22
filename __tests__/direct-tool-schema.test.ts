import { describe, expect, it } from "vitest";
import { normalizeDirectToolInputSchema } from "../utils.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import { resolvePinnedTools } from "./fixtures/pinned-tools.ts";

describe("normalizeDirectToolInputSchema", () => {
  it("preserves the original schema constraints without mutating the descriptor", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string" },
        options: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    };

    expect(normalizeDirectToolInputSchema(schema)).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        options: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
    });
  });

  it("uses an empty object schema when the MCP tool omits inputSchema", () => {
    expect(normalizeDirectToolInputSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("does not reuse ambient cache metadata for a different programmatic server identity", () => {
    const ambientDefinition = { url: "https://ambient.example.com/mcp" };
    const programmaticDefinition = { url: "https://programmatic.example.com/mcp", directTools: true as const };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        shared: {
          configHash: computeServerHash(ambientDefinition),
          tools: [{ name: "ambient_tool", inputSchema: { type: "object" } }],
          resources: [],
          cachedAt: Date.now(),
        },
      },
    };

    expect(resolvePinnedTools({ mcpServers: { shared: programmaticDefinition } }, cache, "server")).toEqual([]);
  });
});
