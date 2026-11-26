import { describe, expect, it } from "vitest";
import { formatSchema } from "../tool-metadata.ts";

describe("formatSchema", () => {
  it("keeps simple object schemas compact", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term", default: "all" },
        limit: { type: ["number", "null"] },
        mode: { enum: ["fast", "safe"] },
      },
      required: ["query"],
    };

    expect(formatSchema(schema)).toBe(
      [
        '  query (string) *required* - Search term [default: "all"]',
        "  limit (number | null)",
        '  mode (enum: "fast", "safe")',
      ].join("\n"),
    );
  });

  it("expands union branches with const discriminator fields", () => {
    const schema = {
      type: "object",
      properties: {
        document: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: { const: "text" },
                content: { type: "string", minLength: 1 },
              },
              required: ["type", "content"],
            },
            {
              type: "object",
              properties: {
                type: { const: "file" },
                path: { type: "string", minLength: 1 },
              },
              required: ["type", "path"],
            },
          ],
        },
      },
      required: ["document"],
    };

    expect(formatSchema(schema)).toBe(
      [
        "  document *required*",
        "    anyOf:",
        "      - object",
        '        type (const "text") *required*',
        "        content (string) *required* [minLength: 1]",
        "      - object",
        '        type (const "file") *required*',
        "        path (string) *required* [minLength: 1]",
      ].join("\n"),
    );
  });

  it("formats oneOf branches", () => {
    const schema = {
      type: "object",
      properties: {
        target: {
          oneOf: [{ const: "draft" }, { const: "published" }],
        },
      },
    };

    expect(formatSchema(schema)).toBe(
      ["  target", "    oneOf:", '      - const "draft"', '      - const "published"'].join("\n"),
    );
  });

  it("formats nested object properties and array items", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            tags: {
              type: "array",
              items: { enum: ["alpha", "beta"] },
              minItems: 1,
            },
          },
          required: ["enabled"],
        },
      },
      required: ["config"],
    };

    expect(formatSchema(schema)).toBe(
      [
        "  config (object) *required*",
        "    enabled (boolean) *required*",
        "    tags (array) [minItems: 1]",
        '      items (enum: "alpha", "beta")',
      ].join("\n"),
    );
  });

  it("resolves local $ref into $defs and definitions and guards recursive cycles", () => {
    const schema = {
      type: "object",
      $defs: {
        Filter: {
          type: "object",
          properties: {
            field: { type: "string", description: "Column name" },
          },
          required: ["field"],
        },
        Node: {
          type: "object",
          properties: {
            id: { type: "string" },
            child: { $ref: "#/$defs/Node" },
          },
        },
      },
      definitions: {
        LegacyLimit: {
          type: "integer",
          minimum: 1,
        },
      },
      properties: {
        filter: { $ref: "#/$defs/Filter", description: "Primary filter" },
        limit: { $ref: "#/definitions/LegacyLimit" },
        tree: { $ref: "#/$defs/Node" },
      },
      required: ["filter"],
    };

    const formatted = formatSchema(schema);
    expect(formatted).toContain("  filter (object) *required* - Primary filter");
    expect(formatted).toContain("    field (string) *required* - Column name");
    expect(formatted).toContain("  limit (integer) [minimum: 1]");
    expect(formatted).toContain("    child (circular $ref: #/$defs/Node)");
  });

  it("flattens allOf branches and reports additionalProperties", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      ],
    };

    expect(formatSchema(schema)).toBe(
      [
        "  id (string) *required*",
        "  count (number) *required*",
        "  (additionalProperties: false)",
      ].join("\n"),
    );

    const openMap = {
      type: "object",
      properties: { fixed: { type: "string" } },
      additionalProperties: { type: "number", description: "Extra score" },
    };
    expect(formatSchema(openMap)).toBe(
      ["  fixed (string)", "  additionalProperties (number) - Extra score"].join("\n"),
    );
  });

  it("formats root-level anyOf and oneOf schemas", () => {
    const rootOneOf = {
      oneOf: [
        {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        {
          type: "object",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
      ],
    };

    expect(formatSchema(rootOneOf)).toBe(
      [
        "  oneOf:",
        "    - object",
        "      id (string) *required*",
        "    - object",
        "      slug (string) *required*",
      ].join("\n"),
    );

    const objectWithRootAnyOf = {
      type: "object",
      properties: { workspace: { type: "string" } },
      anyOf: [{ required: ["workspace"] }],
      additionalProperties: true,
    };
    const formatted = formatSchema(objectWithRootAnyOf);
    expect(formatted).toContain("  workspace (string)");
    expect(formatted).toContain("  anyOf:");
    expect(formatted).toContain("  (additionalProperties: true)");
  });
});
