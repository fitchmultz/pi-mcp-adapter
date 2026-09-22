import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { resolveMcpResultContent } from "../tool-registrar.ts";
import * as output from "../mcp-output-guard.ts";
import * as resources from "../resource-tools.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(result: unknown = { content: [{ type: "text", text: "ok" }] }) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-redesign-test-"));
  directories.push(directory);
  const tool = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } };
  const connection = { status: "connected", tools: [tool], resources: [], client: {
    callTool: vi.fn(async () => result), readResource: vi.fn(async () => ({ contents: [{ uri: "test://notes", text: "notes" }] })),
  } };
  const state = {
    config: { settings: {}, mcpServers: { demo: { command: "fixture" } } },
    toolMetadata: new Map([["demo", [{ ...tool, name: "demo_echo", originalName: "echo" }]]]),
    manager: { getConnection: () => connection, touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn() },
    metadataCacheEnabled: false, failureTracker: new Map(), approvedToolCalls: new Map(), completedUiSessions: [], serverInstructions: new Map(), outputDirectory: directory,
  } as any;
  return { state, connection };
}
const text = (result: any) => result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");

describe("MCP execution redesign", () => {
  it("only uses the no-file path for fully visible plain-text results", async () => {
    const { state } = await fixture();
    expect((await executeCall(state, "demo_echo", {})).details.resultRef).toBeUndefined();
    const raw = { content: [{ type: "text", text: "done" }], _meta: { receipt: "saved-42" }, vendorField: 3 };
    state.manager.getConnection().client.callTool.mockResolvedValue(raw);
    const result = await executeCall(state, "demo_echo", {});
    const readback = await output.readMcpResult({ ref: result.details.resultRef as string, path: "/_meta/receipt" }, { outputDirectory: state.outputDirectory });
    expect(JSON.parse(text(readback))).toBe("saved-42");
  });

  it("retains metadata attached to otherwise plain text content blocks", async () => {
    const raw = { content: [{ type: "text", text: "done", _meta: { receipt: "block-42" }, annotations: { audience: ["assistant"] } }] };
    const { state } = await fixture(raw);
    const result = await executeCall(state, "demo_echo", {});
    expect(result.details.resultRef).toEqual(expect.any(String));
    const readback = await output.readMcpResult({ ref: result.details.resultRef as string, path: "/content/0/_meta/receipt" }, { outputDirectory: state.outputDirectory });
    expect(JSON.parse(text(readback))).toBe("block-42");
  });

  it("saves unsupported audio/blob files and preserves images and links", async () => {
    const raw = { content: [
      { type: "audio", mimeType: "audio/wav", data: Buffer.from("audio bytes").toString("base64") },
      { type: "resource", resource: { uri: "test://file", mimeType: "application/octet-stream", blob: Buffer.from("blob bytes").toString("base64") } },
      { type: "image", mimeType: "image/png", data: "image" },
      { type: "resource_link", name: "Receipt", uri: "test://receipt" },
    ] };
    const { state } = await fixture(raw);
    const result = await executeCall(state, "demo_echo", {});
    const files = result.details.payloadFiles as output.McpPayloadFile[];
    expect(await Promise.all(files.map(file => readFile(file.path!, "utf8")))).toEqual(["audio bytes", "blob bytes"]);
    expect(text(result)).toContain("not rendered");
    expect(text(result)).toContain("test://receipt");
    expect(result.content).toContainEqual(raw.content[2]);
    const script = await runMcpScript(state, 'const r = await tools.demo_echo({}); return r.ok;');
    expect(text(script)).toContain("MCP audio: audio/wav; not rendered. Saved file:");
    expect(text(script)).toContain("MCP binary resource (test://file): application/octet-stream; not rendered. Saved file:");
  });

  it("reads JSON pointers, fields and bounded pages without losing line boundaries", async () => {
    const raw = { structuredContent: { "a/b": { "~key": Array.from({ length: 4 }, (_, id) => ({ id, extra: "omit" })) } } };
    const { state } = await fixture(raw);
    const result = await executeCall(state, "demo_echo", {});
    const input = { ref: result.details.resultRef as string, path: "/structuredContent/a~1b/~0key", fields: ["id"], limit: 7 };
    let offset = 0;
    let joined = "";
    for (let i = 0; i < 100; i++) {
      const page = await output.readMcpResult({ ...input, offset }, { outputDirectory: state.outputDirectory, maxLines: 1 });
      expect(page.details.error).toBeUndefined();
      joined += page.content[0]!.text;
      if (page.details.nextOffset === null) break;
      expect(page.details.nextOffset).toBeGreaterThan(offset);
      offset = page.details.nextOffset!;
    }
    expect(JSON.parse(joined)).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }]);
    const unknown = await output.readMcpResult({ ...input, path: "/missing" }, { outputDirectory: state.outputDirectory });
    expect(unknown.details.error).toBe("result_read_failed");
    const unrelated = join(state.outputDirectory, "other.txt");
    await writeFile(unrelated, "private host file");
    expect((await output.readMcpResult({ ref: unrelated }, { outputDirectory: state.outputDirectory })).details.error).toBe("result_read_failed");
  });

  it("lists the exact resource descriptor including native metadata", async () => {
    const { state, connection } = await fixture();
    const resource = { name: "notes", uri: "test://notes", title: "Notes", mimeType: "text/plain", _meta: { vendor: "retained" }, icons: [{ src: "https://example.invalid/icon.svg" }] };
    connection.resources = [resource] as any;
    expect((await resources.executeResourceList(state, "demo")).details).toMatchObject({ items: [resource] });
  });

  it("keeps resource policy and legacy aliases while exposing URI reads to scripts", async () => {
    const { state, connection } = await fixture();
    connection.resources = [{ name: "notes", uri: "test://notes" }] as any;
    expect((await resources.executeResourceList(state, "demo")).details).toMatchObject({ items: [{ uri: "test://notes" }] });
    const script = await runMcpScript(state, 'const list = await tools.resources({ server: "demo" }); const read = await tools.readResource({ server: "demo", uri: list.items[0].uri }); return read;');
    expect(JSON.parse(script.content[0].text)).toMatchObject({ ok: true, data: { contents: [{ uri: "test://notes", text: "notes" }] } });
    expect((await executeCall(state, "demo_read_notes")).details.error).toBeUndefined();
    for (const policy of [{ exposeResources: false }, { excludeTools: ["read_notes"] }, { includeTools: ["echo"] }]) {
      state.config.mcpServers.demo = { command: "fixture", ...policy };
      expect((await resources.executeResourceList(state, "demo")).details).toMatchObject({ total: 0 });
      expect((await resources.executeResourceRead(state, "demo", "test://notes")).details.error).toBe("tool_not_found");
    }
    expect(connection.client.readResource).toHaveBeenCalledTimes(2);
  });

  it("scripts describe exact raw schemas and report partial catalog coverage", async () => {
    const { state } = await fixture();
    const descriptor = { name: "demo_echo", originalName: "echo", description: "Echo", title: "Echo value", inputSchema: { type: "object", properties: { value: { type: "string", minLength: 4, description: "Value" } } }, outputSchema: { type: "object", properties: { id: { type: "number" } } }, annotations: { readOnlyHint: true }, _meta: { vendor: "retained" }, execution: { taskSupport: "optional" } };
    state.toolMetadata.set("demo", [descriptor]);
    state.config.mcpServers.unknown = { command: "not contacted" };
    const result = await runMcpScript(state, 'return { found: await tools.describe({ path: "demo_echo" }), search: await tools.search({ query: "Echo" }) };');
    const parsed = JSON.parse(result.content[0].text);
    const { originalName: _originalName, name: _name, ...fields } = descriptor;
    expect(parsed.found).toEqual({ ...fields, name: "echo", path: "demo_echo", server: "demo" });
    expect(parsed.search.coverage).toEqual({ complete: false, knownServers: ["demo"], unknownServers: ["unknown"] });
  });

  it("discovers only the selected uncached server and surfaces authentication failures", async () => {
    const { state, connection } = await fixture();
    state.config.mcpServers.cold = { command: "fixture" };
    state.config.mcpServers.other = { command: "must not connect" };
    state.manager.getConnection = (server: string) => server === "demo" ? connection : undefined;
    state.manager.connect = vi.fn(async () => connection);
    const result = await runMcpScript(state, 'return await tools.search({ query: "Echo", server: "cold" });');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ items: [{ path: "cold_echo" }], coverage: { complete: true, knownServers: ["cold"], unknownServers: [] } });
    expect(state.manager.connect.mock.calls.map((call: unknown[]) => call[0])).toEqual(["cold"]);
    state.toolMetadata.delete("cold");
    state.manager.connect.mockResolvedValue({ status: "needs-auth" });
    const failed = await runMcpScript(state, 'return await tools.search({ query: "Echo", server: "cold" });');
    expect(JSON.parse(failed.content[0].text)).toMatchObject({ error: { code: "auth_required" }, coverage: { complete: false, unknownServers: ["cold"] } });
    expect(failed.details.calls).toMatchObject([{ operation: "search", ok: false, error: "auth_required" }]);
  });

  it("rejects normalized live alias collisions but executes exact original identities", async () => {
    const { state, connection } = await fixture();
    connection.tools = [{ name: "a.b" }, { name: "a_b" }] as any;
    state.toolMetadata.set("demo", [{ name: "demo_a_b", originalName: "a.b", description: "stale single alias" }]);
    expect((await executeCall(state, "demo_a_b", {})).details.error).toBe("ambiguous_tool");
    expect(connection.client.callTool).not.toHaveBeenCalled();
    const script = await runMcpScript(state, 'return await tools.call("a_b", {}, "demo");');
    expect(JSON.parse(script.content[0].text).ok).toBe(true);
    expect(connection.client.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "a_b" }), expect.anything());
  });

  it("keeps same-name resources addressable by URI and rejects the ambiguous legacy alias", async () => {
    const { state, connection } = await fixture();
    connection.resources = [{ name: "notes", uri: "test://one" }, { name: "notes", uri: "test://two" }] as any;
    expect((await resources.executeResourceList(state, "demo")).details).toMatchObject({ total: 2 });
    expect((await executeCall(state, "demo_read_notes")).details.error).toBe("ambiguous_tool");
    expect((await resources.executeResourceRead(state, "demo", "test://two")).details.error).toBeUndefined();
    expect(connection.client.readResource).toHaveBeenCalledWith({ uri: "test://two" }, expect.anything());
  });

  it("keeps structured content beside human content", () => {
    expect(resolveMcpResultContent({ content: [{ type: "text", text: "Done" }], structuredContent: { id: 7 } }))
      .toEqual([{ type: "text", text: "Done" }, { type: "text", text: JSON.stringify({ id: 7 }, null, 2) }]);
  });

  it("does not dispatch an ambiguous unscoped name", async () => {
    const { state, connection } = await fixture();
    state.config.mcpServers.other = { command: "fixture" };
    state.toolMetadata.set("other", [{ name: "demo_echo", originalName: "different", description: "Other" }]);
    expect((await executeCall(state, "demo_echo", {})).details.error).toBe("ambiguous_tool");
    expect(connection.client.callTool).not.toHaveBeenCalled();
  });

  it("direct calls reject removed tools rather than use frozen specs", async () => {
    const { state, connection } = await fixture();
    connection.tools = [];
    const execute = createDirectToolExecutor(() => state, () => null, { serverName: "demo", prefixedName: "demo_echo", originalName: "echo", description: "Stale" });
    expect((await execute("id", {}, undefined, undefined, {} as any)).details.error).toBe("tool_not_found");
    expect(connection.client.callTool).not.toHaveBeenCalled();
  });

  it("preserves raw MCP error payloads in script envelopes", async () => {
    const raw = { isError: true, content: [{ type: "text", text: "Declined" }], structuredContent: { reason: "quota", remaining: 0 } };
    const { state, connection } = await fixture(raw);
    const result = await runMcpScript(state, 'return await tools.demo_echo({});');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, data: raw, error: { code: "tool_error" } });
    expect(connection.client.callTool).toHaveBeenCalledTimes(1);
  });

  it("exposes retained raw JSON through gateway and script readback without another dispatch", async () => {
    const raw = { content: [{ type: "text", text: "Done" }], structuredContent: { rows: [{ id: 1, secret: "omit" }, { id: 2 }] } };
    const { state, connection } = await fixture(raw);
    const result = await executeCall(state, "demo_echo", {});
    const ref = result.details.resultRef as string;
    expect(ref).toEqual(expect.any(String));
    expect(text(result)).toContain(ref);
    expect(JSON.parse(await readFile(ref, "utf8"))).toEqual(raw);
    const page = await output.readMcpResult({ ref, path: "/structuredContent/rows", fields: ["id"] }, { outputDirectory: state.outputDirectory });
    expect(JSON.parse(text(page))).toEqual([{ id: 1 }, { id: 2 }]);
    const script = await runMcpScript(state, `return await tools.readResult({ ref: ${JSON.stringify(ref)}, path: "/structuredContent/rows/1" });`);
    expect(text(script)).toContain('\\"id\\": 2');
    expect(connection.client.callTool).toHaveBeenCalledTimes(1);
  });

  it("reads resources by URI through the same approval and capture path", async () => {
    const { state, connection } = await fixture();
    connection.resources = [{ name: "notes", uri: "test://notes" }] as any;
    state.onToolCall = vi.fn(async () => {});
    const before = vi.fn(async () => {});
    const result = await resources.executeResourceRead(state, "demo", "test://notes", undefined, { toolCallId: "read-1" }, before);
    expect(text(result)).toContain("notes");
    expect(connection.client.readResource).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith(undefined, expect.objectContaining({ resourceUri: "test://notes" }));
    expect(state.onToolCall.mock.calls.map((call: any[]) => call[0].phase)).toEqual(["before", "after"]);
    state.config.settings.approveTools = ["read_notes"];
    expect((await resources.executeResourceRead(state, "demo", "test://notes")).details.error).toBe("approval_required");
    expect(connection.client.readResource).toHaveBeenCalledTimes(1);
  });
});
