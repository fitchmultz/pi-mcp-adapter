import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { guardMcpOutput, readMcpResult, retainMcpResult } from "../../mcp-output-guard.ts";
import { executeCall } from "../../proxy-modes.ts";
import { executeResourceRead } from "../../resource-tools.ts";
import { transformMcpContent } from "../../tool-registrar.ts";
import { createTestState } from "../test-state.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createBoundaryFixture(options: {
  toolResult?: CallToolResult;
  resourceResult?: ReadResourceResult;
  outputGuard?: { maxBytes?: number; maxLines?: number; detailsMaxBytes?: number };
}) {
  const directory = await createTempDir("mcp-209-boundary-");
  let currentToolResult: CallToolResult = options.toolResult ?? {
    content: [{ type: "text", text: "ok" }],
  };
  let currentResourceResult: ReadResourceResult = options.resourceResult ?? {
    contents: [{ uri: "test://item", text: "ok" }],
  };

  const tool = {
    name: "fetch",
    description: "Fetch data",
    inputSchema: { type: "object" as const, properties: {} },
  };
  const resource = { name: "item", uri: "test://item" };

  const server = new McpServer({ name: "mcp-209-fixture", version: "1.0.0" });
  server.server.registerCapabilities({ tools: {}, resources: {} });
  server.server.setRequestHandler("tools/list", () => ({ tools: [tool] }));
  server.server.setRequestHandler("tools/call", () => currentToolResult);
  server.server.setRequestHandler("resources/list", () => ({ resources: [resource] }));
  server.server.setRequestHandler("resources/read", () => currentResourceResult);

  const definition = { url: "https://unused.invalid/mcp", auth: false as const };
  const state = createTestState({
    config: {
      settings: options.outputGuard ? { outputGuard: options.outputGuard } : {},
      mcpServers: { demo: definition },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          { ...tool, name: "demo_fetch", originalName: "fetch" },
          {
            name: "demo_read_item",
            originalName: "read_item",
            description: "Read item",
            resourceUri: resource.uri,
          },
        ],
      ],
    ]),
    outputDirectory: directory,
  });

  onTestFinished(async () => {
    await state.manager.closeAll();
    await server.close();
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connectSpy = vi.spyOn(Client.prototype, "connect").mockImplementation(function (
    this: Client,
    _transport,
    connectOptions,
  ) {
    connectSpy.mockRestore();
    return this.connect(clientTransport, connectOptions);
  });
  try {
    await state.manager.connect("demo", definition);
  } finally {
    connectSpy.mockRestore();
  }

  return {
    state,
    directory,
    setToolResult: (next: CallToolResult) => {
      currentToolResult = next;
    },
    setResourceResult: (next: ReadResourceResult) => {
      currentResourceResult = next;
    },
  };
}

describe("MCP-209: read-result raw text and JSON-in-text traversal", () => {
  it("returns raw unescaped text when selecting a string and pages across UTF-8 boundaries", async () => {
    const outputDirectory = await createTempDir("mcp-209-raw-text-");
    const rawText = 'line 1: "quoted"\nline 2: café 😀\nline 3: end';
    const saved = await retainMcpResult(
      { content: [{ type: "text", text: rawText }] },
      { outputDirectory, detailsMaxBytes: 1 },
    );
    assert.ok(typeof saved.resultRef === "string");

    const full = await readMcpResult(
      { ref: saved.resultRef, path: "/content/0/text" },
      { outputDirectory },
    );
    expect(full.details.error).toBeUndefined();
    expect(full.content).toEqual([{ type: "text", text: rawText }]);

    let offset = 0;
    let reconstructed = "";
    for (let guard = 0; guard < 100; guard++) {
      const page = await readMcpResult(
        { ref: saved.resultRef, path: "/content/0/text", offset, limit: 12 },
        { outputDirectory, maxBytes: 128, maxLines: 2 },
      );
      expect(page.details.error).toBeUndefined();
      assert.ok(page.details.error === undefined);
      const block = page.content[0];
      assert.ok(block !== undefined);
      expect(block.text).not.toContain("\uFFFD");
      reconstructed += block.text;
      if (page.details.nextOffset === null) {
        break;
      }
      offset = page.details.nextOffset;
    }
    expect(reconstructed).toBe(rawText);
  });

  it("traverses JSON-in-text transparently while keeping outer-envelope priority", async () => {
    const outputDirectory = await createTempDir("mcp-209-json-in-text-");
    const embedded = {
      containersDaily: [
        { name: "api-edge", cpu: 42 },
        { name: "worker-1", cpu: 19 },
      ],
      content: { shadowedByOuterEnvelope: true },
      summary: { total: 2 },
    };
    const saved = await retainMcpResult(
      {
        isError: false,
        content: [
          { type: "text", text: "Summary below:" },
          { type: "text", text: JSON.stringify(embedded) },
        ],
        structuredContent: { envelopeOnly: "outer-value" },
      },
      { outputDirectory, detailsMaxBytes: 1 },
    );
    assert.ok(typeof saved.resultRef === "string");
    const ref = saved.resultRef;

    // Transparent traversal into JSON-in-text (nested objects, arrays, and string leaves).
    const daily = await readMcpResult({ ref, path: "/containersDaily" }, { outputDirectory });
    expect(daily.details.error).toBeUndefined();
    expect(daily.content[0]?.text).toBe(JSON.stringify(embedded.containersDaily));

    const firstName = await readMcpResult(
      { ref, path: "/containersDaily/0/name" },
      { outputDirectory },
    );
    expect(firstName.details.error).toBeUndefined();
    expect(firstName.content[0]?.text).toBe("api-edge");

    // Works with field projection.
    const projected = await readMcpResult(
      { ref, path: "/containersDaily", fields: ["name"] },
      { outputDirectory },
    );
    expect(projected.details.error).toBeUndefined();
    expect(projected.content[0]?.text).toBe(
      JSON.stringify([{ name: "api-edge" }, { name: "worker-1" }]),
    );

    // Drilling past /content/1/text/... also resolves cleanly.
    const drilled = await readMcpResult(
      { ref, path: "/content/1/text/summary/total" },
      { outputDirectory },
    );
    expect(drilled.details.error).toBeUndefined();
    expect(drilled.content[0]?.text).toBe("2");

    // Outer-envelope priority: /content, /content/1/text, /structuredContent/envelopeOnly, /isError.
    const outerContent = await readMcpResult({ ref, path: "/content" }, { outputDirectory });
    expect(outerContent.details.error).toBeUndefined();
    expect(JSON.parse(outerContent.content[0]?.text ?? "")).toHaveLength(2);

    const rawTextBlock = await readMcpResult({ ref, path: "/content/1/text" }, { outputDirectory });
    expect(rawTextBlock.details.error).toBeUndefined();
    expect(rawTextBlock.content[0]?.text).toBe(JSON.stringify(embedded));

    const outerStructured = await readMcpResult(
      { ref, path: "/structuredContent/envelopeOnly" },
      { outputDirectory },
    );
    expect(outerStructured.details.error).toBeUndefined();
    expect(outerStructured.content[0]?.text).toBe("outer-value");

    const outerIsError = await readMcpResult({ ref, path: "/isError" }, { outputDirectory });
    expect(outerIsError.details.error).toBeUndefined();
    expect(outerIsError.content[0]?.text).toBe("false");

    // Resource envelope contents[0].text also supports transparent JSON traversal.
    const resourceSaved = await retainMcpResult(
      { contents: [{ uri: "metrics://daily", text: JSON.stringify({ metrics: [{ id: 9 }] }) }] },
      { outputDirectory, detailsMaxBytes: 1 },
    );
    assert.ok(typeof resourceSaved.resultRef === "string");
    const metricId = await readMcpResult(
      { ref: resourceSaved.resultRef, path: "/metrics/0/id" },
      { outputDirectory },
    );
    expect(metricId.details.error).toBeUndefined();
    expect(metricId.content[0]?.text).toBe("9");
  });

  it("reports nearest valid parent, capped keys/bounds, and embedded JSON top-level keys on miss", async () => {
    const outputDirectory = await createTempDir("mcp-209-hints-");
    const wideObject = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const saved = await retainMcpResult(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              containersDaily: [{ name: "web", port: 8080 }],
              wide: wideObject,
            }),
          },
        ],
      },
      { outputDirectory, detailsMaxBytes: 1 },
    );
    assert.ok(typeof saved.resultRef === "string");
    const ref = saved.resultRef;

    const rootMiss = await readMcpResult({ ref, path: "/typoKey" }, { outputDirectory });
    expect(rootMiss.details.error).toBe("result_read_failed");
    const rootMsg = rootMiss.content[0]?.text ?? "";
    expect(rootMsg).toContain("Nearest valid parent: /");
    expect(rootMsg).toContain('"content"');
    expect(rootMsg).toContain("/content/0/text");
    expect(rootMsg).toContain('"containersDaily"');
    expect(rootMsg).toContain('"wide"');

    const nestedMiss = await readMcpResult(
      { ref, path: "/containersDaily/0/nonexistent" },
      { outputDirectory },
    );
    expect(nestedMiss.details.error).toBe("result_read_failed");
    const nestedMsg = nestedMiss.content[0]?.text ?? "";
    expect(nestedMsg).toContain("Nearest valid parent: /containersDaily/0");
    expect(nestedMsg).toContain('"name"');
    expect(nestedMsg).toContain('"port"');

    const arrayMiss = await readMcpResult({ ref, path: "/containersDaily/5" }, { outputDirectory });
    expect(arrayMiss.details.error).toBe("result_read_failed");
    const arrayMsg = arrayMiss.content[0]?.text ?? "";
    expect(arrayMsg).toContain("Nearest valid parent: /containersDaily");
    expect(arrayMsg).toContain("array of length 1, indices 0..0");

    const wideMiss = await readMcpResult({ ref, path: "/wide/missing" }, { outputDirectory });
    expect(wideMiss.details.error).toBe("result_read_failed");
    const wideMsg = wideMiss.content[0]?.text ?? "";
    expect(wideMsg).toContain("Nearest valid parent: /wide");
    expect(wideMsg).toContain("(+5 more)");

    // Resource contents[0].text array root hint.
    const resourceSaved = await retainMcpResult(
      { contents: [{ uri: "data://list", text: JSON.stringify([{ id: 1 }, { id: 2 }]) }] },
      { outputDirectory, detailsMaxBytes: 1 },
    );
    assert.ok(typeof resourceSaved.resultRef === "string");
    const resMiss = await readMcpResult(
      { ref: resourceSaved.resultRef, path: "/items" },
      { outputDirectory },
    );
    expect(resMiss.details.error).toBe("result_read_failed");
    expect(resMiss.content[0]?.text ?? "").toContain(
      "Parsed JSON at /contents/0/text has array of length 2, indices 0..1",
    );
  });
});

describe("MCP-209: single-artifact spilling and unified truncation notice", () => {
  it("writes exactly one private artifact and one notice for oversized tool and resource calls", async () => {
    const bigPayload = JSON.stringify({
      containersDaily: Array.from({ length: 60 }, (_, i) => ({
        id: i,
        name: `container-${i}-${"x".repeat(40)}`,
      })),
    });
    const { state, directory } = await createBoundaryFixture({
      toolResult: { content: [{ type: "text", text: bigPayload }] },
      resourceResult: { contents: [{ uri: "test://item", text: "resource-line\n".repeat(400) }] },
      outputGuard: { maxBytes: 600, maxLines: 20, detailsMaxBytes: 200 },
    });

    const toolResult = await executeCall(state, { toolName: "demo_fetch", args: {} });
    const toolDetails = z
      .object({
        resultRef: z.string(),
        outputGuard: z.object({
          truncated: z.literal(true),
          fullOutputPath: z.undefined().optional(),
        }),
      })
      .parse(toolResult.details);
    expect(basename(toolDetails.resultRef)).toMatch(/^mcp-result-[a-f0-9]+\.txt$/);
    expect(toolResult.content).toHaveLength(1);
    const toolBlock = toolResult.content[0];
    assert.ok(toolBlock?.type === "text");
    expect(toolBlock.text).toContain("MCP text output truncated");
    expect(toolBlock.text).toContain(toolDetails.resultRef);
    expect(toolBlock.text).toContain('mcp action "read-result"');
    expect(toolBlock.text).not.toContain("Full text saved to:");
    expect(
      process.platform === "win32" || ((await stat(toolDetails.resultRef)).mode & 0o777) === 0o600,
    ).toBe(true);

    // Only 1 artifact file on disk after the tool call.
    const filesAfterTool = (await readdir(directory, { recursive: true })).filter((name) =>
      name.endsWith(".txt"),
    );
    expect(filesAfterTool).toHaveLength(1);

    // Reading back via read-result works immediately without double-escaping.
    const firstContainer = await readMcpResult(
      { ref: toolDetails.resultRef, path: "/containersDaily/0/name" },
      { outputDirectory: directory },
    );
    expect(firstContainer.details.error).toBeUndefined();
    expect(firstContainer.content[0]?.text).toBe(`container-0-${"x".repeat(40)}`);

    // Oversized resource read also writes only 1 artifact (total 2 files across both calls).
    const resourceResult = await executeResourceRead(state, {
      server: "demo",
      uri: "test://item",
    });
    const resourceDetails = z
      .object({
        resultRef: z.string(),
        outputGuard: z.object({
          truncated: z.literal(true),
          fullOutputPath: z.undefined().optional(),
        }),
      })
      .parse(resourceResult.details);
    expect(resourceResult.content).toHaveLength(1);
    const resBlock = resourceResult.content[0];
    assert.ok(resBlock?.type === "text");
    expect(resBlock.text).toContain(resourceDetails.resultRef);
    expect(resBlock.text).not.toContain("Full text saved to:");

    const filesAfterBoth = (await readdir(directory, { recursive: true })).filter((name) =>
      name.endsWith(".txt"),
    );
    expect(filesAfterBoth).toHaveLength(2);
  });

  it("still spills a plain output-*.txt artifact when no retained MCP result exists", async () => {
    const outputDirectory = await createTempDir("mcp-209-plain-spill-");
    const text = "plain-line\n".repeat(100);
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      outputDirectory,
      maxBytes: 250,
      maxLines: 5,
    });
    expect(guarded.resultRef).toBeUndefined();
    assert.ok(typeof guarded.outputGuard?.fullOutputPath === "string");
    expect(basename(guarded.outputGuard.fullOutputPath)).toMatch(/^output-[a-f0-9]+\.txt$/);
    expect(await readFile(guarded.outputGuard.fullOutputPath, "utf8")).toBe(text);
  });
});

describe("MCP-209: native media/blob rendering and resource_link metadata", () => {
  it("renders image/* blobs as native ImageContent for both read-resource and embedded resources", async () => {
    const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");
    const { state, directory } = await createBoundaryFixture({
      toolResult: {
        content: [
          { type: "text", text: "caption\n".repeat(80) },
          {
            type: "resource",
            resource: {
              uri: "img://embedded-chart",
              mimeType: "IMAGE/WEBP; charset=binary",
              blob: pngBase64,
            },
          },
        ],
      },
      resourceResult: {
        contents: [{ uri: "test://item", mimeType: "image/png", blob: pngBase64 }],
      },
      outputGuard: { maxBytes: 300, maxLines: 5, detailsMaxBytes: 100 },
    });

    const toolResult = await executeCall(state, { toolName: "demo_fetch", args: {} });
    expect(toolResult.details.payloadFiles).toBeUndefined();
    expect(toolResult.details.outputGuard).toMatchObject({
      truncated: true,
      imageBlocksPassedThrough: 1,
    });
    expect(toolResult.content).toContainEqual({
      type: "image",
      data: pngBase64,
      mimeType: "image/webp",
    });

    const resourceResult = await executeResourceRead(state, {
      server: "demo",
      uri: "test://item",
    });
    expect(resourceResult.details.payloadFiles).toBeUndefined();
    expect(resourceResult.content).toEqual([
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ]);

    const payloadFiles = (await readdir(directory, { recursive: true })).filter((name) =>
      basename(name).startsWith("payload-"),
    );
    expect(payloadFiles).toEqual([]);
  });

  it("decodes UTF-8 text/JSON/XML blobs inline and falls back to binary file on invalid UTF-8", async () => {
    const jsonPayload = JSON.stringify({ ok: true, symbol: "€" });
    const xmlPayload = "<feed><title>Updates</title></feed>";
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x80, 0x81]);
    const { state, setToolResult, setResourceResult } = await createBoundaryFixture({
      outputGuard: { maxBytes: 400, maxLines: 50, detailsMaxBytes: 200 },
    });

    // Embedded resources with UTF-8 text/JSON/XML blobs decode inline with no payload files.
    setToolResult({
      content: [
        {
          type: "resource",
          resource: {
            uri: "data://config.json",
            mimeType: "application/vnd.api+json; charset=utf-8",
            blob: Buffer.from(jsonPayload, "utf8").toString("base64"),
          },
        },
        {
          type: "resource",
          resource: {
            uri: "data://feed.xml",
            mimeType: "application/atom+xml",
            blob: Buffer.from(xmlPayload, "utf8").toString("base64"),
          },
        },
      ],
    });
    const decodedTool = await executeCall(state, { toolName: "demo_fetch", args: {} });
    expect(decodedTool.details.payloadFiles).toBeUndefined();
    const joined = decodedTool.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(joined).toContain("[Resource: data://config.json]");
    expect(joined).toContain(jsonPayload);
    expect(joined).toContain(xmlPayload);

    // Oversized text blob in read-resource respects normal text/output-guard budget.
    const hugeNdjson = `${JSON.stringify({ row: "x".repeat(40) })}\n`.repeat(30);
    setResourceResult({
      contents: [
        {
          uri: "test://item",
          mimeType: "application/x-ndjson",
          blob: Buffer.from(hugeNdjson, "utf8").toString("base64"),
        },
      ],
    });
    const oversizedBlob = await executeResourceRead(state, {
      server: "demo",
      uri: "test://item",
    });
    expect(oversizedBlob.details.payloadFiles).toBeUndefined();
    expect(oversizedBlob.details.outputGuard).toMatchObject({ truncated: true });
    const oversizedBlock = oversizedBlob.content[0];
    assert.ok(oversizedBlock?.type === "text");
    expect(oversizedBlock.text).toContain('{"row":"xxxx');
    expect(oversizedBlock.text).toContain("MCP text output truncated");

    // Invalid UTF-8 bytes in a text/plain blob fall back cleanly to binary file on disk.
    setResourceResult({
      contents: [
        {
          uri: "test://item",
          mimeType: "text/plain",
          blob: invalidUtf8.toString("base64"),
        },
      ],
    });
    const invalidResult = await executeResourceRead(state, {
      server: "demo",
      uri: "test://item",
    });
    const payloadFiles = z
      .array(z.object({ path: z.string(), mimeType: z.string() }))
      .parse(invalidResult.details.payloadFiles);
    expect(payloadFiles).toHaveLength(1);
    const saved = payloadFiles[0];
    assert.ok(saved !== undefined);
    expect(saved.path.endsWith(".txt")).toBe(true);
    expect(await readFile(saved.path)).toEqual(invalidUtf8);
    const fallbackBlock = invalidResult.content[0];
    assert.ok(fallbackBlock?.type === "text");
    expect(fallbackBlock.text).toContain("not rendered");
    expect(fallbackBlock.text).toContain(saved.path);
  });

  it("preserves safe binary file extensions from MIME types and sanitized resource URIs", async () => {
    const rawBytes = Buffer.from([1, 2, 3, 4]);
    const b64 = rawBytes.toString("base64");
    const { state } = await createBoundaryFixture({
      toolResult: {
        content: [
          {
            type: "resource",
            resource: { uri: "docs://quarterly", mimeType: "application/pdf", blob: b64 },
          },
          {
            type: "resource",
            resource: {
              uri: "s3://bucket/exports/table.Parquet?token=abc#v1",
              mimeType: "application/octet-stream",
              blob: b64,
            },
          },
          {
            type: "resource",
            resource: {
              uri: "https://example.com",
              mimeType: "application/octet-stream",
              blob: b64,
            },
          },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/bad.ext!@#",
              mimeType: "application/octet-stream",
              blob: b64,
            },
          },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/too.abcdefghijk",
              mimeType: "application/octet-stream",
              blob: b64,
            },
          },
          { type: "audio", mimeType: "audio/mpeg", data: b64 },
          {
            type: "resource",
            resource: { uri: "bin://module", mimeType: "application/wasm", blob: b64 },
          },
        ],
      },
    });

    const result = await executeCall(state, { toolName: "demo_fetch", args: {} });
    const files = z
      .array(z.object({ index: z.number(), path: z.string() }))
      .parse(result.details.payloadFiles);
    expect(files.map((file) => basename(file.path).split(".").at(-1))).toEqual([
      "pdf",
      "parquet",
      "bin",
      "bin",
      "bin",
      "mp3",
      "wasm",
    ]);
    for (const file of files) {
      expect(await readFile(file.path)).toEqual(rawBytes);
      expect(process.platform === "win32" || ((await stat(file.path)).mode & 0o777) === 0o600).toBe(
        true,
      );
    }
  });

  it("preserves title, description, mimeType, and size on resource_link blocks", async () => {
    const { state } = await createBoundaryFixture({
      toolResult: {
        content: [
          {
            type: "resource_link",
            name: "q4-report",
            uri: "docs://reports/q4.pdf",
            title: "Q4 Financial Report",
            description: "Audited quarterly summary",
            mimeType: "application/pdf",
            size: 4096,
          },
          {
            type: "resource_link",
            name: "empty-log",
            uri: "logs://empty",
            size: 0,
          },
        ],
      },
    });

    const result = await executeCall(state, { toolName: "demo_fetch", args: {} });
    const first = result.content[0];
    assert.ok(first?.type === "text");
    expect(first.text).toBe(
      [
        "[Resource Link: q4-report]",
        "URI: docs://reports/q4.pdf",
        "Title: Q4 Financial Report",
        "Description: Audited quarterly summary",
        "MIME type: application/pdf",
        "Size: 4096 bytes",
      ].join("\n"),
    );

    const second = result.content[1];
    assert.ok(second?.type === "text");
    expect(second.text).toBe(
      ["[Resource Link: empty-log]", "URI: logs://empty", "Size: 0 bytes"].join("\n"),
    );

    const direct = transformMcpContent([
      {
        type: "resource_link",
        name: "spec",
        uri: "docs://spec.md",
        title: "API Spec",
        description: "OpenAPI document",
        mimeType: "text/markdown",
        size: 128,
      },
    ]);
    expect(direct).toEqual([
      {
        type: "text",
        text: [
          "[Resource Link: spec]",
          "URI: docs://spec.md",
          "Title: API Spec",
          "Description: OpenAPI document",
          "MIME type: text/markdown",
          "Size: 128 bytes",
        ].join("\n"),
      },
    ]);
  });

  it("decodes image/svg+xml blobs inline as UTF-8 text and saves non-vision image binaries with extensions", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    const tiffBytes = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
    const { state } = await createBoundaryFixture({
      toolResult: {
        content: [
          {
            type: "resource",
            resource: {
              uri: "assets://icon.svg",
              mimeType: "image/svg+xml",
              blob: Buffer.from(svg, "utf8").toString("base64"),
            },
          },
          {
            type: "resource",
            resource: {
              uri: "assets://scan",
              mimeType: "image/tiff",
              blob: tiffBytes.toString("base64"),
            },
          },
        ],
      },
    });

    const result = await executeCall(state, { toolName: "demo_fetch", args: {} });
    expect(result.content.some((block) => block.type === "image")).toBe(false);
    const joinedText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(joinedText).toContain(svg);
    const files = z
      .array(z.object({ index: z.number(), path: z.string() }))
      .parse(result.details.payloadFiles);
    expect(files.map((file) => basename(file.path).split(".").at(-1))).toEqual(["tiff"]);
  });
});
