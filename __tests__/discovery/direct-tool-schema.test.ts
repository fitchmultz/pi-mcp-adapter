import { describe, expect, it } from "vitest";
import { normalizeDirectToolInputSchema } from "../../utils.ts";
import { computeServerHash, type MetadataCache } from "../../metadata-cache.ts";
import type { McpTool } from "../../types.ts";
import { resolvePinnedTools } from "../fixtures/pinned-tools.ts";

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
    const tool: McpTool = { name: "search" };
    expect(normalizeDirectToolInputSchema(tool.inputSchema)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("does not reuse ambient cache metadata for a different programmatic server identity", async () => {
    const ambientDefinition = { url: "https://ambient.example.com/mcp" };
    const programmaticDefinition = {
      url: "https://programmatic.example.com/mcp",
      directTools: true as const,
    };
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

    expect(
      await resolvePinnedTools({ mcpServers: { shared: programmaticDefinition } }, cache, "server"),
    ).toEqual([]);
  });
});
