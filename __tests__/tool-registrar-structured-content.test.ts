import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { nativeMcpOutputSchema } from "../mcp-script-output.ts";
import { resolveMcpResultContent } from "../tool-registrar.ts";

describe("resolveMcpResultContent", () => {
  it("preserves human and structured content together", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { extra: true },
    });

    expect(blocks).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: JSON.stringify({ extra: true }, null, 2) },
    ]);
  });

  it("falls back to structuredContent when content is empty", () => {
    const structured = { status: "available", summary: "## Notes" };
    const blocks = resolveMcpResultContent({
      content: [],
      structuredContent: structured,
    });

    expect(blocks).toEqual([{ type: "text", text: JSON.stringify(structured, null, 2) }]);
  });

  it("falls back to structuredContent when content is omitted entirely", () => {
    const structured = { value: 42 };
    const blocks = resolveMcpResultContent({ structuredContent: structured });

    expect(blocks).toEqual([{ type: "text", text: JSON.stringify(structured, null, 2) }]);
  });

  it("returns empty array when both content and structuredContent are absent", () => {
    expect(resolveMcpResultContent({ content: [] })).toEqual([]);
    expect(resolveMcpResultContent({})).toEqual([]);
  });

  it.each([null, false, 0])(
    "preserves JSON primitive structuredContent %s",
    (structuredContent) => {
      expect(resolveMcpResultContent({ content: [], structuredContent })).toEqual([
        { type: "text", text: JSON.stringify(structuredContent) },
      ]);
    },
  );

  it("treats an empty structuredContent object as a present payload", () => {
    // guards against a truthy check that would drop a legitimately empty object
    expect(resolveMcpResultContent({ content: [], structuredContent: {} })).toEqual([
      { type: "text", text: "{}" },
    ]);
  });

  it("preserves images beside structured content", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      structuredContent: { caption: "image" },
    });

    expect(blocks).toEqual([
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ caption: "image" }, null, 2) },
    ]);
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
  it("accepts exact adapter omission receipts and rejects extra properties", () => {
    const schema = nativeMcpOutputSchema({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
      additionalProperties: false,
    });

    expect(Value.Check(schema, { count: 1 })).toBe(true);
    expect(Value.Check(schema, { mcpAdapter: { omitted: true, resultRef: "ref-1" } })).toBe(true);
    expect(Value.Check(schema, { mcpAdapter: { omitted: true, unexpected: true } })).toBe(false);
    expect(Value.Check(schema, { mcpAdapter: { omitted: true }, extra: true })).toBe(false);
  });
});
