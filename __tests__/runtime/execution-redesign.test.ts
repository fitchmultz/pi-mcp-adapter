import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectToolExecutor } from "../../direct-tools.ts";
import { executeCall } from "../../proxy-modes.ts";
import { runMcpScript } from "../../mcp-code.ts";
import { resolveMcpResultContent } from "../../tool-registrar.ts";
import * as output from "../../mcp-output-guard.ts";
import * as resources from "../../resource-tools.ts";
import type { ToolMetadata } from "../../types.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  initialResult: CallToolResult = { content: [{ type: "text", text: "ok" }] },
) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-redesign-test-"));
  directories.push(directory);
  let result = initialResult;
  const tool = {
    name: "echo",
    description: "Echo",
    inputSchema: { type: "object" as const, properties: {} },
  };
  const server = new McpServer({ name: "execution-redesign", version: "1" });
  server.server.registerCapabilities({ tools: {}, resources: {} });
  server.server.setRequestHandler("tools/list", () => ({ tools: [tool] }));
  server.server.setRequestHandler("tools/call", () => result);
  server.server.setRequestHandler("resources/list", () => ({ resources: [] }));
  server.server.setRequestHandler("resources/read", ({ params }) => ({
    contents: [{ uri: params.uri, text: "notes" }],
  }));
  const definition = { url: "https://unused.invalid/mcp", auth: false as const };
  const state = createTestState({
    config: { settings: {}, mcpServers: { demo: definition } },
    toolMetadata: new Map([["demo", [{ ...tool, name: "demo_echo", originalName: "echo" }]]]),
    outputDirectory: directory,
  });
  onTestFinished(async () => {
    await state.manager.closeAll();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (
    this: Client,
    _transport,
    options,
  ) {
    connect.mockRestore();
    return this.connect(clientTransport, options);
  });
  try {
    await state.manager.connect("demo", definition);
  } finally {
    connect.mockRestore();
  }
  const connection = state.manager.getConnection("demo");
  assert.ok(connection, "expected connected server");
  const callTool = vi.spyOn(connection.client, "callTool");
  const readResource = vi.spyOn(connection.client, "readResource");
  return {
    state,
    connection,
    directory,
    callTool,
    readResource,
    setResult: (next: CallToolResult) => {
      result = next;
    },
  };
}
const text = (result: Pick<AgentToolResult<unknown>, "content">) =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
const firstText = (result: Pick<AgentToolResult<unknown>, "content">) => {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
};

describe("MCP execution redesign", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterAll(async () => {
    await host.dispose();
  });
  it("only uses the no-file path for fully visible plain-text results", async () => {
    const { state, setResult, directory } = await fixture();
    expect(
      (await executeCall(state, { toolName: "demo_echo", args: {} })).details.resultRef,
    ).toBeUndefined();
    const raw: CallToolResult = {
      content: [{ type: "text", text: "done" }],
      _meta: { receipt: "saved-42" },
      vendorField: 3,
    };
    setResult(raw);
    const result = await executeCall(state, { toolName: "demo_echo", args: {} });
    assert.ok(typeof result.details.resultRef === "string");
    const readback = await output.readMcpResult(
      { ref: result.details.resultRef, path: "/_meta/receipt" },
      { outputDirectory: directory },
    );
    expect(JSON.parse(text(readback))).toBe("saved-42");
  });

  it("retains metadata attached to otherwise plain text content blocks", async () => {
    const raw: CallToolResult = {
      content: [
        {
          type: "text",
          text: "done",
          _meta: { receipt: "block-42" },
          annotations: { audience: ["assistant"] },
        },
      ],
    };
    const { state, directory } = await fixture(raw);
    const result = await executeCall(state, { toolName: "demo_echo", args: {} });
    expect(result.details.resultRef).toEqual(expect.any(String));
    assert.ok(typeof result.details.resultRef === "string");
    const readback = await output.readMcpResult(
      { ref: result.details.resultRef, path: "/content/0/_meta/receipt" },
      { outputDirectory: directory },
    );
    expect(JSON.parse(text(readback))).toBe("block-42");
  });

  it("saves unsupported audio/blob files and preserves images and links", async () => {
    const raw: CallToolResult = {
      content: [
        {
          type: "audio",
          mimeType: "audio/wav",
          data: Buffer.from("audio bytes").toString("base64"),
        },
        {
          type: "resource",
          resource: {
            uri: "test://file",
            mimeType: "application/octet-stream",
            blob: Buffer.from("blob bytes").toString("base64"),
          },
        },
        { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") },
        { type: "resource_link", name: "Receipt", uri: "test://receipt" },
      ],
    };
    const { state } = await fixture(raw);
    const result = await executeCall(state, { toolName: "demo_echo", args: {} });
    const files = z.array(z.object({ path: z.string() })).parse(result.details.payloadFiles);
    expect(await Promise.all(files.map((file) => readFile(file.path, "utf8")))).toEqual([
      "audio bytes",
      "blob bytes",
    ]);
    expect(text(result)).toContain("not rendered");
    expect(text(result)).toContain("test://receipt");
    expect(result.content).toContainEqual(raw.content[2]);
    const script = await runMcpScript(state, "const r = await tools.demo_echo({}); return r.ok;");
    expect(text(script)).toContain("MCP audio: audio/wav; not rendered. Saved file:");
    expect(text(script)).toContain(
      "MCP binary resource (test://file): application/octet-stream; not rendered. Saved file:",
    );
  });

  it("reads JSON pointers, fields and bounded pages without losing line boundaries", async () => {
    const raw: CallToolResult = {
      content: [],
      structuredContent: {
        "a/b": { "~key": Array.from({ length: 4 }, (_, id) => ({ id, extra: "omit" })) },
        arrayRows: [["not an object"]],
      },
    };
    const { state, directory } = await fixture(raw);
    const result = await executeCall(state, { toolName: "demo_echo", args: {} });
    assert.ok(typeof result.details.resultRef === "string");
    const input = {
      ref: result.details.resultRef,
      path: "/structuredContent/a~1b/~0key",
      fields: ["id"],
      limit: 7,
    };
    let offset = 0;
    let joined = "";
    for (let i = 0; i < 100; i++) {
      const page = await output.readMcpResult(
        { ...input, offset },
        { outputDirectory: directory, maxLines: 1 },
      );
      expect(page.details.error).toBeUndefined();
      assert.equal(page.details.error, undefined);
      const block = page.content[0];
      assert.ok(block);
      joined += block.text;
      if (page.details.nextOffset === null) {
        break;
      }
      expect(page.details.nextOffset).toBeGreaterThan(offset);
      offset = page.details.nextOffset;
    }
    expect(JSON.parse(joined)).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }]);
    const unknown = await output.readMcpResult(
      { ...input, path: "/missing" },
      { outputDirectory: directory },
    );
    expect(unknown.details.error).toBe("result_read_failed");
    const arrayRows = await output.readMcpResult(
      { ...input, path: "/structuredContent/arrayRows", fields: ["0"] },
      { outputDirectory: directory },
    );
    expect(arrayRows.details).toMatchObject({
      error: "result_read_failed",
      message: "fields requires an object or array of objects",
    });
    const unrelated = join(directory, "other.txt");
    await writeFile(unrelated, "private host file");
    expect(
      (await output.readMcpResult({ ref: unrelated }, { outputDirectory: directory })).details
        .error,
    ).toBe("result_read_failed");
  });

  it("lists the exact resource descriptor including native metadata", async () => {
    const { state, connection } = await fixture();
    const resource = {
      name: "notes",
      uri: "test://notes",
      title: "Notes",
      mimeType: "text/plain",
      _meta: { vendor: "retained" },
      icons: [{ src: "https://example.invalid/icon.svg" }],
    };
    connection.resources = [resource];
    expect((await resources.executeResourceList(state, { server: "demo" })).details).toMatchObject({
      items: [resource],
    });
  });

  it("keeps resource policy and legacy aliases while exposing URI reads to scripts", async () => {
    const { state, connection, readResource } = await fixture();
    connection.resources = [{ name: "notes", uri: "test://notes" }];
    expect((await resources.executeResourceList(state, { server: "demo" })).details).toMatchObject({
      items: [{ uri: "test://notes" }],
    });
    const script = await runMcpScript(
      state,
      'const list = await tools.resources({ server: "demo" }); const read = await tools.readResource({ server: "demo", uri: list.items[0].uri }); return read;',
    );
    expect(JSON.parse(firstText(script))).toMatchObject({
      ok: true,
      data: { contents: [{ uri: "test://notes", text: "notes" }] },
    });
    expect(
      (await executeCall(state, { toolName: "demo_read_notes" })).details.error,
    ).toBeUndefined();
    for (const policy of [
      { exposeResources: false },
      { excludeTools: ["read_notes"] },
      { includeTools: ["echo"] },
    ]) {
      state.config.mcpServers.demo = { command: "fixture", ...policy };
      expect(
        (await resources.executeResourceList(state, { server: "demo" })).details,
      ).toMatchObject({
        total: 0,
      });
      expect(
        (await resources.executeResourceRead(state, { server: "demo", uri: "test://notes" }))
          .details.error,
      ).toBe("tool_not_found");
    }
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("scripts describe exact raw schemas and report partial catalog coverage", async () => {
    const { state } = await fixture();
    const descriptor: ToolMetadata = {
      name: "demo_echo",
      originalName: "echo",
      description: "Echo",
      title: "Echo value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", minLength: 4, description: "Value" } },
      },
      outputSchema: { type: "object", properties: { id: { type: "number" } } },
      annotations: { readOnlyHint: true },
      _meta: { vendor: "retained" },
      execution: { taskSupport: "optional" },
    };
    state.toolMetadata.set("demo", [descriptor]);
    state.config.mcpServers.unknown = { command: "not contacted" };
    const result = await runMcpScript(
      state,
      'return { found: await tools.describe({ path: "demo_echo" }), search: await tools.search({ query: "Echo" }) };',
    );
    const parsed = z
      .object({ found: z.unknown(), search: z.object({ coverage: z.unknown() }) })
      .parse(JSON.parse(firstText(result)));
    const { originalName: _originalName, name: _name, ...fields } = descriptor;
    expect(parsed.found).toEqual({ ...fields, name: "echo", path: "demo_echo", server: "demo" });
    expect(parsed.search.coverage).toEqual({
      complete: false,
      knownServers: ["demo"],
      unknownServers: ["unknown"],
    });
  });

  it("discovers only the selected uncached server and surfaces authentication failures", async () => {
    const { state, connection } = await fixture();
    state.config.mcpServers.cold = { command: "fixture" };
    state.config.mcpServers.other = { command: "must not connect" };
    const connect = vi.spyOn(state.manager, "connect").mockResolvedValue(connection);
    const result = await runMcpScript(
      state,
      'return await tools.search({ query: "Echo", server: "cold" });',
    );
    expect(JSON.parse(firstText(result))).toMatchObject({
      items: [{ path: "cold_echo" }],
      coverage: { complete: true, knownServers: ["cold"], unknownServers: [] },
    });
    expect(connect.mock.calls.map((call) => call[0])).toEqual(["cold"]);
    state.toolMetadata.delete("cold");
    connect.mockResolvedValue({ ...connection, status: "needs-auth" });
    const failed = await runMcpScript(
      state,
      'return await tools.search({ query: "Echo", server: "cold" });',
    );
    expect(JSON.parse(firstText(failed))).toMatchObject({
      error: { code: "auth_required" },
      coverage: { complete: false, unknownServers: ["cold"] },
    });
    expect(failed.details.calls).toMatchObject([
      { operation: "search", ok: false, error: "auth_required" },
    ]);
  });

  it("rejects normalized live alias collisions but executes exact original identities", async () => {
    const { state, connection, callTool } = await fixture();
    connection.tools = [
      { name: "a.b", inputSchema: { type: "object" } },
      { name: "a_b", inputSchema: { type: "object" } },
    ];
    state.toolMetadata.set("demo", [
      { name: "demo_a_b", originalName: "a.b", description: "stale single alias" },
    ]);
    expect((await executeCall(state, { toolName: "demo_a_b", args: {} })).details.error).toBe(
      "ambiguous_tool",
    );
    expect(callTool).not.toHaveBeenCalled();
    const script = await runMcpScript(state, 'return await tools.call("a_b", {}, "demo");');
    expect(JSON.parse(firstText(script))).toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "a_b" }),
      expect.anything(),
    );
  });

  it("keeps same-name resources addressable by URI and rejects the ambiguous legacy alias", async () => {
    const { state, connection, readResource } = await fixture();
    connection.resources = [
      { name: "notes", uri: "test://one" },
      { name: "notes", uri: "test://two" },
    ];
    expect((await resources.executeResourceList(state, { server: "demo" })).details).toMatchObject({
      total: 2,
    });
    expect((await executeCall(state, { toolName: "demo_read_notes" })).details.error).toBe(
      "ambiguous_tool",
    );
    expect(
      (await resources.executeResourceRead(state, { server: "demo", uri: "test://two" })).details
        .error,
    ).toBeUndefined();
    expect(readResource).toHaveBeenCalledWith({ uri: "test://two" }, expect.anything());
  });

  it("keeps structured content beside human content", () => {
    expect(
      resolveMcpResultContent({
        content: [{ type: "text", text: "Done" }],
        structuredContent: { id: 7 },
      }),
    ).toEqual([
      { type: "text", text: "Done" },
      { type: "text", text: JSON.stringify({ id: 7 }, null, 2) },
    ]);
  });

  it("does not dispatch an ambiguous unscoped name", async () => {
    const { state, callTool } = await fixture();
    state.config.mcpServers.other = { command: "fixture" };
    state.toolMetadata.set("other", [
      { name: "demo_echo", originalName: "different", description: "Other" },
    ]);
    expect((await executeCall(state, { toolName: "demo_echo", args: {} })).details.error).toBe(
      "ambiguous_tool",
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("direct calls reject removed tools rather than use frozen specs", async () => {
    const { state, connection, callTool } = await fixture();
    connection.tools = [];
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", prefixedName: "demo_echo", originalName: "echo", description: "Stale" },
    );
    expect(
      (
        await execute(
          "id",
          {},
          undefined,
          undefined,
          host.runner.createToolContext("id", state.owner.signal),
        )
      ).details.error,
    ).toBe("tool_not_found");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("preserves raw MCP error payloads in script envelopes", async () => {
    const raw: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: "Declined" }],
      structuredContent: { reason: "quota", remaining: 0 },
    };
    const { state, callTool } = await fixture(raw);
    const result = await runMcpScript(state, "return await tools.demo_echo({});");
    expect(JSON.parse(firstText(result))).toMatchObject({
      ok: false,
      data: raw,
      error: { code: "tool_error" },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("exposes retained raw JSON through gateway and script readback without another dispatch", async () => {
    const raw: CallToolResult = {
      content: [{ type: "text", text: "Done" }],
      structuredContent: { rows: [{ id: 1, secret: "omit" }, { id: 2 }] },
    };
    const { state, callTool, directory } = await fixture(raw);
    const result = await executeCall(state, { toolName: "demo_echo", args: {} });
    const ref = result.details.resultRef;
    expect(ref).toEqual(expect.any(String));
    assert.ok(typeof ref === "string");
    expect(text(result)).toContain(ref);
    expect(JSON.parse(await readFile(ref, "utf8"))).toEqual(raw);
    const page = await output.readMcpResult(
      { ref, path: "/structuredContent/rows", fields: ["id"] },
      { outputDirectory: directory },
    );
    expect(JSON.parse(text(page))).toEqual([{ id: 1 }, { id: 2 }]);
    const script = await runMcpScript(
      state,
      `return await tools.readResult({ ref: ${JSON.stringify(ref)}, path: "/structuredContent/rows/1" });`,
    );
    expect(text(script)).toContain('\\"id\\": 2');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("reads resources by URI through the same approval and capture path", async () => {
    const { state, connection, readResource } = await fixture();
    connection.resources = [{ name: "notes", uri: "test://notes" }];
    const onToolCall = vi.fn<NonNullable<typeof state.onToolCall>>(async () => {
      // Capture only.
    });
    state.onToolCall = onToolCall;
    const before = vi.fn<
      NonNullable<Parameters<typeof resources.executeResourceRead>[1]["beforeDispatch"]>
    >(async () => {
      // Record admission without changing it.
    });
    const result = await resources.executeResourceRead(state, {
      server: "demo",
      uri: "test://notes",
      signal: undefined,
      identity: { toolCallId: "read-1" },
      beforeDispatch: before,
    });
    expect(text(result)).toContain("notes");
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.objectContaining({ resourceUri: "test://notes" }),
    );
    expect(onToolCall.mock.calls.map((call) => call[0].phase)).toEqual(["before", "after"]);
    state.config.settings = { approveTools: ["read_notes"] };
    expect(
      (await resources.executeResourceRead(state, { server: "demo", uri: "test://notes" })).details
        .error,
    ).toBe("approval_required");
    expect(readResource).toHaveBeenCalledTimes(1);
  });
});
