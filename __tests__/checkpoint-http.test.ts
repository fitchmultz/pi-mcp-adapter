import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";
import { initializeMcp } from "../init.ts";
import { prepareMcpCheckpoint, type McpCheckpointEvent } from "../checkpoint.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { getAuthForUrl, saveAuthEntry, updateTokens } from "../mcp-auth.ts";
import { startAuth, hasPendingAuth } from "../mcp-auth-flow.ts";
import { runMcpScript } from "../mcp-code.ts";
import { McpTraceWriter } from "../mcp-trace.ts";
import type { McpConfig } from "../types.ts";

let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-checkpoint-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function hold() {
  const controller = new AbortController();
  const invalidate = vi.fn(() => controller.abort(new Error("late adapter activity")));
  const event: McpCheckpointEvent = { boundary: "settled", signal: controller.signal, invalidate };
  return { event, invalidate, release: () => controller.abort() };
}
function host() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => handlers.delete(name); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
    registerFlag: () => {}, registerCommand: () => {}, getFlag: () => undefined,
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    events: { emit: () => {} },
  };
  const ctx = { cwd: directory, mode: "print", hasUI: false, isProjectTrusted: () => true, modelRegistry: {} };
  return { pi: pi as any, ctx: ctx as any, handlers, tools };
}
async function wire(options: { oauth?: boolean; capabilities?: object; session?: boolean; legacy?: boolean } = {}) {
  let origin = "";
  let token = "SYNTHETIC-INITIAL";
  let delayMethod: string | undefined;
  let blocked: ReturnType<typeof deferred> | undefined;
  let started = false;
  let callCount = 0;
  let refreshCount = 0;
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: origin + "/mcp", authorization_servers: [origin] })); return;
    }
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] })); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const method = req.url === "/token" ? "token" : JSON.parse(text).method;
    methods.push(method);
    if (method === delayMethod) { started = true; await blocked!.promise; }
    if (method === "token") {
      refreshCount++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, refresh_token: "SYNTHETIC-REFRESH-UPDATED", token_type: "Bearer", expires_in: 3600 })); return;
    }
    if (options.oauth && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    const body = JSON.parse(text);
    if (method === "notifications/initialized") { res.writeHead(202).end(); return; }
    if (method === "tools/call") callCount++;
    const result = method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: options.capabilities ?? { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
      : method === "server/discover"
      ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: options.capabilities ?? { tools: {} } }
      : method === "tools/list"
        ? { resultType: "complete", ttlMs: 1000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : { resultType: "complete", content: [{ type: "text", text: "SYNTHETIC-OK" }] };
    res.writeHead(200, { "content-type": "application/json", ...(options.session ? { "mcp-session-id": "synthetic-session" } : {}) }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { blocked?.resolve(); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); });
  const name = "fixture-" + crypto.randomUUID();
  const url = origin + "/mcp";
  const definition = { url, auth: options.oauth ? "oauth" as const : false as const, requestTimeoutMs: 3000,
    ...(options.legacy || options.session ? { protocolVersion: "legacy" as const } : {}),
    ...(options.oauth ? { oauth: { clientId: "SYNTHETIC-CLIENT", clientSecret: "SYNTHETIC-CLIENT-SECRET" } } : {}) };
  const config: McpConfig = { mcpServers: { [name]: definition }, settings: { toolPrefix: "none", sampling: false, elicitation: false, trace: { enabled: true, file: join(directory, "trace.jsonl") } } };
  if (options.oauth) saveAuthEntry(name, { tokens: { accessToken: token, refreshToken: "SYNTHETIC-REFRESH", expiresAt: Date.now() / 1000 + 3600, issuer: origin } }, url);
  return { name, url, origin, config, definition, methods, calls: () => callCount, refreshes: () => refreshCount,
    delay: (method: string) => { delayMethod = method; blocked = deferred(); started = false; },
    started: () => started,
    release: () => { delayMethod = undefined; blocked?.resolve(); },
    expire: () => { token = "SYNTHETIC-UPDATED"; updateTokens(name, { accessToken: "SYNTHETIC-INITIAL", refreshToken: "SYNTHETIC-REFRESH", expiresAt: 1, issuer: origin }, url); },
  };
}
async function runtime(config: McpConfig) {
  const h = host();
  const owner = createMcpRuntimeOwner();
  const state = await initializeMcp(h.pi, h.ctx, owner, { config });
  cleanups.push(() => owner.stop());
  for (const [name, definition] of Object.entries(config.mcpServers)) await state.manager.connect(name, definition);
  return state;
}

it("registers the optional actual adapter hook, qualifies connected HTTP, and releases without replay", async () => {
  const f = await wire(); const h = host();
  createMcpAdapter({ config: f.config })(h.pi);
  cleanups.push(() => h.handlers.get("session_shutdown")!());
  await h.handlers.get("session_start")!({}, h.ctx);
  const tool = h.tools.get("mcp");
  await tool.execute("call", { connect: f.name }, undefined, undefined, h.ctx);
  await tool.execute("call", { tool: "echo", server: f.name, args: {} }, undefined, undefined, h.ctx);
  expect(f.calls()).toBe(1);
  await expect.poll(async () => {
    const probe = hold(); const result = await h.handlers.get("session_checkpoint")!(probe.event); probe.release(); return result;
  }).toEqual({ sleepReady: true });
  const cut = hold();
  expect(await h.handlers.get("session_checkpoint")!(cut.event)).toEqual({ sleepReady: true });
  expect(await readFile(join(directory, "trace.jsonl"), "utf8")).toContain('"method":"tools/call"');
  cut.release(); // also the failed-upload/cancel API
  expect(f.calls()).toBe(1);
  await tool.execute("next", { tool: "echo", server: f.name, args: {} }, undefined, undefined, h.ctx);
  expect(f.calls()).toBe(2);
});

it("does not bless host callbacks whose abortable work can outlive cancellation", async () => {
  const h = host();
  createMcpAdapter({ config: { mcpServers: {} }, beforeExecute: async () => {} })(h.pi);
  expect(await h.handlers.get("session_checkpoint")!(hold().event)).toEqual({ sleepReady: false, reason: "MCP host execution/capture callbacks are not checkpoint-supported" });
});

it("vetoes a delayed actual SDK request without cancelling it, then qualifies completion", async () => {
  const f = await wire(); const state = await runtime(f.config);
  const client = state.manager.getConnection(f.name)!.client;
  f.delay("tools/call"); const pending = client.callTool({ name: "echo", arguments: {} });
  await expect.poll(f.started).toBe(true);
  const cut = hold();
  expect(await prepareMcpCheckpoint(state, cut.event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  f.release(); await pending;
  const next = hold(); expect(await prepareMcpCheckpoint(state, next.event)).toEqual({ sleepReady: true }); next.release();
});

it("invalidates synchronously before a late outbound request and before inbound trace/SDK processing", async () => {
  const f = await wire(); const state = await runtime(f.config);
  const connection = state.manager.getConnection(f.name)!;
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true });
  const pending = connection.client.callTool({ name: "echo", arguments: {} });
  expect(cut.invalidate).toHaveBeenCalledOnce(); expect(f.calls()).toBe(0);
  await pending;
  const incoming = hold(); expect(await prepareMcpCheckpoint(state, incoming.event)).toEqual({ sleepReady: true });
  // Observe ordering at actual transport ingress, retaining its real SDK/trace handlers.
  const receive = connection.transport.onmessage;
  connection.transport.onmessage = (...args) => { expect(incoming.invalidate).toHaveBeenCalledOnce(); receive?.(...args); };
  connection.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  expect(incoming.invalidate).toHaveBeenCalledOnce();
  await state.manager.flushForCheckpoint();
  expect(await readFile(join(directory, "trace.jsonl"), "utf8")).toContain("notifications/tools/list_changed");
});

it("joins real native refresh persistence and reconstructs a new client without replaying calls", async () => {
  const f = await wire({ oauth: true }); const state = await runtime(f.config);
  f.expire(); f.delay("token");
  const pending = state.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  await expect.poll(f.started).toBe(true);
  const busy = hold(); expect(await prepareMcpCheckpoint(state, busy.event)).toMatchObject({ sleepReady: false });
  f.release(); await pending;
  expect(getAuthForUrl(f.name, f.url)?.tokens?.refreshToken).toBe("SYNTHETIC-REFRESH-UPDATED");
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true }); cut.release();
  await state.owner.stop();
  const before = f.calls(); const restored = await runtime(f.config);
  expect(f.calls()).toBe(before); expect(f.refreshes()).toBe(1);
  await restored.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  expect(f.calls()).toBe(before + 1); expect(f.refreshes()).toBe(1);
});

it("vetoes active health discovery and pauses future ticks until release", async () => {
  const f = await wire();
  // Exercise the existing lifecycle owner, not a second background task registry.
  const fresh = await runtime(f.config);
  fresh.lifecycle.markKeepAlive(f.name, f.definition);
  // Replace the existing timer with a short interval; never create a parallel scheduler.
  const lifecycle = fresh.lifecycle;
  await fresh.manager.close(f.name);
  f.delay("server/discover");
  // The signal owns this replacement timer's cleanup.
  const signal = new AbortController();
  lifecycle.startHealthChecks(signal.signal, 10);
  await expect.poll(f.started).toBe(true);
  const busy = hold(); expect(await prepareMcpCheckpoint(fresh, busy.event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("health") });
  f.release(); await expect.poll(() => lifecycle.hasActiveHealthCheck()).toBe(false);
  const cut = hold(); expect(await prepareMcpCheckpoint(fresh, cut.event)).toEqual({ sleepReady: true });
  await new Promise(yes => setTimeout(yes, 30)); expect(cut.invalidate).not.toHaveBeenCalled();
  cut.release(); signal.abort();
});

it("vetoes initialization and active browser OAuth rather than pretending callbacks were saved", async () => {
  const f = await wire({ oauth: true }); const h = host();
  f.delay("server/discover"); createMcpAdapter({ config: f.config })(h.pi);
  cleanups.push(() => h.handlers.get("session_shutdown")!());
  await h.handlers.get("session_start")!({}, h.ctx);
  await expect.poll(f.started).toBe(true);
  expect(await h.handlers.get("session_checkpoint")!(hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("initialization") });
  f.release();
  await h.tools.get("mcp").execute("connect", { connect: f.name }, undefined, undefined, h.ctx);
  const state = await runtime({ mcpServers: {}, settings: { sampling: false, elicitation: false } });
  f.delay("server/discover");
  const pending = startAuth(f.name, f.url, f.definition, { runtime: state.oauthRuntime });
  await expect.poll(f.started).toBe(true);
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("OAuth") });
  f.release(); await pending;
});

it("keeps a completed auth-start browser callback wait explicitly non-resumable", async () => {
  const portProbe = createServer();
  await new Promise<void>(yes => portProbe.listen(0, "127.0.0.1", yes));
  const address = portProbe.address(); if (!address || typeof address === "string") throw new Error("No callback port");
  await new Promise<void>(yes => portProbe.close(() => yes()));
  vi.stubEnv("MCP_OAUTH_CALLBACK_PORT", String(address.port));
  const f = await wire({ oauth: true });
  const state = await runtime({ mcpServers: {}, settings: { sampling: false, elicitation: false } });
  const name = f.name + "-browser"; // no saved token; local metadata yields an authorization URL only
  const pending = await startAuth(name, f.url, f.definition, { runtime: state.oauthRuntime });
  expect(new URL(pending.authorizationUrl).origin).toBe(f.origin);
  expect(hasPendingAuth(name, undefined, state.oauthRuntime)).toBe(true);
  expect(await prepareMcpCheckpoint(state, hold().event)).toEqual({ sleepReady: false, reason: "MCP browser OAuth callback/flow is pending" });
  expect(f.refreshes()).toBe(0);
});

it.each([
  ["sampling", { sampling: true, samplingAutoApprove: true }, "sampling/elicitation"],
  ["stdio", undefined, "stdio/Unix"],
  ["approvals", undefined, "approvals"],
  ["UI", undefined, "UI session"],
] as const)("names unsupported %s state", async (kind, settings, reason) => {
  const f = await wire(); if (settings) Object.assign(f.config.settings!, settings);
  const state = await runtime(f.config);
  if (kind === "stdio") state.config.mcpServers.other = { command: "never-started" };
  if (kind === "approvals") state.approvedToolCalls.set("fixture", true);
  if (kind === "UI") state.completedUiSessions.push({} as any);
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining(reason) });
});

it("vetoes remote task capabilities and stateful HTTP sessions", async () => {
  for (const options of [{ capabilities: { tools: {}, tasks: {} }, legacy: true }, { session: true }]) {
    const f = await wire(options); const state = await runtime(f.config);
    const connection = state.manager.getConnection(f.name)!;
    expect(await prepareMcpCheckpoint(state, hold().event), JSON.stringify({ options, capabilities: connection.client.getServerCapabilities(), sessionId: connection.transport.sessionId })).toMatchObject({ sleepReady: false });
  }
});

it("rejects metadata persistence failure, unwinds the hold and keeps future explicit requests usable", async () => {
  const f = await wire(); const state = await runtime(f.config);
  const cache = join(directory, "mcp-cache.json"); await rm(cache); await mkdir(cache);
  await expect(prepareMcpCheckpoint(state, hold().event)).rejects.toThrow();
  await rm(cache, { recursive: true });
  await state.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  const next = hold(); expect(await prepareMcpCheckpoint(state, next.event)).toEqual({ sleepReady: true }); next.release();
  expect(JSON.parse(await readFile(cache, "utf8")).servers[f.name]).toBeTruthy();
});

it("does not qualify a script that still owns computation/output work", async () => {
  const f = await wire(); const state = await runtime(f.config);
  const pending = runMcpScript(state, 'const until=Date.now()+100; while(Date.now()<until){}; return 1', 2000);
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("script") });
  await pending;
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true }); cut.release();
});

it("makes trace persistence failures observable only at strict persistence boundaries", async () => {
  const writer = new McpTraceWriter({ filePath: join(directory, "trace-fail"), writeFile: async () => { throw new Error("synthetic disk failure"); } });
  await expect(writer.flush()).resolves.toBeUndefined();
  await expect(writer.flush(true)).rejects.toThrow("synthetic disk failure");
});
