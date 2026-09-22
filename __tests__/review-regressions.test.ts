import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readMcpResult, retainMcpResult } from "../mcp-output-guard.ts";
import { executeDescribe } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import type { McpExtensionState } from "../state.ts";

describe("review regressions: saved-result readback", () => {
  let outputDirectory: string;
  beforeAll(async () => { outputDirectory = await mkdtemp(join(tmpdir(), "mcp-readback-review-")); });
  afterAll(async () => { await rm(outputDirectory, { recursive: true, force: true }); });

  it.each([
    { maxBytes: 1024, maxLines: 2000, limit: 12_000, rows: [{ id: "x".repeat(3000), ignored: "hidden" }] },
    { maxBytes: 1024, maxLines: 6, limit: 12_000, rows: Array.from({ length: 8 }, (_, id) => ({ id, ignored: "hidden" })) },
    { maxBytes: 1024, maxLines: 6, limit: 5, rows: [{ id: "a😀b😀c", ignored: "hidden" }] },
    { maxBytes: 128, maxLines: 6, limit: 12_000, rows: [{ id: "😀".repeat(100), ignored: "hidden" }] },
  ])("includes notices and consumed newlines in page caps ($maxBytes bytes, $maxLines lines, limit $limit)", async ({ maxBytes, maxLines, limit, rows }) => {
    const saved = await retainMcpResult({ structuredContent: { rows } }, { outputDirectory });
    const expected = JSON.stringify(rows.map(({ id }) => ({ id })), null, 2);
    let offset = 0;
    let reconstructed = "";
    for (let count = 0; count <= expected.length; count++) {
      const page = await readMcpResult({ ref: saved.resultRef!, path: "/structuredContent/rows", fields: ["id"], offset, limit }, { outputDirectory, maxBytes, maxLines });
      expect(page.details).not.toHaveProperty("error");
      const visible = page.content.map(block => block.text).join("\n");
      expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(maxBytes);
      expect(visible.split("\n").length).toBeLessThanOrEqual(maxLines);
      reconstructed += page.content[0]!.text;
      if (page.details.nextOffset === null) break;
      expect(page.details.nextOffset).toBeGreaterThan(offset);
      expect(page.content[1]!.text).toContain(`Continue with offset: ${page.details.nextOffset}.`);
      offset = page.details.nextOffset!;
    }
    expect(reconstructed).toBe(expected);
  });

  it("never splits surrogate pairs at the character limit", async () => {
    const saved = await retainMcpResult({ value: "😀Z" }, { outputDirectory });
    const first = await readMcpResult({ ref: saved.resultRef!, path: "/value", limit: 2 }, { outputDirectory });
    expect(first.content[0]!.text).toBe('"');
    expect(first.details.nextOffset).toBe(1);
    const second = await readMcpResult({ ref: saved.resultRef!, path: "/value", offset: first.details.nextOffset!, limit: 2 }, { outputDirectory });
    expect(second.content[0]!.text).toBe("😀");
    expect(second.details.nextOffset).toBe(3);
    const splitOffset = await readMcpResult({ ref: saved.resultRef!, path: "/value", offset: 2 }, { outputDirectory });
    expect(splitOffset.details).toMatchObject({ error: "result_read_failed", message: "offset must not split a Unicode surrogate pair" });
  });

  it("keeps tiny-cap pages progressing with complete characters and recovery notices", async () => {
    const saved = await retainMcpResult({ value: ["😀"] }, { outputDirectory });
    const expected = JSON.stringify(["😀"], null, 2);
    let offset = 0;
    let reconstructed = "";
    for (let count = 0; count < expected.length; count++) {
      const page = await readMcpResult({ ref: saved.resultRef!, path: "/value", offset, limit: 1 }, { outputDirectory, maxBytes: 1, maxLines: 1 });
      expect(page.details).not.toHaveProperty("error");
      const text = page.content[0]!.text;
      expect([...text]).toHaveLength(1);
      expect(Buffer.from(text).toString()).toBe(text);
      reconstructed += text;
      if (page.details.nextOffset === null) break;
      expect(page.details.nextOffset).toBeGreaterThan(offset);
      expect(page.content[1]!.text).toContain(`Continue with offset: ${page.details.nextOffset}.`);
      offset = page.details.nextOffset!;
    }
    expect(reconstructed).toBe(expected);
  });

  it("rejects array properties as JSON Pointer tokens while preserving object keys", async () => {
    const saved = await retainMcpResult({ rows: ["first"], object: { length: 7, "01": 8, "a/b~c": 9 } }, { outputDirectory });
    for (const path of ["/rows/length", "/rows/01", "/rows/-"]) {
      expect((await readMcpResult({ ref: saved.resultRef!, path }, { outputDirectory })).details.error).toBe("result_read_failed");
    }
    for (const [path, expected] of [["/rows/0", '"first"'], ["/object/length", "7"], ["/object/01", "8"], ["/object/a~1b~0c", "9"]]) {
      expect((await readMcpResult({ ref: saved.resultRef!, path }, { outputDirectory })).content[0]!.text).toBe(expected);
    }
  });

  it("preserves private binary payload artifacts", async () => {
    const bytes = Buffer.from([0, 128, 255]);
    const saved = await retainMcpResult({ content: [{ type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" }] }, { outputDirectory });
    const file = saved.payloadFiles![0]!;
    expect(file).toMatchObject({ index: 0, kind: "audio", mimeType: "audio/wav" });
    expect(await readFile(file.path!)).toEqual(bytes);
    expect((await stat(file.path!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file.path!))).mode & 0o777).toBe(0o700);
  });
});

function collisionState(): McpExtensionState {
  const definition = { command: "unused" };
  const tools = ["a.b", "a_b"].map(name => ({ name, description: name, inputSchema: { type: "object" as const, properties: { [name]: { type: "string" } } } }));
  return {
    config: { settings: { toolPrefix: "none" }, mcpServers: { demo: definition } },
    toolMetadata: new Map([["demo", buildToolMetadata(tools, [], definition, "demo", "none").metadata]]),
  } as McpExtensionState;
}

describe("review regressions: scoped original-name description", () => {
  it("prefers the exact scoped original name over gateway aliases", () => {
    const state = collisionState();
    for (const name of ["a.b", "a_b"]) {
      const result = executeDescribe(state, name, "demo");
      expect(result.details).not.toHaveProperty("error");
      expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ server: "demo", name, inputSchema: { properties: { [name]: { type: "string" } } } });
    }
    expect(executeDescribe(state, "a_b").details.error).toBe("ambiguous_tool");
  });

  it("prefers the exact scoped original name in tools.describe and preserves unscoped ambiguity", async () => {
    const result = await runMcpScript(collisionState(), 'return { dot: await tools.describe({ server: "demo", path: "a.b" }), underscore: await tools.describe({ server: "demo", path: "a_b" }), unscoped: await tools.describe({ path: "a_b" }) };');
    expect(result.details).not.toHaveProperty("error");
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      dot: { server: "demo", name: "a.b", inputSchema: { properties: { "a.b": { type: "string" } } } },
      underscore: { server: "demo", name: "a_b", inputSchema: { properties: { a_b: { type: "string" } } } },
      unscoped: { error: { code: "ambiguous_tool" } },
    });
  });
});
