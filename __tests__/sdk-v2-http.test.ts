import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SdkErrorCode } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { executeCall } from "../proxy-modes.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { runMcpScript } from "../mcp-code.ts";
import type { McpExtensionState } from "../state.ts";
import { SERVER_STREAM_RESULT_PATCH_METHOD, type ServerEntry } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

type WireRequest = { id?: string | number | null; method?: string; params?: any };
type Exchange = { req: IncomingMessage; res: ServerResponse; body: WireRequest };
const tool = { name: "echo", inputSchema: { type: "object", properties: {} } };
const modern = {
  resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
  instructions: "Local fixture instructions",
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "local-wire", version: "1" } },
};
function result({ res, body }: Exchange, payload: unknown, headers = {}) {
  if (body.method?.endsWith("/list")) payload = { ttlMs: 60_000, cacheScope: "private", ...payload as object };
  res.writeHead(200, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: payload }));
}
function rpcError({ res, body }: Exchange, code: number, status = 200, id = body.id) {
  res.writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "fixture rejection" } }));
}
async function fixture(handler: (exchange: Exchange) => boolean | void | Promise<boolean | void> = () => {}) {
  const requests: Exchange[] = [];
  let sessions = 0;
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const exchange = { req, res, body: data ? JSON.parse(data) : {} };
    requests.push(exchange);
    if (await handler(exchange)) return;
    const { body } = exchange;
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (body.method === "server/discover") return result(exchange, modern);
    if (body.method === "initialize") return result(exchange, {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "legacy", version: "1" },
    }, { "mcp-session-id": `session-${++sessions}` });
    if (body.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    if (body.method === "tools/list") return result(exchange, { resultType: "complete", tools: [tool] });
    if (body.method === "tools/call") return result(exchange, {
      resultType: "complete", content: [{ type: "text", text: "ok" }], structuredContent: body.params?.arguments ?? {},
    });
    rpcError(exchange, -32601);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const calls = () => requests.filter(r => r.body.method === "tools/call");
  const connect = async (options: ServerEntry = {}) => {
    const definition = { url, auth: false as const, requestTimeoutMs: 500, ...options };
    const connection = await manager.connect("local", definition);
    const state = {
      manager, config: { mcpServers: { local: definition }, settings: {} },
      toolMetadata: new Map([["local", [{ name: "local_echo", originalName: "echo", description: "Echo" }]]]),
      failureTracker: new Map(), serverInstructions: new Map(), completedUiSessions: [],
    } as unknown as McpExtensionState;
    return { connection, state };
  };
  return { manager, url, requests, calls, connect };
}

async function call(state: McpExtensionState, entry: string, signal?: AbortSignal) {
  if (entry === "script") {
    const output = await runMcpScript(state, 'return await tools.local_echo({ value: "test" });', 2000, undefined, signal);
    const text = output.content.filter(c => c.type === "text").at(-1);
    return text?.type === "text" ? JSON.parse(text.text) : undefined;
  }
  const output = entry === "direct"
    ? await createDirectToolExecutor(() => state, () => null, {
        serverName: "local", originalName: "echo", prefixedName: "local_echo", description: "Echo",
      })("call-id", { value: "test" }, signal, undefined, {} as any)
    : await executeCall(state, "local_echo", { value: "test" }, undefined, undefined, signal);
  return { ok: output.details.error === undefined, ...output };
}

describe("published SDK v2 over real local HTTP", () => {
  it.each([
    { protocolVersion: "future" }, { retryOnTransportFailure: "true" },
    { oauth: { skipIssuerMetadataValidation: "true" } },
  ])("rejects invalid in-memory protocol options before connecting: %j", async invalid => {
    const f = await fixture();
    await expect(f.connect(invalid as unknown as ServerEntry)).rejects.toThrow(/must be/);
    expect(f.requests).toHaveLength(0);
  });

  it("uses native discovery, wire metadata and nested dynamic parameter headers without legacy traffic", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/list") return;
      result(e, { resultType: "complete", tools: [{ ...tool, inputSchema: {
        type: "object", properties: { nested: { type: "object", properties: {
          region: { type: "string", "x-mcp-header": "Region" },
        } } },
      } }] });
      return true;
    });
    const { connection } = await f.connect();
    await connection.client.callTool({ name: "echo", arguments: { nested: { region: "Hello, 世界" } } });
    expect(connection.client.getProtocolEra()).toBe("modern");
    expect(connection.instructions).toBe("Local fixture instructions");
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
    for (const { req, body } of f.requests) {
      expect(req.method).toBe("POST");
      expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(req.headers["mcp-method"]).toBe(body.method);
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    }
    expect(f.calls()[0].req.headers["mcp-name"]).toBe("echo");
    expect(f.calls()[0].req.headers["mcp-param-region"]).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
  });

  it("leaves HEADER_MISMATCH refresh and fresh request IDs to the SDK", async () => {
    let lists = 0;
    const f = await fixture(e => {
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [{ ...tool, inputSchema: {
          type: "object", properties: { region: { type: "string", "x-mcp-header": ++lists === 1 ? "Old" : "Region" } },
        } }] });
        return true;
      }
      if (e.body.method === "tools/call" && !e.req.headers["mcp-param-region"]) {
        rpcError(e, -32020, 400);
        return true;
      }
    });
    const { connection } = await f.connect({ retryOnTransportFailure: true });
    await connection.client.callTool({ name: "echo", arguments: { region: "west" } });
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
    expect(f.calls()[1].req.headers["mcp-param-region"]).toBe("west");
  });

  it.each([-32601, -32700, -32000, -32020, -32021])("keeps native matched error %s fallback", async code => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      rpcError(e, code);
      return true;
    });
    const { connection } = await f.connect();
    expect(connection.client.getProtocolEra()).toBe("legacy");
    const initializations = f.requests.filter(r => r.body.method === "initialize");
    expect(initializations).toHaveLength(1);
    expect(initializations[0].req.headers["mcp-method"]).toBeUndefined();
    expect(initializations[0].body.params._meta).toBeUndefined();
  });

  it.each(["malformed", "http400"])("keeps native %s discovery fallback", async mode => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      if (mode === "malformed") result(e, {});
      else e.res.writeHead(400).end("legacy endpoint");
      return true;
    });
    expect((await f.connect()).connection.client.getProtocolEra()).toBe("legacy");
  });

  it("reports the native HTTP200 null-ID limitation honestly; explicit legacy works", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      rpcError(e, -32700, 200, null);
      return true;
    });
    await expect(f.connect()).rejects.toMatchObject({ code: SdkErrorCode.EraNegotiationFailed });
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover"]);
    expect((await f.connect({ protocolVersion: "legacy" })).connection.status).toBe("connected");
    expect(f.requests.filter(r => r.body.method === "initialize")).toHaveLength(1);
  });

  it.each([401, 403, 500, "network", "timeout"])("never chooses SSE or legacy for discovery %s", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      if (failure === "network") e.req.socket.destroy();
      else if (failure !== "timeout") e.res.writeHead(failure).end("unavailable");
      return true;
    });
    const code = failure === 401 ? SdkErrorCode.ClientHttpAuthentication
      : failure === 403 ? SdkErrorCode.ClientHttpForbidden
      : failure === "timeout" ? SdkErrorCode.RequestTimeout : SdkErrorCode.EraNegotiationFailed;
    await expect(f.connect({ requestTimeoutMs: 35 })).rejects.toMatchObject({ code });
    expect(f.manager.getConnection("local")).toBeUndefined();
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover"]);
  });

  it.each(["direct", "proxy", "script"])("uses one same-client fresh transport retry through %s", async entry => {
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.req.socket.destroy();
        return true;
      }
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, entry);
    expect(output.ok).toBe(true);
    expect(f.manager.getConnection("local")?.client).toBe(connection.client);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
    expect(f.requests.filter(r => r.body.method === "server/discover")).toHaveLength(1);
    expect(connection.inFlight).toBe(0);
  });

  it.each([undefined, false])("does not retry unless opted in (%s)", async retryOnTransportFailure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.req.socket.destroy(); return true;
    });
    const { state } = await f.connect({ ...(retryOnTransportFailure !== undefined ? { retryOnTransportFailure } : {}) });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["network", "http503"])("stops after the second %s failure", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      if (failure === "network") e.req.socket.destroy();
      else e.res.writeHead(503).end("service unavailable");
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(2);
  });

  it.each(["plain", "json"])("retries a tool HTTP503 %s response once", async body => {
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.res.writeHead(503).end(body === "plain" ? "service unavailable" : JSON.stringify({ error: "unavailable" })); return true;
      }
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(new Set(f.calls().map(c => c.body.id)).size).toBe(2);
  });

  it.each(["protocol", "http503-rpc", "http503-null-id", "tool", "invalid-json"])("does not retry %s errors", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      if (failure === "tool") result(e, { resultType: "complete", isError: true, content: [] });
      else if (failure === "invalid-json") e.res.writeHead(200, { "content-type": "application/json" }).end("not json");
      else rpcError(e, -32602, failure === "protocol" ? 200 : 503, failure === "http503-null-id" ? null : e.body.id);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it("preserves streaming cancellation and trace identity without a cancellation POST", async () => {
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": waiting\n\n");
      e.res.on("close", () => { closed = true; });
      return true;
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-trace-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(directory, "trace.jsonl") });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    expect(connection.transport.hasPerRequestStream).toBe(true);
    const controller = new AbortController();
    const pending = call(state, "proxy", controller.signal);
    await expect.poll(() => f.calls().length).toBe(1);
    controller.abort(new Error("caller cancelled"));
    expect((await pending).details.error).toBe("aborted");
    await expect.poll(() => closed).toBe(true);
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.some(r => r.body.method === "notifications/cancelled" || r.req.method === "GET")).toBe(false);
    await f.manager.closeAll();
    const trace = await readFile(join(directory, "trace.jsonl"), "utf8");
    expect(trace).toContain('"method":"tools/call"');
    expect(trace).not.toContain('"value":"test"');
  });

  it("keeps an absolute deadline across retry and does not label it caller cancellation", async () => {
    const f = await fixture(async e => {
      if (e.body.method !== "tools/call") return;
      if (f.calls().length === 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        e.req.socket.destroy();
      }
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 160, retryOnTransportFailure: true });
    const started = performance.now();
    const output = await call(state, "proxy");
    expect(output.details.error).toBe("call_failed");
    expect(performance.now() - started).toBeLessThan(240);
    expect(f.calls()).toHaveLength(2);
  });

  it("does not rerun an expired deadline or an ambiguous stream timeout", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": waiting\n\n");
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 40, retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it("does not stack modern retries after legacy session recovery", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(f.calls().length === 1 ? 404 : 503).end("session unavailable");
      return true;
    });
    const { state } = await f.connect({ protocolVersion: "legacy", retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(2);
    expect(f.requests.filter(r => r.body.method === "initialize")).toHaveLength(2);
  });

  it("delivers a chunked modern POST SSE result and adapter stream notifications", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: { streamToken: "stream", result: { content: [{ type: "text", text: "partial" }] } },
      })}\n\n`);
      const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id,
        result: { resultType: "complete", content: [{ type: "text", text: "streamed" }] },
      })}\n\n`;
      e.res.write(frame.slice(0, 30));
      setTimeout(() => e.res.end(frame.slice(30)), 5);
      return true;
    });
    const { state } = await f.connect();
    const patches: unknown[] = [];
    f.manager.registerUiStreamListener("stream", (_name, patch) => patches.push(patch));
    const output = await call(state, "proxy");
    expect(output.ok).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "streamed" }]);
    expect(patches).toEqual([{ streamToken: "stream", result: { content: [{ type: "text", text: "partial" }] } }]);
    expect(f.requests.every(r => r.req.method === "POST")).toBe(true);
  });

  it("refreshes modern catalogs through the native POST subscription and closes it on shutdown", async () => {
    let stream: ServerResponse;
    let subscriptionId: WireRequest["id"];
    let lists = 0;
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method === "server/discover") {
        result(e, { ...modern, capabilities: { tools: { listChanged: true } } });
        return true;
      }
      if (e.body.method === "subscriptions/listen") {
        stream = e.res;
        subscriptionId = e.body.id;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
          params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId }, notifications: { toolsListChanged: true } },
        })}\n\n`);
        e.res.on("close", () => { closed = true; });
        return true;
      }
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [{ ...tool, name: ++lists === 1 ? "before" : "after" }] });
        return true;
      }
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-subscription-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(directory, "trace.jsonl") });
    const { connection } = await f.connect();
    expect(connection.tools[0].name).toBe("before");
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } },
    })}\n\n`);
    await expect.poll(() => connection.tools[0].name).toBe("after");
    expect(f.requests.filter(r => r.body.method === "subscriptions/listen")).toHaveLength(1);
    expect(f.requests.some(r => r.req.method === "GET")).toBe(false);
    await f.manager.closeAll();
    await expect.poll(() => closed).toBe(true);
  });

  it("preserves native multi-round-trip state and fresh IDs", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call" || f.calls().length > 1) return;
      result(e, { resultType: "input_required", requestState: "opaque-state", inputRequests: {} });
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[1].body.params.requestState).toBe("opaque-state");
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
  });

  it.each([404, 405, 406, 415])("connects deprecated SSE only after HTTP%s endpoint rejection", async status => {
    let stream: ServerResponse;
    const f = await fixture(e => {
      if (e.req.url === "/mcp" && e.req.method === "POST") { e.res.writeHead(status).end(); return true; }
      if (e.req.url === "/mcp" && e.req.method === "GET") {
        stream = e.res;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write("event: endpoint\ndata: /messages\n\n");
        return true;
      }
      if (e.req.url !== "/messages") return;
      if (e.body.id !== undefined) {
        const payload = e.body.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1" } }
          : e.body.method === "tools/list" ? { tools: [tool] } : { content: [{ type: "text", text: "ok" }] };
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id, result: payload })}\n\n`);
      }
      e.res.writeHead(202).end();
      return true;
    });
    const { state, connection } = await f.connect();
    expect(connection.client.getProtocolEra()).toBe("legacy");
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.requests.filter(r => r.req.method === "GET")).toHaveLength(1);
    expect(f.requests.filter(r => r.req.url === "/messages" && r.body.method === "initialize")).toHaveLength(1);
  });

  it("closes an in-flight native discover request when connect is cancelled", async () => {
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      e.res.on("close", () => { closed = true; });
      return true;
    });
    const controller = new AbortController();
    const pending = f.manager.connect("local", { url: f.url, auth: false }, controller.signal);
    const rejection = expect(pending).rejects.toThrow("cancel discovery");
    await expect.poll(() => f.requests.length).toBe(1);
    controller.abort(new Error("cancel discovery"));
    await rejection;
    await expect.poll(() => closed).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["direct", "proxy", "script"])("preserves null structured content through %s", async entry => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      result(e, { resultType: "complete", content: [], structuredContent: null });
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 500.5 });
    const output = await call(state, entry);
    expect(output.ok, JSON.stringify(output)).toBe(true);
    if (entry === "script") expect(output.data.structuredContent).toBeNull();
    else expect(output.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("preserves catalogs longer than the native default 64-page cap", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/list") return;
      const page = Number(e.body.params?.cursor ?? 0);
      result(e, { resultType: "complete", tools: [{ ...tool, name: `tool-${page}` }], ...(page < 65 ? { nextCursor: String(page + 1) } : {}) });
      return true;
    });
    expect((await f.connect()).connection.tools).toHaveLength(66);
  });
});
