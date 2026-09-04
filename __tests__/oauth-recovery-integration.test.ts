import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { openMcpAuthPanel } from "../commands.ts";
import { createMcpAdapter } from "../index.ts";
import { EventEmitter } from "node:events";
import type { createMcpPanel } from "../mcp-panel.ts";
import { runMcpScript } from "../mcp-code.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthRuntime, startAuth, completeAuthFromInput, authenticate, hasPendingAuth, shutdownOAuth, getOAuthRequest, removeAuth } from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl, getAuthBaseDir, updateTokens } from "../mcp-auth.ts";
import { McpServerManager } from "../server-manager.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { executeAuthStart, executeAuthComplete, executeCall } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { formatToolName, type ServerEntry } from "../types.ts";

const browser = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => {}) }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
  browser.open.mockReset().mockResolvedValue(undefined);
});

const tools = ["write", "effect"].map(name => ({ name, inputSchema: { type: "object" } }));
const content = (text: string) => ({ content: [{ type: "text", text }] });
const scopes = (scope: string | null | undefined) => (scope ?? "").split(" ").filter(Boolean).sort();
const settled = <T>(promise: Promise<T>) => Promise.allSettled([promise]).then(([result]) => result);

type WireRequest = { method: string; token?: string; name?: string };
async function fixture(era: "legacy" | "modern" = "legacy", name = `recovery-${crypto.randomUUID()}`) {
  let origin = "";
  let sessions = 0;
  let codeNumber = 0;
  const requests: WireRequest[] = [];
  const http: Array<{ method?: string; path: string }> = [];
  const authorizations: URL[] = [];
  const exchanges: URLSearchParams[] = [];
  const codes = new Map<string, URL>();
  const tokens = new Map<string, string>([["basic-token", "basic"], ["wide-token", "basic write"]]);
  const controls = { protectedMethod: "", challengeStatus: 401, refresh: false, issuedScope: undefined as string | null | undefined,
    holdEffect: false, releaseEffect: () => {}, effectCount: 0, requiredScope: "write" as string | undefined,
    toolStatuses: [] as number[], tokenFailure: false, genericForbidden: false, metadataAbsent: false, issuerRequired: true,
    protectScope: false, notifications: false, stream: undefined as ServerResponse | undefined,
    holdDiscovery: false, discoveryHeld: false, holdToken: false, releaseToken: () => {}, holdCatalog: false, releaseCatalog: () => {}, catalogHeld: false,
    issuerPath: "", offlineAccess: false, accessScope: "write", advertisedScopes: ["basic"], catalogFailure: undefined as { method: string; status: number } | undefined,
    holdResource: false, resourceHeld: false, rejectResource: () => {},
    holdAnonymous: false, anonymousHeld: false, releaseAnonymous: () => {} };
  const toolName = (tool: string) => formatToolName(tool, name, "server");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    http.push({ method: req.method, path: url.pathname });
    const json = (value: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return void json({
      resource: `${origin}/mcp`, authorization_servers: [`${origin}${controls.issuerPath}`], scopes_supported: controls.advertisedScopes,
    });
    if (controls.metadataAbsent && (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.includes("openid-configuration"))) { res.writeHead(404).end(); return; }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return void json({
      issuer: `${origin}${controls.issuerPath}`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      authorization_response_iss_parameter_supported: controls.issuerRequired,
      ...(controls.offlineAccess ? { scopes_supported: ["basic", "write", "offline_access"] } : {}),
    });
    if (url.pathname === "/authorize") {
      authorizations.push(url);
      const code = `code-${++codeNumber}`;
      codes.set(code, url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code, state: url.searchParams.get("state")!, iss: origin }).toString();
      res.writeHead(302, { location: callback.href }).end(); return;
    }
    let data = "";
    for await (const chunk of req) data += chunk;
    if (url.pathname === "/register") return void json({ client_id: "fixture", ...JSON.parse(data) }, 201);
    if (url.pathname === "/token") {
      const params = new URLSearchParams(data);
      exchanges.push(params);
      if (controls.tokenFailure) { req.socket.destroy(); return; }
      const authorization = codes.get(params.get("code")!);
      if (params.get("grant_type") === "authorization_code") {
        const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (!authorization || challenge !== authorization.searchParams.get("code_challenge") || params.get("redirect_uri") !== authorization.searchParams.get("redirect_uri")) {
          return void json({ error: "invalid_grant" }, 400);
        }
        codes.delete(params.get("code")!);
      }
      const requested = authorization?.searchParams.get("scope") ?? params.get("scope") ?? "basic";
      const scope = controls.issuedScope === undefined ? requested : controls.issuedScope;
      const token = `issued-${exchanges.length}`;
      tokens.set(token, scope ?? "basic");
      const sendToken = () => json({ access_token: token, token_type: "Bearer", expires_in: 3600,
        ...(scope !== null ? { scope } : {}), ...(controls.refresh ? { refresh_token: "refresh-basic" } : {}),
      });
      if (controls.holdToken) { controls.releaseToken = sendToken; return; }
      return void sendToken();
    }
    if (req.method === "GET" && controls.notifications) {
      controls.stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": ready\n\n"); return;
    }
    if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 202 : 405).end(); return; }
    const body = JSON.parse(data);
    const method = body.method as string;
    if (method.startsWith("notifications/")) { res.writeHead(202).end(); return; }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    requests.push({ method, token, name: body.params?.name });
    const challenge = (status: number) => res.writeHead(status, { "www-authenticate": `Bearer ${status === 403 ? `error="insufficient_scope", ${controls.requiredScope !== undefined ? `scope="${controls.requiredScope}", ` : ""}` : 'scope="basic", '}resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
    if (method === controls.catalogFailure?.method) { res.writeHead(controls.catalogFailure.status).end("catalog unavailable"); return; }
    if (method === "resources/read" && controls.holdResource) { controls.resourceHeld = true; controls.rejectResource = () => challenge(403); return; }
    if (method === "tools/call" && body.params.name === "write") {
      if (!token && controls.holdAnonymous) {
        controls.holdAnonymous = false; controls.anonymousHeld = true; controls.releaseAnonymous = () => challenge(controls.challengeStatus); return;
      }
      if (controls.genericForbidden) { res.writeHead(403).end("Forbidden"); return; }
      const status = controls.toolStatuses.shift();
      if (status === 0) { req.socket.destroy(); return; }
      if (status === 401 || status === 403) { challenge(status); return; }
      if (status) { res.writeHead(status).end("fixture failure"); return; }
    }
    if (method === controls.protectedMethod && (!tokens.has(token ?? "") || (controls.protectScope && !scopes(tokens.get(token ?? "")).includes("write")))) {
      challenge(token && controls.protectScope ? 403 : controls.challengeStatus); return;
    }
    if (method === "tools/call" && body.params.name === "write" && !scopes(tokens.get(token ?? "")).includes(controls.accessScope)) {
      challenge(token ? 403 : controls.challengeStatus); return;
    }
    const result = (value: object, headers = {}) => res.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify({
      jsonrpc: "2.0", id: body.id, result: { ...(era === "modern" ? { resultType: "complete" } : {}), ...value },
    }));
    const capabilities = { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } };
    if (controls.holdDiscovery && ["server/discover", "initialize"].includes(method)) { controls.discoveryHeld = true; return; }
    if (controls.holdCatalog && method === "tools/list") {
      controls.catalogHeld = true;
      controls.releaseCatalog = () => result({ tools, ...(era === "modern" ? { ttlMs: 10000, cacheScope: "private" } : {}) }); return;
    }
    if (method === "server/discover") return void result({ supportedVersions: ["2026-07-28"], capabilities });
    if (method === "initialize") return void result({ protocolVersion: "2025-06-18", serverInfo: { name: "recovery", version: "1" }, capabilities }, { "mcp-session-id": `session-${++sessions}` });
    if (method === "tools/list") return void result({ tools, ...(era === "modern" ? { ttlMs: 10000, cacheScope: "private" } : {}) });
    if (method === "resources/list") return void result({ resources: [{ name: "document", uri: "test://document" }], ...(era === "modern" ? { ttlMs: 10000, cacheScope: "private" } : {}) });
    if (method === "prompts/list") return void result({ prompts: [{ name: "prompt" }], ...(era === "modern" ? { ttlMs: 10000, cacheScope: "private" } : {}) });
    if (method === "tools/call") {
      if (body.params.name === "effect") {
        controls.effectCount++;
        if (controls.holdEffect) {
          res.writeHead(200, { "content-type": "application/json", "x-accepted-effect": "yes" });
          res.write(`{"jsonrpc":"2.0","id":${body.id},"result":`);
          controls.releaseEffect = () => res.end(`${JSON.stringify({ ...(era === "modern" ? { resultType: "complete" } : {}), ...content("effect") })}}`);
          return;
        }
      }
      return void result(content(body.params.name));
    }
    if (method === "prompts/get") return void result({ messages: [{ role: "user", content: { type: "text", text: "prompt" } }] });
    if (method === "resources/read") return void result({ contents: [{ uri: "test://document", text: "document" }] });
    json({ error: "unexpected request" }, 500);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  manager.setOAuthRuntime(runtime);
  const definition: ServerEntry = { url: `${origin}/mcp`, protocolVersion: era === "legacy" ? "legacy" : "auto", requestTimeoutMs: 3000 };
  const state = { manager, oauthRuntime: runtime, config: { mcpServers: { [name]: definition }, settings: {} },
    toolMetadata: new Map([[name, tools.map(t => ({ name: toolName(t.name), originalName: t.name, description: t.name }))]]),
    serverInstructions: new Map(), failureTracker: new Map(), completedUiSessions: [], metadataCacheEnabled: false,
  } as unknown as McpExtensionState;
  const authorize = async (url: string) => {
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(302);
    return response.headers.get("location")!;
  };
  const start = () => startAuth(name, definition.url!, definition, { runtime });
  const manual = async () => {
    const { authorizationUrl } = await start();
    expect(authorizationUrl).toBeTruthy();
    const callback = await authorize(authorizationUrl);
    expect(await completeAuthFromInput(name, callback, { runtime })).toBe("authenticated");
    return authorizationUrl;
  };
  cleanups.push(async () => {
    if (process.env.OAUTH_PROOF_FILE) appendFileSync(process.env.OAUTH_PROOF_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, node: process.version, execPath: process.execPath, era, http, requests, authorizations: authorizations.map(url => Object.fromEntries(url.searchParams)), exchanges: exchanges.map(params => Object.fromEntries(params)), effects: controls.effectCount })}\n`);
    controls.releaseEffect();
    await manager.closeAll(); await shutdownOAuth(runtime); clearAllCredentials(name);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { name, toolName, origin, definition, runtime, manager, state, controls, http, requests, exchanges, authorizations, start, manual, authorize,
    connect: () => manager.connect(name, definition),
    call: (tool = "write", signal?: AbortSignal) => executeCall(state, toolName(tool), {}, name, undefined, signal),
    signIn: () => browser.open.mockImplementation(async (url: string) => {
      const callback = await authorize(url);
      const response = await fetch(callback);
      expect(response.status).toBe(200);
    }),
    callHost: async (host: "proxy" | "direct" | "script") => {
      if (host === "script") {
        const result = await runMcpScript(state, `emit(await tools.call(${JSON.stringify(toolName("write"))}, {}));`);
        expect(result.details.error).toBeUndefined();
        return JSON.parse((result.content[0] as { text: string }).text);
      }
      const result = host === "proxy" ? await executeCall(state, toolName("write"), {}, name)
        : await createDirectToolExecutor(() => state, () => null, { serverName: name, originalName: "write", prefixedName: toolName("write"), description: "write" })("call", {}, undefined, undefined, {} as any);
      return result.details.error ? { ok: false, error: { code: result.details.error } } : { ok: true, data: { content: result.content } };
    },
    request: () => getOAuthRequest(name, definition.url!, getAuthBaseDir(), runtime),
    seed: (scope: string | undefined, refresh = false) => updateTokens(name, { accessToken: scope?.includes("write") ? "wide-token" : "basic-token", ...(scope !== undefined ? { scope } : {}), ...(refresh ? { refreshToken: "refresh-basic" } : {}), issuer: origin }, definition.url!),
    stored: () => getAuthForUrl(name, definition.url!),
  };
}

describe("OAuth permission recovery through native HTTP and production hosts", () => {
  it.each(["tools/list", "prompts/list", "resources/list"])("activates implicit OAuth for protected %s", async method => {
    const f = await fixture(); f.controls.protectedMethod = method;
    expect((await f.connect()).status).toBe("needs-auth");
    await f.manual();
    await f.manager.close(f.name);
    expect((await f.connect()).status).toBe("connected");
    expect(f.exchanges).toHaveLength(1);
  });

  it("uses a saved token after wholly public bootstrap and a first protected tool", async () => {
    const f = await fixture(); f.seed("basic write");
    expect((await f.connect()).status).toBe("connected");
    expect((await f.call()).details.error).toBeUndefined();
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
    expect(f.exchanges).toHaveLength(0);
  });

  it.each([false, true])("carries a configured basic grant into manual write consent (refresh=%s)", async refresh => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed("basic", refresh);
    await f.connect();
    expect((await f.call()).details.error).toBe("auth_required");
    const url = await f.manual();
    expect(scopes(new URL(url).searchParams.get("scope"))).toEqual(["basic", "write"]);
    expect(scopes(f.exchanges[0].get("scope"))).toEqual(["basic", "write"]);
    expect(f.exchanges[0].get("grant_type")).toBe("authorization_code");
    expect((await f.stored())?.tokens?.scope).toBe("basic write");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it.each(["manual", "http", "authenticate"])("validates issuer before provider error on the %s callback path", async path => {
    const f = await fixture();
    const marker = "UNTRUSTED_CALLBACK_MARKER";
    const callback = (url: string) => {
      const authorization = new URL(url);
      return `${authorization.searchParams.get("redirect_uri")}?${new URLSearchParams({ state: authorization.searchParams.get("state")!, iss: "http://wrong.invalid", error: "access_denied", error_description: marker })}`;
    };
    if (path === "authenticate") {
      browser.open.mockImplementation(async (url: string) => {
        const response = await fetch(callback(url));
        expect(response.status).toBe(400); expect(await response.text()).not.toContain(marker);
      });
      const outcome = await settled(authenticate(f.name, f.definition.url!, f.definition, { runtime: f.runtime }));
      expect(outcome).toMatchObject({ status: "rejected", reason: { message: expect.not.stringContaining(marker) } });
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    } else {
      const { authorizationUrl } = await f.start();
      if (path === "manual") {
        const outcome = await settled(completeAuthFromInput(f.name, callback(authorizationUrl), { runtime: f.runtime }));
        expect(outcome).toMatchObject({ status: "rejected", reason: { message: expect.not.stringContaining(marker) } });
      } else {
        const response = await fetch(callback(authorizationUrl));
        expect(response.status).toBe(400); expect(await response.text()).not.toContain(marker);
      }
    }
    expect(f.exchanges).toHaveLength(0);
  });

  for (const era of ["legacy", "modern"] as const) {
    for (const host of ["proxy", "direct", "script"] as const) {
      it.each([[false, false], [false, true], [true, false], [true, true]])(`${era} ${host} warm scope policy autoAuth=%s UI=%s`, async (autoAuth, ui) => {
        const f = await fixture(era); f.definition.auth = "oauth"; f.seed("basic"); f.signIn();
        f.state.config.settings!.autoAuth = autoAuth;
        if (ui) f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
        await f.connect();
        const result = await f.callHost(host);
        const eligible = autoAuth && ui;
        expect(result).toMatchObject(eligible ? { ok: true, data: content("write") } : { ok: false, error: { code: "auth_required" } });
        expect(browser.open).toHaveBeenCalledTimes(eligible ? 1 : 0);
        expect(f.authorizations).toHaveLength(eligible ? 1 : 0);
        expect(f.exchanges).toHaveLength(eligible ? 1 : 0);
        expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(eligible ? 2 : 1);
        if (eligible) expect(scopes(f.authorizations[0].searchParams.get("scope"))).toEqual(["basic", "write"]);
      });
    }
    it.each([401, 403])(`${era} first protected tool %s activates once with stored tokens and survives replacement`, async status => {
      const f = await fixture(era); f.controls.challengeStatus = status; f.seed("basic write");
      await f.connect();
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
      const old = f.manager.getConnection(f.name)!;
      await f.manager.reconnect(f.name, f.definition, old);
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(3);
      expect(f.authorizations).toHaveLength(0); expect(f.exchanges).toHaveLength(0);
    });
    it.each([401, 403])(`${era} first protected tool %s activates then permits only one auth flow`, async status => {
      const f = await fixture(era); f.controls.challengeStatus = status; f.signIn();
      f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
      await f.connect();
      const result = await f.call();
      // A first 401 only asks for basic, so its one consent cannot also escalate to write.
      expect(result.details.error).toBe(status === 403 ? undefined : "auth_required");
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(3);
      expect(f.exchanges).toHaveLength(1);
      if (status === 401) {
        expect(f.request()?.challenge?.requiredScope).toBe("write");
        expect((await f.call()).details.error).toBeUndefined();
        expect(browser.open).toHaveBeenCalledTimes(2);
      }
    });
  }

  it("does not turn a warm refresh fetch failure into automatic consent or tool replay", async () => {
    const f = await fixture("modern"); f.definition.auth = "oauth"; f.definition.retryOnTransportFailure = true;
    f.seed("basic", true); f.controls.tokenFailure = true; f.controls.toolStatuses = [401]; f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    expect((await f.call()).details.error).toBe("call_failed");
    expect(browser.open).not.toHaveBeenCalled(); expect(f.authorizations).toHaveLength(0);
    expect(f.exchanges).toHaveLength(1); expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(1);
  });

  it.each(["manual", "http"])("rejects an unverifiable error without metadata on %s but keeps code fallback", async path => {
    const f = await fixture(); f.controls.metadataAbsent = true;
    const { authorizationUrl } = await f.start();
    const auth = new URL(authorizationUrl);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, iss: f.origin, error: "access_denied", error_description: "UNVERIFIABLE_MARKER" }).toString();
    if (path === "manual") {
      await expect(completeAuthFromInput(f.name, callback.href, { runtime: f.runtime })).rejects.toThrow("Cannot verify");
    } else {
      const response = await fetch(callback); expect(response.status).toBe(400); expect(await response.text()).not.toContain("UNVERIFIABLE_MARKER");
      const codeCallback = await f.authorize(authorizationUrl);
      expect(await completeAuthFromInput(f.name, codeCallback, { runtime: f.runtime })).toBe("authenticated");
    }
  });

  it.each(["tools/call", "prompts/get", "resources/read", "tools/list", "prompts/list", "resources/list"])("captures native %s before formatting without changing stored tokens", async method => {
    const f = await fixture("modern"); f.definition.auth = "oauth"; f.seed("basic");
    const dir = await mkdtemp(join(tmpdir(), "oauth-trace-")); cleanups.unshift(() => rm(dir, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(dir, "trace.jsonl") });
    const connection = await f.connect(); const before = await f.stored();
    f.controls.protectedMethod = method; f.controls.protectScope = true;
    const operation = method === "prompts/get" ? f.manager.getPrompt(f.name, "prompt")
      : method === "resources/read" ? f.manager.readResource(f.name, "test://document")
      : method === "tools/list" ? connection.client.listTools(undefined, { cacheMode: "refresh" })
      : method === "prompts/list" ? connection.client.listPrompts(undefined, { cacheMode: "refresh" })
      : method === "resources/list" ? connection.client.listResources(undefined, { cacheMode: "refresh" })
      : connection.client.callTool({ name: "write" });
    await expect(operation).rejects.toBeInstanceOf(InsufficientScopeError);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    expect(await f.stored()).toEqual(before); expect(browser.open).not.toHaveBeenCalled();
    const { authorizationUrl } = await f.start();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic", "write"]);
  });

  it.each(["tools", "prompts", "resources"])("retains %s list-change challenges from the native refresh", async catalog => {
    const f = await fixture(); f.definition.auth = "oauth"; f.controls.notifications = true; f.seed("basic");
    await f.connect(); await expect.poll(() => f.controls.stream).toBeDefined();
    f.controls.protectedMethod = `${catalog}/list`; f.controls.protectScope = true;
    f.controls.stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/${catalog}/list_changed` })}\n\n`);
    await expect.poll(() => f.request()?.challenge?.requiredScope).toBe("write");
    expect(f.requests.filter(r => r.method === `${catalog}/list`)).toHaveLength(2);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("captures modern pre-Protocol discovery scope and never reads credentials for a public bootstrap", async () => {
    const f = await fixture("modern");
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try { expect((await f.connect()).status).toBe("connected"); }
    finally { process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"; }
    expect(f.request()).toBeUndefined();
    await f.manager.close(f.name);
    f.controls.protectedMethod = "server/discover"; f.controls.challengeStatus = 403;
    expect((await f.connect()).status).toBe("needs-auth");
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    const { authorizationUrl } = await f.start();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toContain("write");
  });

  it.each([{ auth: false }, { oauth: false }, { auth: "bearer", bearerToken: "header-token" }, { headers: { Authorization: "Bearer header-token" } }, { disabled: true }] as ServerEntry[])("does not recover OAuth for excluded mode %j", async options => {
    const f = await fixture(); Object.assign(f.definition, options); f.controls.challengeStatus = 403;
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    if (!options.disabled) await f.connect();
    expect((await f.call()).details.error).toBe(options.disabled ? "server_disabled" : "call_failed");
    expect(f.request()).toBeUndefined(); expect(browser.open).not.toHaveBeenCalled(); expect(f.exchanges).toHaveLength(0);
  });

  it("keeps explicit OAuth with custom headers eligible but ordinary forbidden errors terminal", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.headers = { "X-Test": "yes" }; f.seed("basic"); f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect(); f.controls.genericForbidden = true;
    expect((await f.call()).details.error).toBe("call_failed"); expect(f.request()).toBeUndefined();
    f.controls.genericForbidden = false;
    expect((await f.call()).details.error).toBeUndefined(); expect(browser.open).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps native M2M step-up and retry exhaustion (implicit=%s)", async implicit => {
    const f = await fixture("modern"); if (!implicit) f.definition.auth = "oauth";
    f.definition.oauth = { grantType: "client_credentials", clientId: "machine", clientSecret: "secret" }; f.seed("basic");
    f.state.config.settings!.autoAuth = true;
    await f.connect();
    expect((await f.call()).details.error).toBeUndefined();
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(implicit ? 3 : 2);
    expect(f.exchanges.map(p => p.get("grant_type"))).toEqual(["client_credentials"]);
    expect(scopes(f.exchanges[0].get("scope"))).toEqual(["basic", "write"]);
    f.controls.toolStatuses = [403, 403, 403];
    expect((await f.call()).details.error).toBe("call_failed");
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(implicit ? 5 : 4);
    expect(f.exchanges).toHaveLength(2); expect(browser.open).not.toHaveBeenCalled();
  });

  it("keeps exhausted native interactive 401 terminal with autoAuth enabled", async () => {
    const f = await fixture("modern"); f.definition.auth = "oauth"; f.seed("basic", true); f.controls.toolStatuses = [401, 401]; f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    expect((await f.call()).details.error).toBe("call_failed");
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
    expect(f.exchanges).toHaveLength(1); expect(f.exchanges[0].get("grant_type")).toBe("refresh_token");
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each([null, "basic"])("keeps a %s issued scope truthful and limits each later invocation", async grant => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed("basic");
    f.controls.issuedScope = grant; f.signIn(); f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    for (let invocation = 1; invocation <= 2; invocation++) {
      expect((await f.call()).details.error).toBe("auth_required");
      expect(browser.open).toHaveBeenCalledTimes(invocation);
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(invocation * 2);
      expect(f.exchanges).toHaveLength(invocation);
      expect((await f.stored())?.tokens?.scope).toBe(grant ?? undefined);
      expect(f.request()?.challenge?.requiredScope).toBe("write");
    }
  });

  it.each([undefined, "basic"])("bounds a missing/same required scope (%s) without fabricated grants", async required => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed("basic", true);
    f.controls.requiredScope = required; f.controls.toolStatuses = [403, 403]; f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect(); expect((await f.call()).details.error).toBe("auth_required");
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
    expect(f.exchanges).toHaveLength(1); expect(f.exchanges[0].get("grant_type")).toBe("refresh_token");
    expect(browser.open).not.toHaveBeenCalled(); expect((await f.stored())?.tokens?.scope).toBe("basic");
  });

  for (const era of ["legacy", "modern"] as const) {
    it.each([403, 401, 404, 503, 0])(`${era} post-auth %s is terminal without stacking transport/session retries`, async second => {
      const f = await fixture(era); f.definition.auth = "oauth"; f.definition.retryOnTransportFailure = true; f.seed("basic");
      f.controls.toolStatuses = [403, second]; f.signIn(); f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
      await f.connect(); expect((await f.call()).details.error).toBe(second === 403 ? "auth_required" : "call_failed");
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
      expect(browser.open).toHaveBeenCalledTimes(1); expect(f.exchanges).toHaveLength(1);
    });
    it(`${era} terminal transport/session retry retains scope without restarting auth`, async () => {
      const f = await fixture(era); f.definition.auth = "oauth"; f.definition.retryOnTransportFailure = true; f.seed("basic");
      f.controls.toolStatuses = [era === "legacy" ? 404 : 503, 403]; f.signIn();
      f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
      await f.connect(); expect((await f.call()).details.error).toBe("auth_required");
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
      expect(browser.open).not.toHaveBeenCalled(); expect(f.request()?.challenge?.requiredScope).toBe("write");
    });
  }

  it("forces consent when the stored basic token omits scope without changing it on observation", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed(undefined, true);
    await f.connect(); const before = await f.stored();
    expect((await f.call()).details.error).toBe("auth_required"); expect(await f.stored()).toEqual(before);
    const url = await f.manual();
    expect(scopes(new URL(url).searchParams.get("scope"))).toEqual(["basic", "write"]);
    expect(f.exchanges[0].get("grant_type")).toBe("authorization_code");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it.each(["runtime", "url", "storage"])("does not share permission intent across a different %s binding", async binding => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed("basic");
    await f.connect(); await f.call();
    const other = await fixture();
    const runtime = binding === "runtime" ? other.runtime : f.runtime;
    const url = binding === "url" ? other.definition.url! : f.definition.url!;
    const authStorageOptions = binding === "storage" ? { baseDir: join(tmpdir(), crypto.randomUUID()) } : {};
    expect(getOAuthRequest(f.name, url, getAuthBaseDir(authStorageOptions), runtime)).toBeUndefined();
    const { authorizationUrl } = await startAuth(f.name, url, { ...f.definition, url }, { runtime, authStorageOptions });
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic"]);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
  });

  it("retains only scope intent after cancellation and rejects a changed known issuer", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic");
    await f.connect(); await f.call();
    const controller = new AbortController();
    await expect(authenticate(f.name, f.definition.url!, f.definition, { runtime: f.runtime, signal: controller.signal,
      onAuthorizationUrl: () => controller.abort(new Error("cancel consent")),
    })).rejects.toThrow("cancel consent");
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.request()?.issuer).toBe(f.origin); expect(f.request()?.challenge?.requiredScope).toBe("write");
    f.controls.issuerPath = "/changed";
    await expect(f.start()).rejects.toThrow("issuer changed");
    expect(f.exchanges).toHaveLength(0); expect(f.authorizations).toHaveLength(0);
    await removeAuth(f.name, { runtime: f.runtime }); expect(f.request()).toBeUndefined();
  });

  it("keeps a pending URL and verifier immutable when a wider challenge arrives", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.seed("basic");
    await f.connect(); await f.call();
    const first = await f.start();
    f.controls.requiredScope = "admin"; await f.call();
    expect(await f.start()).toEqual(first);
    const callback = await f.authorize(first.authorizationUrl);
    expect(await completeAuthFromInput(f.name, callback, { runtime: f.runtime })).toBe("authenticated");
    expect((await f.stored())?.tokens?.scope).toBe("basic write");
    expect(scopes(f.exchanges[0].get("scope"))).toEqual(["basic", "write"]);
    expect(scopes(f.request()?.challenge?.requiredScope)).toEqual(["admin", "write"]);
    expect((await f.call()).details.error).toBeUndefined();
    const next = await f.start();
    expect(scopes(new URL(next.authorizationUrl).searchParams.get("scope"))).toEqual(["admin", "basic", "write"]);
    expect(new URL(next.authorizationUrl).searchParams.get("state")).not.toBe(new URL(first.authorizationUrl).searchParams.get("state"));
    expect(new URL(next.authorizationUrl).searchParams.get("code_challenge")).not.toBe(new URL(first.authorizationUrl).searchParams.get("code_challenge"));
  });

  it("shares one automatic flow and replacement between concurrent challenged callers", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic"); f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    const results = await Promise.all([f.call(), f.call()]);
    for (const result of results) expect(result.details.error).toBeUndefined();
    expect(browser.open).toHaveBeenCalledTimes(1); expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(4);
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(0);
  });

  it("does not give an initial-auth invocation another consent for its later scope challenge", async () => {
    const f = await fixture(); f.controls.protectedMethod = "initialize"; f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    expect((await f.connect()).status).toBe("needs-auth");
    expect((await f.call()).details.error).toBe("auth_required");
    expect(browser.open).toHaveBeenCalledTimes(1); expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
  });

  it.each(["discovery", "callback", "token"])("aborts scope authorization during %s without late token saves or dispatch", async phase => {
    const f = await fixture("modern"); f.definition.auth = "oauth"; f.seed("basic");
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect(); const before = await f.stored();
    const saveTokens = vi.spyOn(McpOAuthProvider.prototype, "saveTokens");
    const controller = new AbortController();
    if (phase === "discovery") f.controls.holdDiscovery = true;
    if (phase === "token") { f.controls.holdToken = true; f.signIn(); }
    const call = f.call("write", controller.signal);
    await expect.poll(() => phase === "discovery" ? f.controls.discoveryHeld : phase === "callback" ? browser.open.mock.calls.length > 0 : f.exchanges.length > 0).toBe(true);
    controller.abort(new Error("caller cancelled"));
    expect((await call).details.error).toBe("aborted");
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    f.controls.releaseToken();
    if (phase === "token") {
      await expect.poll(() => saveTokens.mock.calls.length).toBe(1);
      await expect(saveTokens.mock.results[0].value).rejects.toThrow("no longer active");
    } else expect(saveTokens).not.toHaveBeenCalled();
    expect((await f.stored())?.tokens).toEqual(before?.tokens);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
  });

  it.each(["abort", "deadline"])("keeps auth-driven reconnect shared after one caller's %s", async cancellation => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic");
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    browser.open.mockImplementation(async (url: string) => { f.controls.holdCatalog = true; await fetch(await f.authorize(url)); });
    if (cancellation === "deadline") f.definition.requestTimeoutMs = 300;
    const controller = new AbortController();
    const first = f.call("write", controller.signal);
    await expect.poll(() => f.controls.catalogHeld).toBe(true);
    f.definition.requestTimeoutMs = 3000;
    const second = f.call("effect");
    if (cancellation === "abort") controller.abort(new Error("caller cancelled"));
    expect((await first).details.error).toBe(cancellation === "abort" ? "aborted" : "call_failed");
    f.controls.holdCatalog = false; f.controls.releaseCatalog();
    expect((await second).details.error).toBeUndefined();
    expect(f.requests.filter(r => r.name === "write")).toHaveLength(1);
    expect(f.requests.filter(r => r.name === "effect")).toHaveLength(1);
  });

  it("script timeout cancels native callback waiting and its outstanding tool", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic");
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    await f.connect();
    const result = await runMcpScript(f.state, `return await tools.call(${JSON.stringify(f.toolName("write"))}, {});`, 300);
    expect(result.details.error).toBe("timeout");
    await expect.poll(() => hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(1); expect(f.exchanges).toHaveLength(0);
  });

  it("manual auth-start keeps its five-minute flow after the originating tool ends", async () => {
    const f = await fixture(); const controller = new AbortController();
    const result = await executeAuthStart(f.state, f.name, controller.signal);
    controller.abort(new Error("tool finished"));
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    const callback = await f.authorize(result.details.authorizationUrl as string);
    expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(true);
    expect(f.exchanges).toHaveLength(1);
  });

  for (const path of ["url", "query", "fragment", "http", "automatic"] as const) {
    it.each(["wrong-state", "missing-state", "wrong-issuer", "missing-issuer", "trailing-slash", "unexpected-issuer"])(`${path} validates callback errors before presentation: %s`, async invalid => {
      const f = await fixture(); if (invalid === "unexpected-issuer") f.controls.issuerRequired = false;
      const controller = new AbortController(); const marker = "UNTRUSTED_ERROR_MARKER";
      const makeCallback = (authorizationUrl: string) => {
        const authorization = new URL(authorizationUrl);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, iss: f.origin, error: "access_denied", error_description: marker }).toString();
        if (invalid === "wrong-state") callback.searchParams.set("state", "wrong");
        if (invalid === "missing-state") callback.searchParams.delete("state");
        if (invalid === "missing-issuer") callback.searchParams.delete("iss");
        if (invalid === "wrong-issuer" || invalid === "unexpected-issuer") callback.searchParams.set("iss", "http://wrong.invalid/UNTRUSTED_ISSUER");
        if (invalid === "trailing-slash") callback.searchParams.set("iss", `${f.origin}/`);
        return callback;
      };
      if (path === "automatic") {
        browser.open.mockImplementation(async (url: string) => {
          const response = await fetch(makeCallback(url));
          expect(response.status).toBe(400);
          const html = await response.text(); expect(html).not.toContain(marker); expect(html).not.toContain("UNTRUSTED_ISSUER");
          if (invalid.includes("state")) controller.abort(new Error("wrong state did not settle the waiter"));
        });
        const result = await settled(authenticate(f.name, f.definition.url!, f.definition, { runtime: f.runtime, signal: controller.signal }));
        expect(result).toMatchObject({ status: "rejected", reason: { message: expect.not.stringContaining(marker) } });
        expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
      } else {
        const callback = makeCallback((await f.start()).authorizationUrl);
        if (path === "http") {
          const response = await fetch(callback); expect(response.status).toBe(400);
          const html = await response.text(); expect(html).not.toContain(marker); expect(html).not.toContain("UNTRUSTED_ISSUER");
          expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
        } else {
          const input = path === "query" ? callback.search : path === "fragment" ? `${callback.origin}${callback.pathname}#${callback.search.slice(1)}` : callback.href;
          const result = await settled(completeAuthFromInput(f.name, input, { runtime: f.runtime }));
          expect(result).toMatchObject({ status: "rejected", reason: { message: expect.not.stringContaining(marker) } });
          expect(String(result.status === "rejected" ? result.reason : "")).not.toContain("UNTRUSTED_ISSUER");
          expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(invalid.includes("state") || invalid === "missing-issuer");
        }
      }
      expect(f.exchanges).toHaveLength(0);
    });
  }

  it.each(["manual", "automatic"])("presents only a verified provider denial on %s and preserves the existing retry policy", async mode => {
    const f = await fixture(); const description = '<script>legitimate denial</script>';
    const errorCallback = (url: string) => {
      const auth = new URL(url); const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, iss: f.origin, error: "access_denied", error_description: description }).toString();
      return callback;
    };
    if (mode === "manual") {
      const { authorizationUrl } = await f.start(); const callback = errorCallback(authorizationUrl);
      const response = await fetch(callback); expect(response.status).toBe(200);
      const html = await response.text(); expect(html).toContain("&lt;script&gt;legitimate denial&lt;/script&gt;"); expect(html).not.toContain(description);
      await expect(completeAuthFromInput(f.name, callback.href, { runtime: f.runtime })).rejects.toThrow(description);
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
      expect(await completeAuthFromInput(f.name, await f.authorize(authorizationUrl), { runtime: f.runtime })).toBe("authenticated");
      expect(f.exchanges).toHaveLength(1);
    } else {
      f.definition.auth = "oauth"; f.seed("basic"); await f.connect(); await f.call();
      browser.open.mockImplementation(async (url: string) => {
        const response = await fetch(errorCallback(url)); expect(response.status).toBe(200);
        expect(await response.text()).toContain("&lt;script&gt;legitimate denial&lt;/script&gt;");
      });
      await expect(authenticate(f.name, f.definition.url!, f.definition, { runtime: f.runtime })).rejects.toThrow(description);
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
      expect(f.request()?.challenge?.requiredScope).toBe("write"); expect(f.exchanges).toHaveLength(0);
    }
  });

  it("isolates concurrent callback states and issuers and rejects wrong endpoints and late callbacks", async () => {
    const a = await fixture(); const b = await fixture();
    const first = await a.start(); const second = await b.start();
    const callbackA = new URL(await a.authorize(first.authorizationUrl));
    const callbackB = new URL(await b.authorize(second.authorizationUrl));
    const wrongEndpoint = new URL(callbackA); wrongEndpoint.pathname = "/wrong";
    expect((await fetch(wrongEndpoint)).status).toBe(404);
    const mixed = new URL(callbackA); mixed.searchParams.set("iss", b.origin); mixed.searchParams.set("error", "MARKER"); mixed.searchParams.delete("code");
    const rejected = await fetch(mixed); expect(rejected.status).toBe(400); expect(await rejected.text()).not.toContain("MARKER");
    expect(hasPendingAuth(a.name, undefined, a.runtime)).toBe(true); expect(hasPendingAuth(b.name, undefined, b.runtime)).toBe(true);
    expect((await fetch(callbackB)).status).toBe(200);
    expect(await completeAuthFromInput(b.name, callbackB.href, { runtime: b.runtime })).toBe("authenticated");
    expect(await completeAuthFromInput(a.name, callbackA.href, { runtime: a.runtime })).toBe("authenticated");
    expect((await a.stored())?.tokens?.issuer).toBe(a.origin); expect((await b.stored())?.tokens?.issuer).toBe(b.origin);
    expect((await fetch(callbackA)).status).toBe(400); expect((await fetch(callbackB)).status).toBe(400);
    expect(a.exchanges).toHaveLength(1); expect(b.exchanges).toHaveLength(1);
  });

  it.each(["automatic", "panel-auth", "panel-reset"])("preserves accepted work only for the %s auth handoff", async mode => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic"); f.controls.holdEffect = true; f.signIn();
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    let received!: () => void; const headers = new Promise<void>(resolve => { received = resolve; }); const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => { const response = await nativeFetch(...args); if (response.headers.has("x-accepted-effect")) received(); return response; });
    const old = await f.connect(); const close = vi.spyOn(old.client, "close");
    const effect = f.call("effect"); await headers;
    let panel: ReturnType<typeof createMcpPanel> | undefined; let panelFlow: Promise<unknown> | undefined;
    if (mode === "automatic") {
      expect((await f.call()).details.error).toBeUndefined();
    } else {
      const ctx = { hasUI: true, mode: "tui", cwd: process.env.HOME!, isProjectTrusted: () => true,
        ui: { notify: vi.fn(), setStatus: vi.fn(), custom: (build: any) => { panel = build({ requestRender: vi.fn() }, {}, undefined, () => {}); } },
      } as any;
      panelFlow = openMcpAuthPanel(f.state, ctx);
      expect(panel).toBeDefined();
      panel!.handleInput(mode === "panel-auth" ? "\x01" : "\x12");
      await expect.poll(() => f.manager.getConnection(f.name)).not.toBe(old);
      await expect.poll(() => f.manager.getConnection(f.name)?.status).toBe("connected");
    }
    if (mode === "panel-reset") {
      expect((await effect).details.error).toBe("call_failed"); expect(close).toHaveBeenCalledTimes(1);
      expect(browser.open).not.toHaveBeenCalled();
    } else {
      expect(close).not.toHaveBeenCalled(); expect(f.manager.getConnection(f.name)?.inFlight).toBe(1);
      f.controls.releaseEffect(); expect((await effect).details.error).toBeUndefined();
      await expect.poll(() => close.mock.calls.length).toBe(1);
      expect(f.manager.getConnection(f.name)?.inFlight).toBe(0);
    }
    expect(f.controls.effectCount).toBe(1); expect(f.requests.filter(r => r.name === "effect")).toHaveLength(1);
    if (panel) { panel.handleInput("\x1b"); await panelFlow; panel.dispose(); }
  });

  it.each([true, false])("registered /mcp command preserves accepted work only after auth (afterAuth=%s)", async afterAuth => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic"); f.controls.holdEffect = true; f.signIn();
    const tools = new Map<string, any>(); const commands = new Map<string, any>(); const handlers = new Map<string, any>();
    const api = { events: new EventEmitter(), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
      registerFlag: () => {}, on: (name: string, handler: any) => handlers.set(name, handler), getFlag: () => undefined,
      getActiveTools: () => [...tools.keys()], setActiveTools: () => {}, getAllTools: () => [], sendMessage: () => {},
    } as any;
    const ctx = { hasUI: true, mode: "tui", cwd: process.env.HOME!, isProjectTrusted: () => true, ui: { setStatus: vi.fn(), notify: vi.fn() } } as any;
    const connecting = vi.spyOn(McpServerManager.prototype, "connect");
    createMcpAdapter({ config: { mcpServers: { [f.name]: f.definition }, settings: { sampling: false, elicitation: false } } })(api);
    await handlers.get("session_start")({}, ctx);
    cleanups.push(() => handlers.get("session_shutdown")({}, ctx));
    await tools.get("mcp").execute("connect", { connect: f.name }, undefined, undefined, ctx);
    const manager = connecting.mock.contexts.find(candidate => candidate !== f.manager)!;
    const old = manager.getConnection(f.name)!; const close = vi.spyOn(old.client, "close");
    let received!: () => void; const headers = new Promise<void>(resolve => { received = resolve; }); const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => { const response = await nativeFetch(...args); if (response.headers.has("x-accepted-effect")) received(); return response; });
    const effect = tools.get("mcp").execute("effect", { tool: f.toolName("effect"), args: {} }, undefined, undefined, ctx);
    await headers;
    await commands.get(afterAuth ? "mcp-auth" : "mcp").handler(afterAuth ? f.name : `reconnect ${f.name}`, ctx);
    if (afterAuth) {
      expect(close).not.toHaveBeenCalled(); f.controls.releaseEffect(); expect((await effect).details.error).toBeUndefined();
      await expect.poll(() => close.mock.calls.length).toBe(1);
    } else {
      expect((await effect).details.error).toBe("call_failed"); expect(close).toHaveBeenCalledTimes(1); expect(browser.open).not.toHaveBeenCalled();
    }
    expect(f.controls.effectCount).toBe(1); expect(f.requests.filter(r => r.name === "effect")).toHaveLength(1);
    expect(manager.getConnection(f.name)).not.toBe(old);
  });

  it("carries native offline_access additions through the frozen step-up code exchange", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "basic" }; f.controls.offlineAccess = true; f.seed("basic");
    await f.connect(); await f.call();
    const authorizationUrl = await f.manual();
    const requested = scopes(new URL(authorizationUrl).searchParams.get("scope"));
    expect(requested).toEqual(["basic", "offline_access", "write"]);
    expect(scopes(f.exchanges[0].get("scope"))).toEqual(requested);
    expect(scopes(f.request()?.requestedScope)).toEqual(requested);
    expect((await f.call()).details.error).toBeUndefined();
  });

  for (const era of ["legacy", "modern"] as const) {
    it.each(["handshake", "tools/list", "prompts/list", "resources/list"])(`${era} activates a fresh runtime's stored token at %s without consent`, async phase => {
      const f = await fixture(era); f.seed("basic write");
      const method = phase === "handshake" ? era === "legacy" ? "initialize" : "server/discover" : phase;
      f.controls.protectedMethod = method;
      expect((await f.connect()).status).toBe("connected");
      expect(f.requests.filter(r => r.method === method)).toHaveLength(2);
      expect(f.exchanges).toHaveLength(0); expect(browser.open).not.toHaveBeenCalled();
      f.controls.protectedMethod = "";
      await f.manager.reconnect(f.name, f.definition, f.manager.getConnection(f.name)!);
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(1);
    });
    it.each([401, 403])(`${era} manual first-tool %s handoff needs no extra sign-in to use the saved token`, async status => {
      const f = await fixture(era); f.controls.challengeStatus = status; if (status === 401) f.controls.accessScope = "basic";
      await f.connect(); expect((await f.call()).details.error).toBe("auth_required");
      const { authorizationUrl } = await f.start(); const callback = await f.authorize(authorizationUrl);
      expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(true);
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(3);
      expect(f.authorizations).toHaveLength(1); expect(f.exchanges).toHaveLength(1); expect(browser.open).not.toHaveBeenCalled();
      await f.manager.reconnect(f.name, f.definition, f.manager.getConnection(f.name)!);
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.authorizations).toHaveLength(1); expect(f.exchanges).toHaveLength(1);
    });
  }

  it.each(["tools/list", "prompts/list", "resources/list"])("completes modern implicit manual auth after a protected %s catalog", async method => {
    const f = await fixture("modern"); f.controls.protectedMethod = method;
    expect((await f.connect()).status).toBe("needs-auth");
    await f.manual();
    expect((await f.connect()).status).toBe("connected");
    expect(f.exchanges).toHaveLength(1); expect(browser.open).not.toHaveBeenCalled();
  });

  for (const status of [404, 405]) {
    it.each(["tools/list", "prompts/list", "resources/list"])(`does not use SSE fallback for %s catalog HTTP${status}`, async method => {
      const f = await fixture("modern"); f.controls.catalogFailure = { method, status };
      if (method === "tools/list") await expect(f.connect()).rejects.toThrow();
      else expect((await f.connect()).status).toBe("connected");
      expect(f.http.filter(request => request.method === "GET" && request.path === "/mcp")).toHaveLength(0);
      expect(f.requests.filter(request => request.method === "server/discover")).toHaveLength(1);
      expect(f.request()).toBeUndefined();
    });
  }

  it("allows a retired native operation to retain its late scope challenge until explicit shutdown", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic"); f.controls.holdResource = true;
    const old = await f.connect(); const close = vi.spyOn(old.client, "close");
    const resource = settled(f.manager.readResource(f.name, "test://document"));
    await expect.poll(() => f.controls.resourceHeld).toBe(true);
    const fresh = await f.manager.reconnect(f.name, f.definition, old);
    expect(close).not.toHaveBeenCalled(); f.controls.rejectResource();
    expect(await resource).toMatchObject({ status: "rejected", reason: expect.any(InsufficientScopeError) });
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    expect(f.manager.getConnection(f.name)).toBe(fresh); expect(fresh.inFlight).toBe(0);
    await expect.poll(() => close.mock.calls.length).toBe(1);
    await shutdownOAuth(f.runtime); expect(f.request()).toBeUndefined();
  });

  it("logout clears only the exact server name even when another name contains its delimiter", async () => {
    const a = await fixture("legacy", "a"); const b = await fixture("legacy", "a|b");
    b.manager.setOAuthRuntime(a.runtime);
    for (const f of [a, b]) {
      f.definition.auth = "oauth"; f.seed("basic");
      const connection = await f.connect(); await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(InsufficientScopeError);
    }
    expect(getOAuthRequest(b.name, b.definition.url!, getAuthBaseDir(), a.runtime)?.challenge?.requiredScope).toBe("write");
    await removeAuth(a.name, { runtime: a.runtime });
    expect(a.request()).toBeUndefined();
    expect(getOAuthRequest(b.name, b.definition.url!, getAuthBaseDir(), a.runtime)?.challenge?.requiredScope).toBe("write");
  });

  it("keeps legal server-name/storage tuples separate even when delimiter joining collides", async () => {
    const a = await fixture("legacy", "a"); const b = await fixture("legacy", "a|/b");
    a.manager.setAuthStorageOptions({ baseDir: "/b|/c" }); b.manager.setAuthStorageOptions({ baseDir: "/c" }); b.manager.setOAuthRuntime(a.runtime);
    b.definition.url = a.definition.url;
    for (const f of [a, b]) {
      f.definition.auth = "oauth";
      updateTokens(f.name, { accessToken: "basic-token", scope: "basic", issuer: a.origin }, a.definition.url!);
      const connection = await f.connect(); await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(InsufficientScopeError);
      a.controls.requiredScope = "admin";
    }
    expect(getOAuthRequest(a.name, a.definition.url!, "/b|/c", a.runtime)?.challenge?.requiredScope).toBe("write");
    expect(getOAuthRequest(b.name, a.definition.url!, "/c", a.runtime)?.challenge?.requiredScope).toBe("admin");
    await removeAuth(a.name, { runtime: a.runtime });
    expect(getOAuthRequest(b.name, a.definition.url!, "/c", a.runtime)?.challenge?.requiredScope).toBe("admin");
  });

  it("does not mask a mandatory catalog failure with an optional catalog auth challenge", async () => {
    const f = await fixture("modern"); f.controls.catalogFailure = { method: "tools/list", status: 405 }; f.controls.protectedMethod = "prompts/list";
    await expect(f.connect()).rejects.toMatchObject({ status: 405 });
    expect(f.requests.filter(request => request.method === "tools/list")).toHaveLength(1);
    expect(f.requests.filter(request => request.method === "server/discover")).toHaveLength(1);
    expect(browser.open).not.toHaveBeenCalled(); expect(f.exchanges).toHaveLength(0);
  });

  it("joins auth after another caller activates the provider before a late anonymous rejection", async () => {
    const f = await fixture(); f.controls.accessScope = "basic"; f.controls.holdAnonymous = true;
    f.state.config.settings!.autoAuth = true; f.state.ui = { setStatus: vi.fn(), notify: vi.fn() } as any;
    let releaseBrowser!: () => void; const browserGate = new Promise<void>(resolve => { releaseBrowser = resolve; });
    browser.open.mockImplementation(async (url: string) => { await browserGate; await fetch(await f.authorize(url)); });
    await f.connect();
    const late = f.call(); await expect.poll(() => f.controls.anonymousHeld).toBe(true);
    const first = f.call(); await expect.poll(() => browser.open.mock.calls.length).toBe(1);
    f.controls.releaseAnonymous();
    await expect.poll(() => f.requests.filter(request => request.method === "tools/call").length).toBe(4);
    releaseBrowser();
    expect((await late).details.error).toBeUndefined(); expect((await first).details.error).toBeUndefined();
    expect(browser.open).toHaveBeenCalledTimes(1); expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter(request => request.method === "tools/call")).toHaveLength(6);
  });

  it.each([{ oauth: false }, { auth: false }, { disabled: true }] as ServerEntry[])("does not retain a live challenge after OAuth is disabled: %j", async options => {
    const f = await fixture(); f.definition.auth = "oauth"; f.seed("basic");
    const connection = await f.connect(); Object.assign(f.definition, options);
    await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(InsufficientScopeError);
    expect(f.request()).toBeUndefined(); expect(browser.open).not.toHaveBeenCalled();
  });

  it("unions explicit configured, granted, and challenged scopes without adding unrelated advertised permissions", async () => {
    const f = await fixture(); f.definition.auth = "oauth"; f.definition.oauth = { scope: "configured" }; f.seed("basic"); f.controls.advertisedScopes.push("unrelated");
    await f.connect(); await f.call();
    const authorizationUrl = await f.manual();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic", "configured", "write"]);
    expect(scopes(f.exchanges[0].get("scope"))).toEqual(["basic", "configured", "write"]);
    expect(f.definition.oauth.scope).toBe("configured");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it("manual completion retires only after an accepted effect body completes", async () => {
    const f = await fixture(); f.controls.holdEffect = true;
    let accepted!: () => void;
    const headers = new Promise<void>(resolve => { accepted = resolve; });
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await nativeFetch(...args); if (response.headers.has("x-accepted-effect")) accepted(); return response;
    });
    const old = await f.connect(); const close = vi.spyOn(old.client, "close");
    const effect = f.call("effect"); await headers;
    const { authorizationUrl } = await f.start();
    const callback = await f.authorize(authorizationUrl);
    const requestsBeforeCompletion = f.requests.length;
    expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(true);
    expect(f.requests).toHaveLength(requestsBeforeCompletion);
    expect(f.manager.getConnection(f.name)).toBe(old); expect(old.status).toBe("closed");
    expect(close).not.toHaveBeenCalled();
    f.controls.releaseEffect();
    expect((await effect).details.error).toBeUndefined();
    expect(f.controls.effectCount).toBe(1);
    expect(f.requests.filter(r => r.name === "effect")).toHaveLength(1);
    await expect.poll(() => close.mock.calls.length).toBe(1);
  });
});
