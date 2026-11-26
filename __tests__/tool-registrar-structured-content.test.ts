import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { nativeMcpOutputSchema } from "../mcp-script-output.ts";
import { resolveMcpResultContent } from "../tool-registrar.ts";

describe("resolveMcpResultContent", () => {
  it("omits duplicate structuredContent when content already provides visible text", () => {
    const payload = { rows: [{ id: 1 }], count: 1 };
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      }),
    ).toEqual([{ type: "text", text: JSON.stringify(payload) }]);

    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: "Human summary" }],
        structuredContent: { extra: true },
      }),
    ).toEqual([{ type: "text", text: "Human summary" }]);
  });

  it("falls back to structuredContent when content is empty, omitted, or whitespace-only", () => {
    const structured = { status: "available", summary: "## Notes" };
    const expected = [{ type: "text", text: JSON.stringify(structured, null, 2) }];

    expect(resolveMcpResultContent({ content: [], structuredContent: structured })).toEqual(
      expected,
    );
    expect(resolveMcpResultContent({ structuredContent: structured })).toEqual(expected);
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: "   \n" }],
        structuredContent: structured,
      }),
    ).toEqual(expected);
  });

  it("returns empty array when both content and structuredContent are absent", () => {
    expect(resolveMcpResultContent({ content: [] })).toEqual([]);
    expect(resolveMcpResultContent({})).toEqual([]);
  });

  it.each([null, false, 0])(
    "preserves JSON primitive structuredContent %s when content is empty",
    (structuredContent) => {
      expect(resolveMcpResultContent({ content: [], structuredContent })).toEqual([
        { type: "text", text: JSON.stringify(structuredContent) },
      ]);
    },
  );

  it("treats an empty structuredContent object as a present fallback payload", () => {
    // guards against a truthy check that would drop a legitimately empty object
    expect(resolveMcpResultContent({ content: [], structuredContent: {} })).toEqual([
      { type: "text", text: "{}" },
    ]);
  });

  it("keeps non-text content such as images without duplicating structuredContent", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      structuredContent: { caption: "image" },
    });

    expect(blocks).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
  });

  it("degrades gracefully when structuredContent is not serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const blocks = resolveMcpResultContent({ content: [], structuredContent: circular });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text" });
  });
});

describe("nativeMcpOutputSchema", () => {
  it("wraps tools without a server outputSchema in the standard CallToolResult schema", () => {
    const schema = nativeMcpOutputSchema();

    expect(Value.Check(schema, { content: [{ type: "text", text: "ok" }] })).toBe(true);
    expect(
      Value.Check(schema, {
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        structuredContent: { anything: [1, true] },
        isError: true,
      }),
    ).toBe(true);
    expect(Value.Check(schema, { structuredContent: { missingContent: true } })).toBe(false);
  });

  it("relocates $defs, definitions, and root # $refs cleanly without mangling data keywords or property names", () => {
    const serverSchema = {
      type: "object",
      $defs: {
        Row: {
          type: "object",
          properties: {
            id: { type: "number" },
            $ref: { type: "string" },
          },
          required: ["id"],
        },
      },
      definitions: {
        Meta: {
          type: "object",
          properties: { source: { type: "string" } },
          required: ["source"],
        },
      },
      properties: {
        rows: { type: "array", items: { $ref: "#/$defs/Row" } },
        meta: { $ref: "#/definitions/Meta" },
        example: {
          type: "object",
          default: { $ref: "#/should-stay-literal" },
        },
        nested: { $ref: "#" },
      },
      required: ["rows"],
    };
    const schema = nativeMcpOutputSchema(serverSchema);

    expect(schema).toMatchObject({
      type: "object",
      required: ["content"],
      properties: {
        structuredContent: {
          properties: {
            rows: { items: { $ref: "#/properties/structuredContent/$defs/Row" } },
            meta: { $ref: "#/properties/structuredContent/definitions/Meta" },
            example: { default: { $ref: "#/should-stay-literal" } },
            nested: { $ref: "#/properties/structuredContent" },
          },
          $defs: {
            Row: {
              properties: {
                $ref: { type: "string" },
              },
            },
          },
        },
      },
    });
    expect(
      Value.Check(schema, {
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          rows: [{ id: 1, $ref: "literal-field" }],
          meta: { source: "db" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(schema, {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { rows: [{ id: "not-a-number" }] },
      }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        content: [{ type: "text", text: "err" }],
        isError: true,
      }),
    ).toBe(true);
  });
});
