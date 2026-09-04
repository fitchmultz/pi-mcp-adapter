import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery } from "../session-recovery.ts";
import { clearFailure } from "../init.ts";
import { executeCall } from "../proxy-modes.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import type { McpExtensionState } from "../state.ts";
import type { ServerDefinition } from "../types.ts";

const auth = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../mcp-auth-flow.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../mcp-auth-flow.ts")>(),
  authenticate: auth.authenticate,
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type Exchange = { req: IncomingMessage; res: ServerResponse; body: { id?: number; method?: string; params?: any } };
const tools = ["effect", "trigger", "A", "B", "C"].map(name => ({ name, inputSchema: { type: "object" } }));
const content = (text: string) => ({ content: [{ type: "text", text }] });
function result(e: Exchange, value: unknown, headers = {}) {
  e.res.writeHead(200, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", id: e.body.id, result: value }));
}

async function fixture(handler: (e: Exchange) => boolean | void = () => {}) {
  const requests: Exchange[] = [];
  const executions: string[] = [];
  let sessions = 0;
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const e: Exchange = { req, res, body: data ? JSON.parse(data) : {} };
    requests.push(e);
    if (handler(e)) return;
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE" || e.body.method?.startsWith("notifications/")) { res.writeHead(202).end(); return; }
    if (e.body.method === "initialize") {
      result(e, { protocolVersion: "2025-06-18", capabilities: {
        tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true },
      }, serverInfo: { name: "lifetime", version: "1" } }, { "mcp-session-id": `session-${++sessions}` });
      return;
    }
    if (e.body.method === "tools/list") return result(e, { tools });
    if (e.body.method === "resources/list") return result(e, { resources: [{ name: "document", uri: "test://document" }] });
    if (e.body.method === "prompts/list") return result(e, { prompts: [{ name: "prompt" }] });
    if (e.body.method === "resources/read") return result(e, { contents: [{ uri: e.body.params.uri, text: "document" }] });
    if (e.body.method === "prompts/get") return result(e, { messages: [{ role: "user", content: { type: "text", text: "prompt" } }] });
    if (e.body.method === "tools/call") {
      executions.push(e.body.params.name);
      return result(e, content(e.body.params.name));
    }
    res.writeHead(500).end("unexpected request");
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
  const definition: ServerDefinition = { url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "legacy", auth: false, requestTimeoutMs: 2000 };
  const state = {
    manager, config: { mcpServers: { local: definition }, settings: {} },
    toolMetadata: new Map([["local", tools.map(t => ({ name: `local_${t.name}`, originalName: t.name, description: t.name }))]]),
    serverInstructions: new Map(), failureTracker: new Map(), completedUiSessions: [],
  } as unknown as McpExtensionState;
  const calls = (name: string) => requests.filter(e => e.body.method === "tools/call" && e.body.params.name === name);
  const call = (name: string, signal?: AbortSignal) => withSessionRecovery(
    { manager, config: state.config, signal }, "local",
    connection => connection.client.callTool({ name }, manager.getRequestOptions("local", signal)),
  );
  return { manager, state, definition, requests, executions, calls, call, sessions: () => sessions };
}

function oauthMetadata(e: Exchange, url: string): boolean {
  const origin = new URL(url).origin;
  if (e.req.url?.startsWith("/.well-known/oauth-protected-resource")) {
    e.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: url, authorization_servers: [origin] }));
    return true;
  }
  if (e.req.url?.startsWith("/.well-known/oauth-authorization-server")) {
    e.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    }));
    return true;
  }
  return false;
}

// The server has already executed the effect and sent 200 before expiry; only its body tail is held.
function holdAccepted(e: Exchange) {
  e.res.writeHead(200, { "content-type": "application/json", "x-accepted-effect": "yes" });
  e.res.write(`{"jsonrpc":"2.0","id":${e.body.id},"result":`);
  return () => e.res.end(`${JSON.stringify(content("effect"))}}`);
}
function observeAcceptedHeaders() {
  const received = gate();
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const response = await nativeFetch(...args);
    if (response.headers.has("x-accepted-effect")) received.resolve();
    return response;
  });
  return received.promise;
}

// Attach rejection handlers immediately, including on deliberately interrupted requests.
const settle = <T>(promise: Promise<T>) => Promise.allSettled([promise]).then(([outcome]) => outcome);

describe("native session replacement lifetime", () => {
  it("preserves an accepted response without replaying its effect", async () => {
    const headers = observeAcceptedHeaders();
    let release = () => {};
    let expired = false;
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && e.body.params.name === "effect" && f.calls("effect").length === 1) {
        f.executions.push("effect"); release = holdAccepted(e); return true;
      }
      if (expired && e.req.headers["mcp-session-id"] === "session-1") {
        e.res.writeHead(404).end("Session not found"); return true;
      }
      if (e.body.method === "initialize" && expired) release();
    });
    const old = await f.manager.connect("local", f.definition);
    const close = vi.spyOn(old.client, "close");
    const effect = settle(f.call("effect"));
    await headers;
    expired = true;
    const trigger = settle(f.call("trigger"));
    expect(await effect).toMatchObject({ status: "fulfilled", value: content("effect") });
    expect(await trigger).toMatchObject({ status: "fulfilled", value: content("trigger") });
    expect(f.executions.filter(name => name === "effect")).toHaveLength(1);
    expect(f.calls("effect")).toHaveLength(1);
    expect(f.calls("trigger")).toHaveLength(2);
    expect(f.executions).toEqual(["effect", "trigger"]);
    expect(f.sessions()).toBe(2);
    await expect.poll(() => close.mock.calls.length).toBe(1);
  });

  it("recovers three independently rejected requests through one fresh session", async () => {
    const held: Exchange[] = [];
    let expired = false;
    const f = await fixture(e => {
      if (expired && e.req.headers["mcp-session-id"] === "session-1" && e.body.method === "tools/call") {
        if (e.body.params.name === "C") e.res.writeHead(404).end("Session not found");
        else held.push(e);
        return true;
      }
      if (e.body.method === "initialize" && expired) for (const pending of held) pending.res.writeHead(404).end("Session not found");
    });
    await f.manager.connect("local", f.definition);
    expired = true;
    const a = settle(f.call("A"));
    const b = settle(f.call("B"));
    await expect.poll(() => held.length).toBe(2);
    const c = settle(f.call("C"));
    for (const pending of [a, b, c]) expect(await pending).toMatchObject({ status: "fulfilled" });
    for (const name of ["A", "B", "C"]) {
      expect(f.calls(name)).toHaveLength(2);
      expect(f.executions.filter(n => n === name)).toHaveLength(1);
    }
    expect(f.sessions()).toBe(2);
  });

  it("joins a closed placeholder before dispatch while fresh initialization is pending", async () => {
    let initialization: Exchange | undefined;
    const f = await fixture(e => {
      if (e.body.method === "initialize" && f.sessions() === 1) { initialization = e; return true; }
    });
    const old = await f.manager.connect("local", f.definition);
    const replacing = settle(f.manager.reconnect("local", f.definition, old));
    await expect.poll(() => initialization).toBeDefined();
    const pending = settle(f.call("effect"));
    expect(f.manager.getConnection("local")?.status).toBe("closed");
    expect(f.calls("effect")).toHaveLength(0);
    result(initialization!, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fresh", version: "1" } }, { "mcp-session-id": "session-2" });
    expect(await replacing).toMatchObject({ status: "fulfilled" });
    expect(await pending).toMatchObject({ status: "fulfilled" });
    expect(f.calls("effect")).toHaveLength(1);
    expect(f.calls("effect")[0].req.headers["mcp-session-id"]).toBe("session-2");
  });

  it.each(["tool", "resource"])("drains a complete %s operation started before its first native request", async kind => {
    const f = await fixture();
    const old = await f.manager.connect("local", f.definition);
    const request = vi.spyOn(old.client, "request");
    const operation = settle(kind === "tool"
      ? old.client.callTool({ name: "effect" })
      : old.client.readResource({ uri: "test://document" }));
    expect(request).not.toHaveBeenCalled();
    const replacing = settle(f.manager.reconnect("local", f.definition, old));
    expect(await operation).toMatchObject({ status: "fulfilled" });
    expect(await replacing).toMatchObject({ status: "fulfilled" });
    const sent = f.requests.find(e => e.body.method === (kind === "tool" ? "tools/call" : "resources/read"));
    expect(sent?.req.headers["mcp-session-id"]).toBe("session-1");
  });

  it("owns manager prompt and resource operations and transfers the current idle count", async () => {
    const held: Exchange[] = [];
    let discovery: Exchange | undefined;
    const f = await fixture(e => {
      if (["prompts/get", "resources/read"].includes(e.body.method ?? "")) { held.push(e); return true; }
      if (e.body.method === "tools/list" && e.req.headers["mcp-session-id"] === "session-2") { discovery = e; return true; }
    });
    const old = await f.manager.connect("local", f.definition);
    const prompt = settle(f.manager.getPrompt("local", "prompt"));
    const resource = settle(f.manager.readResource("local", "test://document"));
    await expect.poll(() => held.length).toBe(2);
    expect(old.inFlight).toBe(2);
    const replacing = settle(f.manager.reconnect("local", f.definition, old));
    await expect.poll(() => discovery).toBeDefined();
    for (const e of held) result(e, e.body.method === "prompts/get"
      ? { messages: [{ role: "user", content: { type: "text", text: "prompt" } }] }
      : { contents: [{ uri: "test://document", text: "document" }] });
    expect(await prompt).toMatchObject({ status: "fulfilled" });
    expect(await resource).toMatchObject({ status: "fulfilled" });
    expect(old.inFlight).toBe(0);
    result(discovery!, { tools });
    expect(await replacing).toMatchObject({ status: "fulfilled" });
    expect(f.manager.getConnection("local")?.inFlight).toBe(0);
  });

  it.each(["tools", "resources", "prompts"])("drains native paginated %s/list_changed without publishing stale metadata", async catalog => {
    let stream: ServerResponse | undefined;
    let refresh: Exchange | undefined;
    let page: Exchange | undefined;
    let refreshing = false;
    const f = await fixture(e => {
      if (e.req.method === "GET" && e.req.headers["mcp-session-id"] === "session-1") {
        stream = e.res; e.res.writeHead(200, { "content-type": "text/event-stream" }); e.res.write(": ready\n\n"); return true;
      }
      if (refreshing && e.body.method === `${catalog}/list` && e.req.headers["mcp-session-id"] === "session-1") {
        if (e.body.params?.cursor) page = e;
        else refresh = e;
        return true;
      }
    });
    const old = await f.manager.connect("local", f.definition);
    const close = vi.spyOn(old.client, "close");
    const metadata = vi.fn();
    f.manager.setMetadataListChangedListener(metadata);
    await expect.poll(() => stream).toBeDefined();
    refreshing = true;
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/${catalog}/list_changed` })}\n\n`);
    await expect.poll(() => refresh).toBeDefined();
    const fresh = await f.manager.reconnect("local", f.definition, old);
    expect(close).not.toHaveBeenCalled();
    result(refresh!, { [catalog]: [], nextCursor: "page-2" });
    await expect.poll(() => page).toBeDefined();
    expect(close).not.toHaveBeenCalled();
    result(page!, { [catalog]: [] });
    await expect.poll(() => close.mock.calls.length).toBe(1);
    expect(f.manager.getConnection("local")).toBe(fresh);
    expect(fresh[catalog as "tools" | "resources" | "prompts"].length).toBeGreaterThan(0);
    expect(metadata).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline"])("keeps shared replacement alive after one caller's %s", async cancellation => {
    let discovery: Exchange | undefined;
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && e.req.headers["mcp-session-id"] === "session-1") {
        f.definition.requestTimeoutMs = 2000;
        e.res.writeHead(404).end("Session not found"); return true;
      }
      if (e.body.method === "tools/list" && e.req.headers["mcp-session-id"] === "session-2") { discovery = e; return true; }
    });
    await f.manager.connect("local", f.definition);
    if (cancellation === "deadline") f.definition.requestTimeoutMs = 300;
    const controller = new AbortController();
    const first = executeCall(f.state, "local_trigger", {}, "local", undefined, controller.signal);
    await expect.poll(() => discovery).toBeDefined();
    f.definition.requestTimeoutMs = 2000;
    const second = executeCall(f.state, "local_effect", {}, "local");
    if (cancellation === "abort") controller.abort(new Error("caller stopped waiting"));
    expect((await first).details.error).toBe(cancellation === "abort" ? "aborted" : "call_failed");
    result(discovery!, { tools });
    expect((await second).details.error).toBeUndefined();
    expect(f.calls("trigger")).toHaveLength(1);
    expect(f.calls("effect")).toHaveLength(1);
    expect(f.sessions()).toBe(2);
    expect(f.manager.getConnection("local")?.inFlight).toBe(0);
  });

  it.each([
    ["close", "discovery"], ["closeAll", "discovery"], ["owner", "discovery"],
    ["close", "ready"], ["closeAll", "ready"], ["owner", "ready"],
  ])("%s interrupts accepted old work and a %s replacement exactly once", async (cleanup, phase) => {
    const headers = observeAcceptedHeaders();
    let discovery: Exchange | undefined;
    const f = await fixture(e => {
      if (e.body.method === "tools/call") { holdAccepted(e); return true; }
      if (e.body.method === "tools/list" && e.req.headers["mcp-session-id"] === "session-2") { discovery = e; return true; }
    });
    const owner = createMcpRuntimeOwner();
    f.manager.setRuntimeSignal(owner.signal);
    const lifecycle = new McpLifecycleManager(f.manager);
    owner.addCleanup(() => lifecycle.gracefulShutdown());
    const old = await f.manager.connect("local", f.definition);
    const closes = vi.spyOn(Client.prototype, "close");
    const effect = settle(old.client.callTool({ name: "effect" }, { timeout: 2000 }));
    await headers;
    const replacing = settle(f.manager.reconnect("local", f.definition, old));
    await expect.poll(() => discovery).toBeDefined();
    if (phase === "ready") {
      result(discovery!, { tools });
      expect(await replacing).toMatchObject({ status: "fulfilled" });
    }
    const waiting = phase === "discovery" ? settle(f.call("trigger")) : undefined;
    const started = performance.now();
    if (cleanup === "owner") await owner.stop("reload");
    else if (cleanup === "close") await f.manager.close("local");
    else await f.manager.closeAll();
    expect(await effect).toMatchObject({ status: "rejected" });
    expect(performance.now() - started).toBeLessThan(750);
    if (phase === "discovery") {
      expect(await replacing).toMatchObject({ status: "rejected" });
      expect(await waiting).toMatchObject({ status: "rejected" });
      result(discovery!, { tools });
    }
    expect(f.manager.getConnection("local")).toBeUndefined();
    expect(closes).toHaveBeenCalledTimes(2);
    expect(new Set(closes.mock.contexts).size).toBe(2);
    expect(closes.mock.contexts).toContain(old.client);
    expect(f.calls("trigger")).toHaveLength(0);
    await expect(f.manager.reconnect("local", f.definition, old)).rejects.toThrow();
    expect(f.manager.getConnection("local")).toBeUndefined();
    expect(f.sessions()).toBe(2);
  });

  it("does not connect after closeAll while waiting for an earlier close", async () => {
    const f = await fixture();
    const old = await f.manager.connect("local", f.definition);
    const release = gate();
    const nativeClose = old.client.close.bind(old.client);
    vi.spyOn(old.client, "close").mockImplementation(async () => { await release.promise; await nativeClose(); });
    const closing = f.manager.close("local");
    const connecting = settle(f.manager.connect("local", f.definition));
    const stopping = f.manager.closeAll();
    release.resolve();
    await closing;
    await stopping;
    expect(await connecting).toMatchObject({ status: "rejected" });
    expect(f.sessions()).toBe(1);
    expect(f.manager.getConnection("local")).toBeUndefined();
  });

  it("waits for disposal when close wins after native discovery but before publication", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "initialize") return;
      result(e, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "setup", version: "1" } }, { "mcp-session-id": "session-1" });
      return true;
    });
    const release = gate();
    const disposing = gate();
    const listTools = Client.prototype.listTools;
    let closing: Promise<void> | undefined;
    let closed = false;
    vi.spyOn(Client.prototype, "listTools").mockImplementation(function (...args) {
      return listTools.apply(this, args).then(value => {
        closing = f.manager.close("local").then(() => { closed = true; });
        return value;
      });
    });
    const nativeClose = Client.prototype.close;
    const close = vi.spyOn(Client.prototype, "close").mockImplementation(async function () {
      disposing.resolve();
      await release.promise;
      await nativeClose.call(this);
    });
    const connecting = settle(f.manager.connect("local", f.definition));
    try {
      await disposing.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally {
      release.resolve();
      await closing;
    }
    expect(await connecting).toMatchObject({ status: "rejected" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.manager.getConnection("local")).toBeUndefined();
  });

  it("reports failed retirement on explicit cleanup without replacing a successful result or disposing twice", async () => {
    const f = await fixture();
    const cleanup = cleanups.pop()!;
    const old = await f.manager.connect("local", f.definition);
    const nativeClose = old.client.close.bind(old.client);
    const close = vi.spyOn(old.client, "close").mockImplementation(async () => {
      await nativeClose();
      throw new Error("fixture cleanup failure");
    });
    try {
      const effect = settle(f.call("effect"));
      await f.manager.reconnect("local", f.definition, old);
      expect(await effect).toMatchObject({ status: "fulfilled" });
      await expect.poll(() => close.mock.calls.length).toBe(1);
      await expect(f.manager.close("local")).rejects.toThrow("MCP connection cleanup failed");
      expect(f.manager.getConnection("local")).toBeUndefined();
      await expect(f.manager.closeAll()).rejects.toThrow("MCP manager cleanup failed");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup().catch(() => {}); // This test deliberately retains a reported cleanup failure.
    }
  });

  it.each(["direct", "proxy-cached", "proxy-named", "proxy-prefix"])("reports and records initial post-auth setup failure via %s without retrying", async entry => {
    let authorized = false;
    let attempts = 0;
    const f = await fixture(e => {
      if (oauthMetadata(e, f.definition.url!)) return true;
      if (e.body.method !== "initialize") return;
      attempts++;
      if (authorized) e.res.writeHead(503).end("fixture setup unavailable");
      else e.res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${new URL(f.definition.url!).origin}/.well-known/oauth-protected-resource/mcp"` }).end();
      return true;
    });
    f.definition.auth = "oauth";
    f.definition.oauth = { clientId: "local-failure", redirectUri: "http://127.0.0.1:19878/callback" };
    f.state.config.settings!.autoAuth = true;
    f.state.ui = { setStatus: vi.fn() } as any;
    f.state.failureMessages = new Map();
    cleanups.push(async () => { clearFailure(f.state, "local"); });
    auth.authenticate.mockReset().mockImplementation(async () => { authorized = true; return "authenticated"; });
    expect((await f.manager.connect("local", f.definition)).status).toBe("needs-auth");
    if (entry === "proxy-named" || entry === "proxy-prefix") f.state.toolMetadata.clear();
    const pending = entry === "direct"
      ? createDirectToolExecutor(() => f.state, () => null, {
          serverName: "local", originalName: "effect", prefixedName: "local_effect", description: "effect",
        })("call", {}, undefined, undefined, {} as any)
      : executeCall(f.state, "local_effect", {}, entry === "proxy-prefix" ? undefined : "local");
    const output = await pending;
    expect(output.details.error).toBe(entry === "direct" ? "server_unavailable"
      : entry === "proxy-cached" ? "connect_failed" : entry === "proxy-named" ? "server_backoff" : "tool_not_found");
    expect(f.state.failureTracker.has("local")).toBe(true);
    expect(f.state.failureMessages.get("local")).toContain("fixture setup unavailable");
    expect(attempts).toBe(2);
    expect(f.calls("effect")).toHaveLength(0);
  });

  it.each(["authenticate", "missing callback", "abort", "shutdown"])("handles a native needs-auth record before dispatch: %s", async mode => {
    let authorized = false;
    let attempts = 0;
    const f = await fixture(e => {
      if (oauthMetadata(e, f.definition.url!)) return true;
      if (e.body.method !== "initialize") return;
      attempts++;
      if (authorized) return;
      e.res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${new URL(f.definition.url!).origin}/.well-known/oauth-protected-resource/mcp"` }).end();
      return true;
    });
    f.definition.auth = "oauth";
    f.definition.oauth = { clientId: "local-readiness", redirectUri: "http://127.0.0.1:19878/callback" };
    const needsAuth = await f.manager.connect("local", f.definition);
    expect(needsAuth.status).toBe("needs-auth");
    const consent = gate();
    const controller = new AbortController();
    const onNeedsAuth = vi.fn(async () => {
      await consent.promise;
      authorized = true;
      return f.manager.reconnect("local", f.definition, needsAuth, controller.signal);
    });
    const dispatch = vi.fn(connection => connection.client.callTool({ name: "effect" }));
    const pending = settle(withSessionRecovery({
      manager: f.manager, config: f.state.config, signal: controller.signal,
      ...(mode === "missing callback" ? {} : { onNeedsAuth }),
    }, "local", dispatch));
    if (mode !== "missing callback") {
      await vi.waitFor(() => expect(onNeedsAuth).toHaveBeenCalledTimes(1));
      expect(dispatch).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
      if (mode === "abort") controller.abort(new Error("caller cancelled auth wait"));
      if (mode === "shutdown") await f.manager.closeAll();
      consent.resolve();
    }
    const outcome = await pending;
    if (mode === "authenticate") {
      expect(outcome).toMatchObject({ status: "fulfilled", value: content("effect") });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(f.manager.getConnection("local"));
      expect(attempts).toBe(2);
    } else {
      expect(outcome).toMatchObject({ status: "rejected" });
      if (mode === "missing callback" && outcome?.status === "rejected") expect(outcome.reason).toBeInstanceOf(SessionRecoveryAuthRequiredError);
      expect(dispatch).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
    }
  });

  it.each(["proxy", "direct"])("keeps an accepted effect through automatic post-expiry auth via %s", async entry => {
    const headers = observeAcceptedHeaders();
    let release = () => {};
    let expired = false;
    let authorized = false;
    let challenges = 0;
    const f = await fixture(e => {
      const origin = new URL(f.definition.url!).origin;
      if (oauthMetadata(e, f.definition.url!)) return true;
      if (e.body.method === "initialize" && expired) {
        if (!authorized) {
          challenges++;
          e.res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return true;
        }
        release();
      }
      if (expired && e.req.headers["mcp-session-id"] === "session-1" && e.body.method === "tools/call") {
        e.res.writeHead(404).end("Session not found"); return true;
      }
      if (e.body.method === "tools/call" && e.body.params.name === "effect" && f.calls("effect").length === 1) {
        f.executions.push("effect"); release = holdAccepted(e); return true;
      }
    });
    f.definition.auth = "oauth";
    f.definition.oauth = { clientId: "local-lifetime", redirectUri: "http://127.0.0.1:19878/callback" };
    f.state.config.settings!.autoAuth = true;
    f.state.ui = { setStatus: vi.fn() } as any;
    auth.authenticate.mockReset().mockImplementation(async () => { authorized = true; return "authenticated"; });
    await f.manager.connect("local", f.definition);
    const fullClose = vi.spyOn(f.manager, "close");
    const call = (name: string) => entry === "proxy"
      ? executeCall(f.state, `local_${name}`, {}, "local")
      : createDirectToolExecutor(() => f.state, () => null, {
          serverName: "local", originalName: name, prefixedName: `local_${name}`, description: name,
        })("call", {}, undefined, undefined, {} as any);
    const effect = call("effect");
    await headers;
    expired = true;
    const trigger = call("trigger");
    expect((await effect).details.error).toBeUndefined();
    expect((await trigger).details.error).toBeUndefined();
    expect(fullClose).not.toHaveBeenCalled();
    expect(challenges).toBe(1);
    expect(f.sessions()).toBe(2);
    expect(f.calls("effect")).toHaveLength(1);
    expect(f.calls("trigger")).toHaveLength(2);
    expect(f.executions).toEqual(["effect", "trigger"]);
  });
});
