import { createServer } from "node:http";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { executeCall } from "../proxy-modes.ts";
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
  vi.restoreAllMocks();
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
async function readiness(state: Parameters<typeof prepareMcpCheckpoint>[0]) {
  const cut = hold();
  try { return await prepareMcpCheckpoint(state, cut.event); } finally { cut.release(); }
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
  const model = { id: "synthetic", provider: "synthetic", name: "Synthetic local fixture" };
  const ui = {
    setStatus: vi.fn(), notify: vi.fn(),
    confirm: vi.fn(async () => true),
    select: vi.fn(async (title: string) => title.startsWith("Review") ? "Submit" : "Continue"),
    input: vi.fn(async () => "synthetic"),
  };
  const modelRegistry = {
    getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: vi.fn(async () => ({ role: "assistant", content: [{ type: "text", text: "SYNTHETIC-SAMPLE" }], provider: "synthetic", model: "synthetic", stopReason: "stop" })),
  };
  const ctx = { cwd: directory, mode: "tui", hasUI: true, isProjectTrusted: () => true, modelRegistry, model, ui };
  return { pi: pi as any, ctx: ctx as any, handlers, tools, ui, modelRegistry };
}
async function wire(options: { oauth?: boolean; capabilities?: object; session?: boolean; legacy?: boolean; inbound?: boolean; input?: "sampling" | "elicitation" } = {}) {
  let origin = "";
  let token = "SYNTHETIC-INITIAL";
  let input = options.input;
  let delayMethod: string | undefined;
  let blocked: ReturnType<typeof deferred> | undefined;
  let started = false;
  let callCount = 0;
  let refreshCount = 0;
  let getCount = 0;
  let unauthorizedCount = 0;
  let rejectGet = false;
  const methods: string[] = [];
  let stream: import("node:http").ServerResponse | undefined;
  let callbackId = 0;
  let subscriptionId: number | undefined;
  let advertisedClientCapabilities: unknown;
  const replies = new Map<string, (value: any) => void>();
  const notifications: string[] = [];
  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: origin + "/mcp", authorization_servers: [origin] })); return;
    }
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: origin, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] })); return;
    }
    if (req.method === "GET" && options.inbound) {
      getCount++;
      if (delayMethod === "GET") { started = true; await blocked!.promise; }
      if (rejectGet) {
        rejectGet = false;
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
      }
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    if (req.url !== "/token") {
      const response = JSON.parse(text);
      if (response.method === undefined && response.id) {
        replies.get(String(response.id))?.(response); replies.delete(String(response.id));
        if (delayMethod === "callback-reply") { started = true; await blocked!.promise; }
        res.writeHead(202).end(); return;
      }
    }
    const method = req.url === "/token" ? "token" : JSON.parse(text).method;
    methods.push(method);
    if (method === delayMethod) { started = true; await blocked!.promise; }
    if (method === "token") {
      refreshCount++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, refresh_token: "SYNTHETIC-REFRESH-UPDATED", token_type: "Bearer", expires_in: 3600 })); return;
    }
    if (options.oauth && req.headers.authorization !== `Bearer ${token}`) {
      unauthorizedCount++;
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    const body = JSON.parse(text);
    if (method.startsWith("notifications/")) { res.writeHead(202).end(); return; }
    if (method === "subscriptions/listen") {
      stream = res; subscriptionId = body.id;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: body.params.notifications, _meta: { [SUBSCRIPTION_ID_META_KEY]: body.id } } })}\n\n`);
      return;
    }
    if (method === "initialize") advertisedClientCapabilities = body.params.capabilities;
    if (method === "tools/call") callCount++;
    const result = method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: options.capabilities ?? { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
      : method === "server/discover"
      ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: options.capabilities ?? { tools: {} } }
      : method === "tools/call" && input && !body.params.inputResponses
        ? { resultType: "input_required", requestState: "synthetic-state", inputRequests: { answer: { method: input === "sampling" ? "sampling/createMessage" : "elicitation/create", params: input === "sampling" ? samplingRequest : elicitationRequest } } }
      : method === "tools/list"
        ? { resultType: "complete", ttlMs: 1000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : method === "resources/list" ? { resultType: "complete", resources: [] }
        : method === "completion/complete" ? { resultType: "complete", completion: { values: ["synthetic"], total: 1, hasMore: false } }
        : ["logging/setLevel", "resources/subscribe", "resources/unsubscribe"].includes(method) ? { resultType: "complete" }
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
    ...(options.legacy || options.session || options.inbound ? { protocolVersion: "legacy" as const } : {}),
    ...(options.oauth ? { oauth: { clientId: "SYNTHETIC-CLIENT", clientSecret: "SYNTHETIC-CLIENT-SECRET" } } : {}) };
  const config: McpConfig = { mcpServers: { [name]: definition }, settings: { toolPrefix: "none", trace: { enabled: true, file: join(directory, "trace.jsonl") } } };
  if (options.oauth) saveAuthEntry(name, { tokens: { accessToken: token, refreshToken: "SYNTHETIC-REFRESH", expiresAt: Date.now() / 1000 + 3600, issuer: origin } }, url);
  const notify = (method: string, params: object) => {
    if (!stream) throw new Error("No native GET stream");
    notifications.push(method);
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, params: { ...params,
      ...(subscriptionId !== undefined ? { _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } } : {}),
    } })}\n\n`);
  };
  return { name, url, origin, config, definition, methods, calls: () => callCount, refreshes: () => refreshCount,
    streamReady: () => stream !== undefined, notify, notifications,
    gets: () => getCount, unauthorized: () => unauthorizedCount,
    rejectNextGet: () => { rejectGet = true; },
    endStream: () => { stream!.end("retry: 1\n\n"); },
    clientCapabilities: () => advertisedClientCapabilities,
    finishInput: () => { input = undefined; },
    callback: (method: string, params: object) => {
      if (!stream) throw new Error("No native GET stream");
      const id = `callback-${++callbackId}`;
      const response = new Promise<any>(resolve => replies.set(id, resolve));
      stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n\n`);
      return { response, cancel: () => notify("notifications/cancelled", { requestId: id, reason: "synthetic cancellation" }) };
    },
    delay: (method: string) => { delayMethod = method; blocked = deferred(); started = false; },
    started: () => started,
    release: () => { delayMethod = undefined; blocked?.resolve(); },
    expire: () => { token = "SYNTHETIC-UPDATED"; updateTokens(name, { accessToken: "SYNTHETIC-INITIAL", refreshToken: "SYNTHETIC-REFRESH", expiresAt: 1, issuer: origin }, url); },
  };
}
async function runtime(config: McpConfig, h = host()) {
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

it("qualifies configured but idle host callbacks", async () => {
  const h = host();
  createMcpAdapter({ config: { mcpServers: {} }, beforeExecute: async () => {}, onToolCall: async () => {} })(h.pi);
  cleanups.push(() => h.handlers.get("session_shutdown")!());
  await h.handlers.get("session_start")!({}, h.ctx);
  await expect.poll(async () => {
    const cut = hold(); const result = await h.handlers.get("session_checkpoint")!(cut.event); cut.release(); return result;
  }).toEqual({ sleepReady: true });
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
  ["stdio", "stdio/Unix"],
  ["approvals", "approvals"],
  ["UI", "UI session"],
] as const)("names unsupported %s state", async (kind, reason) => {
  const f = await wire();
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

const samplingRequest = { messages: [{ role: "user", content: { type: "text", text: "Synthetic sample" } }], maxTokens: 8 };
const elicitationRequest = { mode: "form", message: "Synthetic question", requestedSchema: { type: "object", properties: {} } };

it.each(["sampling", "elicitation"] as const)("owns real inbound %s promises with default TUI features, then qualifies the answered request", async kind => {
  const f = await wire({ inbound: true }); const h = host();
  const gate = deferred(); const entered = deferred();
  if (kind === "sampling") h.ui.confirm.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return true; });
  else h.ui.select.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return "Continue"; });
  const state = await runtime(f.config, h);
  cleanups.push(async () => gate.resolve());
  await expect.poll(f.streamReady).toBe(true);
  expect(f.clientCapabilities()).toMatchObject({ sampling: {}, elicitation: { form: {}, url: {} } });
  const idle = hold(); expect(await prepareMcpCheckpoint(state, idle.event)).toEqual({ sleepReady: true }); idle.release();
  const request = f.callback(kind === "sampling" ? "sampling/createMessage" : "elicitation/create", kind === "sampling" ? samplingRequest : elicitationRequest);
  await entered.promise;
  state.manager.getConnection(f.name)!.lastUsedAt = 0;
  expect(state.manager.isIdle(f.name, 1)).toBe(false);
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining(`${kind} callback`) });
  gate.resolve();
  expect((await request.response).error).toBeUndefined();
  await expect.poll(() => readiness(state)).toEqual({ sleepReady: true });
  await state.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  const before = f.calls(); await state.owner.stop();
  const restored = await runtime(f.config, host());
  expect(f.calls()).toBe(before); // ordinary startup discovery, never replay the old tool/callback
  await restored.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  expect(f.calls()).toBe(before + 1);
});

it("keeps the SDK's callback reply HTTP send owned after the handler itself has returned", async () => {
  const f = await wire({ inbound: true }); const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  f.delay("callback-reply");
  const request = f.callback("elicitation/create", elicitationRequest);
  expect((await request.response).result.action).toBe("accept");
  expect(f.started()).toBe(true);
  // The form is answered and its promise is done, but the native reply's HTTP/auth work is not.
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  f.release();
  await expect.poll(async () => {
    const cut = hold(); const result = await prepareMcpCheckpoint(state, cut.event); cut.release(); return result;
  }).toEqual({ sleepReady: true });
});

it.each(["sampling", "elicitation"] as const)("invalidates before a late %s callback touches auth/UI", async kind => {
  const f = await wire({ inbound: true }); const h = host();
  const state = await runtime(f.config, h); await expect.poll(f.streamReady).toBe(true);
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true });
  h.modelRegistry.getApiKeyAndHeaders = async () => { expect(cut.invalidate).toHaveBeenCalledOnce(); return { ok: true }; };
  h.ui.select.mockImplementation(async () => { expect(cut.invalidate).toHaveBeenCalledOnce(); return "Decline"; });
  const request = f.callback(kind === "sampling" ? "sampling/createMessage" : "elicitation/create", kind === "sampling" ? samplingRequest : elicitationRequest);
  const response = await request.response;
  expect(response.error).toBeUndefined();
  if (kind === "elicitation") expect(response.result.action).toBe("decline");
  expect(cut.event.signal.aborted).toBe(true);
});

it.each(["sampling", "elicitation"] as const)("does not lose a cancelled %s callback tail on transport close", async kind => {
  const f = await wire({ inbound: true }); const h = host();
  const gate = deferred(); const entered = deferred();
  const state = await runtime(f.config, h);
  // Cleanup releases the real handler before owner.stop tries to drain it.
  cleanups.push(async () => gate.resolve());
  if (kind === "sampling") h.modelRegistry.complete.mockImplementationOnce(async () => {
    entered.resolve(); await gate.promise;
    return { role: "assistant", content: [{ type: "text", text: "SYNTHETIC-LATE" }], provider: "synthetic", model: "synthetic", stopReason: "stop" };
  });
  else h.ui.select.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return "Decline"; });
  await expect.poll(f.streamReady).toBe(true);
  const request = f.callback(kind === "sampling" ? "sampling/createMessage" : "elicitation/create", kind === "sampling" ? samplingRequest : elicitationRequest);
  await entered.promise;
  const transport = state.manager.getConnection(f.name)!.transport;
  const receive = transport.onmessage;
  let cancellationDispatched = false;
  transport.onmessage = (message, extra) => {
    receive?.(message, extra);
    if ("method" in message && message.method === "notifications/cancelled") cancellationDispatched = true;
  };
  request.cancel();
  await expect.poll(() => cancellationDispatched).toBe(true);
  // A real SDK roundtrip, not an arbitrary sleep, then checks the still-running handler.
  await state.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining(`${kind} callback`) });
  const closed = vi.fn(); const closing = state.manager.close(f.name).then(closed);
  await Promise.resolve(); expect(closed).not.toHaveBeenCalled();
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false });
  gate.resolve(); await closing;
  const settled = hold(); expect(await prepareMcpCheckpoint(state, settled.event)).toEqual({ sleepReady: true }); settled.release();
});

it.each(["sampling", "elicitation"] as const)("owns a cancelled modern input-required %s handler beyond the tool's abortable facade", async kind => {
  const f = await wire({ input: kind }); const h = host(); const gate = deferred(); const entered = deferred();
  const state = await runtime(f.config, h); cleanups.push(async () => gate.resolve());
  if (kind === "sampling") h.ui.confirm.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return true; });
  else h.ui.select.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return "Decline"; });
  const controller = new AbortController();
  const call = executeCall(state, "echo", {}, f.name, undefined, controller.signal);
  await entered.promise;
  controller.abort(new Error("synthetic modern cancellation"));
  expect((await call).details.error).toBe("aborted");
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining(`${kind} callback`) });
  gate.resolve();
  await expect.poll(async () => {
    const cut = hold(); const result = await prepareMcpCheckpoint(state, cut.event); cut.release(); return result;
  }).toEqual({ sleepReady: true });
  expect(f.calls()).toBe(1); // cancelled input continuation was not dispatched after the late answer
  f.finishInput();
  expect((await executeCall(state, "echo", {}, f.name)).details.error).toBeUndefined();
  expect(f.calls()).toBe(2);
});

it.each(["beforeExecute", "onToolCall"] as const)("owns the underlying %s callback beyond abortable cancellation", async kind => {
  const f = await wire(); const h = host(); const gate = deferred(); const entered = deferred();
  let armed = false;
  const callback = async () => {
    if (!armed) return;
    entered.resolve(); await gate.promise;
    await writeFile(join(directory, kind + ".persisted"), "SYNTHETIC-CALLBACK-COMPLETED");
  };
  createMcpAdapter({ config: f.config,
    ...(kind === "beforeExecute" ? { beforeExecute: callback } : { onToolCall: async (event: { phase: string }) => { if (event.phase === "after") await callback(); } }),
  })(h.pi);
  cleanups.push(async () => { gate.resolve(); await h.handlers.get("session_shutdown")!(); });
  await h.handlers.get("session_start")!({}, h.ctx);
  const tool = h.tools.get("mcp");
  await tool.execute("connect", { connect: f.name }, undefined, undefined, h.ctx);
  armed = true;
  const controller = new AbortController();
  const operation = tool.execute("call", { tool: "echo", server: f.name }, controller.signal, undefined, h.ctx);
  const observed = Promise.resolve(operation).catch(error => error);
  await entered.promise;
  expect(await h.handlers.get("session_checkpoint")!(hold().event)).toEqual({ sleepReady: false, reason: `MCP ${kind} callback is pending` });
  controller.abort(new Error("synthetic cancellation")); await observed;
  expect(await h.handlers.get("session_checkpoint")!(hold().event)).toEqual({ sleepReady: false, reason: `MCP ${kind} callback is pending` });
  gate.resolve();
  await expect.poll(async () => {
    const cut = hold(); const result = await h.handlers.get("session_checkpoint")!(cut.event); cut.release(); return result;
  }).toEqual({ sleepReady: true });
  expect(await readFile(join(directory, kind + ".persisted"), "utf8")).toBe("SYNTHETIC-CALLBACK-COMPLETED");
  const prior = f.calls(); armed = false;
  await tool.execute("next", { tool: "echo", server: f.name }, undefined, undefined, h.ctx);
  expect(f.calls()).toBe(prior + 1);
});

it("qualifies ordinary logging/completion capabilities while owning actual requests and notifications", async () => {
  const f = await wire({ inbound: true, capabilities: { tools: {}, logging: {}, completions: {} } });
  const state = await runtime(f.config); await expect.poll(f.streamReady).toBe(true);
  const client = state.manager.getConnection(f.name)!.client;
  await client.setLoggingLevel("info");
  f.delay("completion/complete");
  const completion = client.complete({ ref: { type: "ref/prompt", name: "synthetic" }, argument: { name: "value", value: "syn" } });
  await expect.poll(f.started).toBe(true);
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  f.release(); expect((await completion).completion.values).toEqual(["synthetic"]);
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true });
  f.notify("notifications/message", { level: "info", data: "SYNTHETIC-LOG" });
  await expect.poll(() => cut.invalidate.mock.calls.length).toBe(1);
  const next = hold(); expect(await prepareMcpCheckpoint(state, next.event)).toEqual({ sleepReady: true }); next.release();
});

it("vetoes an actual resource subscription, not just advertisement of subscription support", async () => {
  const f = await wire({ legacy: true, capabilities: { tools: {}, resources: { subscribe: true } } });
  const state = await runtime(f.config); const client = state.manager.getConnection(f.name)!.client;
  const idle = hold(); expect(await prepareMcpCheckpoint(state, idle.event)).toEqual({ sleepReady: true }); idle.release();
  await client.subscribeResource({ uri: "synthetic://resource" });
  expect(await prepareMcpCheckpoint(state, hold().event)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("resource subscription") });
  await client.unsubscribeResource({ uri: "synthetic://resource" });
  const done = hold(); expect(await prepareMcpCheckpoint(state, done.event)).toEqual({ sleepReady: true }); done.release();
  f.delay("resources/subscribe");
  const controller = new AbortController();
  const attempted = client.subscribeResource({ uri: "synthetic://uncertain" }, { signal: controller.signal });
  const rejected = expect(attempted).rejects.toThrow();
  await expect.poll(f.started).toBe(true);
  controller.abort(new Error("lost subscription response")); await rejected; f.release();
  await expect.poll(() => readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("active or unresolved") });
  await client.unsubscribeResource({ uri: "synthetic://uncertain" });
  const cleared = hold(); expect(await prepareMcpCheckpoint(state, cleared.event)).toEqual({ sleepReady: true }); cleared.release();
});

it("reconstructs native catalog subscriptions but vetoes explicit consumer listen handles", async () => {
  const f = await wire({ capabilities: { tools: { listChanged: true } } }); const state = await runtime(f.config);
  const client = state.manager.getConnection(f.name)!.client;
  const subscription = client.autoOpenedSubscription!;
  expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
  expect(await readiness(state)).toEqual({ sleepReady: true });
  const ingress = hold(); expect(await prepareMcpCheckpoint(state, ingress.event)).toEqual({ sleepReady: true });
  f.notify("notifications/tools/list_changed", {});
  await expect.poll(() => ingress.invalidate.mock.calls.length).toBe(1);
  await expect.poll(() => readiness(state)).toEqual({ sleepReady: true });
  const explicit = await client.listen({ toolsListChanged: true });
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("subscription is active") });
  await explicit.close(); await explicit.closed;
  expect(await readiness(state)).toEqual({ sleepReady: true });
  await subscription.close(); await subscription.closed;
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true }); cut.release();
  await state.owner.stop();
  const restored = await runtime(f.config);
  expect(restored.manager.getConnection(f.name)!.client.autoOpenedSubscription?.honoredFilter).toEqual({ toolsListChanged: true });
  expect(await readiness(restored)).toEqual({ sleepReady: true });
  expect(f.calls()).toBe(0);
});

it.each(["readiness", "final shutdown"])("owns initial detached GET token reads beyond connect: %s", async check => {
  const f = await wire({ oauth: true, inbound: true });
  const gate = deferred(); let entered = false;
  const tokens = McpOAuthProvider.prototype.tokens;
  vi.spyOn(McpOAuthProvider.prototype, "tokens").mockImplementation(async function (...args) {
    // Native initialized send launches GET synchronously before returning to discovery.
    if (!entered && f.methods.includes("notifications/initialized")) {
      entered = true; await gate.promise;
    }
    return tokens.apply(this, args);
  });
  const state = await runtime(f.config); cleanups.push(async () => gate.resolve());
  expect(entered).toBe(true); expect(f.gets()).toBe(0);
  if (check === "readiness") expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  await state.manager.close(f.name);
  if (check === "readiness") expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  let stopped = false; const stopping = state.manager.closeAll().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
  gate.resolve(); await stopping;
});

it("invalidates before clean-EOF reconnect GET effects, owns headers, and permits idle SSE", async () => {
  const f = await wire({ inbound: true }); const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  await expect.poll(() => readiness(state)).toEqual({ sleepReady: true });
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true });
  f.delay("GET"); f.endStream();
  await expect.poll(f.started).toBe(true);
  expect(f.gets()).toBe(2); expect(cut.invalidate).toHaveBeenCalledOnce();
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  f.release(); await expect.poll(() => readiness(state)).toEqual({ sleepReady: true });
});

it.each([false, true])("fences reconnect auth and joins post-401 persistence (client_credentials=%s)", async noninteractive => {
  const f = await wire({ oauth: true, inbound: true });
  if (noninteractive) Object.assign(f.definition.oauth!, { grantType: "client_credentials" });
  const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  await expect.poll(() => readiness(state)).toEqual({ sleepReady: true });
  const gate = deferred(); let entered = false;
  cleanups.push(async () => gate.resolve());
  const cut = hold(); expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true });
  let readBeforeInvalidation = false;
  const tokens = McpOAuthProvider.prototype.tokens;
  vi.spyOn(McpOAuthProvider.prototype, "tokens").mockImplementation(function (...args) {
    if (!cut.event.signal.aborted) readBeforeInvalidation = true;
    return tokens.apply(this, args);
  });
  const saveTokens = McpOAuthProvider.prototype.saveTokens;
  vi.spyOn(McpOAuthProvider.prototype, "saveTokens").mockImplementation(async function (...args) {
    entered = true; await gate.promise;
    return saveTokens.apply(this, args);
  });
  f.rejectNextGet(); f.endStream();
  await expect.poll(() => entered).toBe(true);
  expect(readBeforeInvalidation).toBe(false);
  expect(cut.invalidate).toHaveBeenCalledOnce();
  expect(f.refreshes()).toBe(1);
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  await state.manager.close(f.name);
  let stopped = false; const stopping = state.manager.closeAll().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
  gate.resolve(); await stopping;
  expect(getAuthForUrl(f.name, f.url)?.tokens?.refreshToken).toBe("SYNTHETIC-REFRESH");
});

it("owns a background auth response body after fetch headers have arrived", async () => {
  const f = await wire({ oauth: true, inbound: true }); const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  const read = Response.prototype.json; const gate = deferred(); let entered = false;
  cleanups.push(async () => gate.resolve());
  vi.spyOn(Response.prototype, "json").mockImplementation(async function () {
    if (this.url === f.origin + "/token") { entered = true; await gate.promise; }
    return read.call(this);
  });
  f.rejectNextGet(); f.endStream();
  await expect.poll(() => entered).toBe(true);
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("request/refresh") });
  await state.manager.close(f.name);
  let stopped = false; const stopping = state.manager.closeAll().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(stopped).toBe(false);
  gate.resolve(); await stopping;
});

it("clears completed URL IDs only after the last actual completion notification", async () => {
  const f = await wire({ inbound: true }); const h = host(); const state = await runtime(f.config, h);
  await expect.poll(f.streamReady).toBe(true);
  const manager = state.manager as unknown as { rememberUrlElicitation(name: string, id: string): void };
  // Exact post-accept state, without launching a real browser.
  manager.rememberUrlElicitation(f.name, "first"); manager.rememberUrlElicitation(f.name, "second");
  f.notify("notifications/elicitation/complete", { elicitationId: "first" });
  await expect.poll(() => h.ui.notify.mock.calls.filter(([text]) => text.includes("completed")).length).toBe(1);
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("browser elicitation") });
  f.notify("notifications/elicitation/complete", { elicitationId: "second" });
  await expect.poll(() => h.ui.notify.mock.calls.filter(([text]) => text.includes("completed")).length).toBe(2);
  expect(await readiness(state)).toEqual({ sleepReady: true });
});

it("reconstructs implicit OAuth challenge caches on a fresh runtime without replay", async () => {
  const f = await wire({ oauth: true }); delete (f.definition as { auth?: unknown }).auth;
  const saved = getAuthForUrl(f.name, f.url)!.tokens!;
  updateTokens(f.name, { ...saved, scope: "synthetic.read" }, f.url);
  const state = await runtime(f.config);
  expect(f.unauthorized()).toBe(1);
  expect(await readiness(state)).toEqual({ sleepReady: true });
  await state.owner.stop();
  const restored = await runtime(f.config);
  expect(f.unauthorized()).toBe(2);
  expect(await readiness(restored)).toEqual({ sleepReady: true });
  expect(f.calls()).toBe(0); expect(f.refreshes()).toBe(0);
  expect(getAuthForUrl(f.name, f.url)?.tokens).toMatchObject({ issuer: f.origin, scope: "synthetic.read" });
});

it.each([{}, { opaqueFeature: {} }])("only permits empty experimental metadata: %j", async experimental => {
  const f = await wire({ legacy: true, capabilities: { tools: {}, experimental } }); const state = await runtime(f.config);
  expect(await readiness(state)).toMatchObject(Object.keys(experimental).length
    ? { sleepReady: false, reason: expect.stringContaining("experimental") } : { sleepReady: true });
});

it("does not couple optional trace path failures to repeated recovery or clean shutdown", async () => {
  const f = await wire(); const parent = join(directory, "not-a-directory"); await writeFile(parent, "fixture");
  f.config.settings!.trace = { enabled: true, file: join(parent, "trace.jsonl") };
  const state = await runtime(f.config);
  for (let i = 0; i < 3; i++) {
    const cut = hold(); cut.event.boundary = "turn";
    expect(await prepareMcpCheckpoint(state, cut.event)).toEqual({ sleepReady: true }); cut.release();
  }
  await state.manager.getConnection(f.name)!.client.callTool({ name: "echo", arguments: {} });
  await expect(state.owner.stop()).resolves.toBeUndefined();
});

it("retains failed native disposal until an explicit close really retries cleanup", async () => {
  const f = await wire(); const state = await runtime(f.config);
  const transport = state.manager.getConnection(f.name)!.transport;
  const close = vi.spyOn(transport, "close").mockRejectedValueOnce(new Error("synthetic close failure"));
  await expect(state.manager.close(f.name)).rejects.toThrow("cleanup failed");
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("retirement") });
  await state.manager.connect(f.name, f.definition);
  expect(await readiness(state)).toMatchObject({ sleepReady: false, reason: expect.stringContaining("retirement") });
  await expect(state.manager.close(f.name)).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
  expect(await readiness(state)).toEqual({ sleepReady: true });
});

it("makes trace persistence failures observable only at strict persistence boundaries", async () => {
  const writer = new McpTraceWriter({ filePath: join(directory, "trace-fail"), writeFile: async () => { throw new Error("synthetic disk failure"); } });
  await expect(writer.flush()).resolves.toBeUndefined();
  await expect(writer.flush(true)).rejects.toThrow("synthetic disk failure");
});
