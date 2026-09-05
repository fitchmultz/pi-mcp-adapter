import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { auth, OAuthError, OAuthErrorCode, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createOAuthRuntime, extractOAuthConfig, hasPendingAuth, shutdownOAuth, startAuth } from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { McpServerManager } from "../server-manager.ts";
import { executeCall, executeAuthStart } from "../proxy-modes.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { runMcpScript } from "../mcp-code.ts";
import type { McpExtensionState } from "../state.ts";
import { withSessionRecovery } from "../session-recovery.ts";
import sharedDocument from "../docs/client-metadata.json" with { type: "json" };
import type { OAuthConfig, ServerEntry } from "../types.ts";

const browser = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0; browser.open.mockReset();
});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pi-caa-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return `http://127.0.0.1:${address.port}`;
}
function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  let data = ""; for await (const chunk of req) data += chunk;
  return data;
}
function jwt(payload: object, key: ReturnType<typeof generateKeyPairSync>["privateKey"], typ = "JWT") {
  const input = [Buffer.from(JSON.stringify({ alg: "ES256", typ })).toString("base64url"), Buffer.from(JSON.stringify(payload)).toString("base64url")].join(".");
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function claims(token: string, key: ReturnType<typeof generateKeyPairSync>["publicKey"]) {
  const [header, payload, signature] = token.split(".");
  expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
function gate() {
  let enter!: () => void, release!: () => void, disconnected!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const aborted = new Promise<void>(resolve => { disconnected = resolve; });
  let wasAborted = false;
  return { started, release, aborted, wasAborted: () => wasAborted,
    hold: async (res: ServerResponse) => {
      res.once("close", () => { if (!res.writableEnded) { wasAborted = true; disconnected(); } });
      enter(); await wait;
    },
  };
}
function nativeSends() {
  const pending = new Set<Promise<void>>();
  const send = StreamableHTTPClientTransport.prototype.send;
  const spy = vi.spyOn(StreamableHTTPClientTransport.prototype, "send").mockImplementation(function (...args) {
    const operation = send.apply(this, args); pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  });
  return { finish: async () => { while (pending.size) await Promise.allSettled([...pending]); }, restore: () => spy.mockRestore(), count: () => pending.size };
}

type Stage = "idp-discovery" | "idp-token" | "mcp-token";
async function fixture(identity: "secret" | "public" | "private" | "private-cimd" = "secret") {
  const name = `caa-${crypto.randomUUID()}`;
  const runtime = createOAuthRuntime(), manager = new McpServerManager(); manager.setOAuthRuntime(runtime);
  const idpKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const mcpKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let idp = "", as = "", resource = "";
  const id = identity.includes("cimd") || identity === "public" ? "https://caa.example/client.json" : "mcp-client";
  const holds = new Map<Stage, ReturnType<typeof gate>>();
  const idpRequests: Array<{ path: string; headers: IncomingMessage["headers"]; form?: URLSearchParams }> = [];
  const exchanges: Array<{ headers: IncomingMessage["headers"]; form: URLSearchParams }> = [];
  const requests: any[] = [], documents: string[] = [], registrations: unknown[] = [];
  const tokens = new Set<string>();
  let idToken = "", prm = true, wrongResource = false, wrongIssuer = false, wrongIdp = false, idpError: unknown, rejectTokens = false, publicMcp = false, forbidden = false, toolFailure = 0;
  let metadata = true, rejectResourceTokens = false, idpStatus = 400;
  const idpServer = createServer(async (req, res) => {
    const path = req.url!;
    const row: typeof idpRequests[number] = { path, headers: req.headers }; idpRequests.push(row);
    if (path === "/.well-known/oauth-authorization-server") return void res.writeHead(404).end();
    if (path === "/.well-known/openid-configuration") {
      await holds.get("idp-discovery")?.hold(res);
      return void json(res, { issuer: wrongIdp ? "https://wrong-idp.example" : idp, authorization_endpoint: `${idp}/authorize`, token_endpoint: `${idp}/token`, jwks_uri: `${idp}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"] });
    }
    row.form = new URLSearchParams(await body(req));
    await holds.get("idp-token")?.hold(res);
    if (idpError !== undefined) return void json(res, idpError, idpStatus);
    try {
      expect(path).toBe("/token");
      expect(Object.fromEntries(row.form)).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", requested_token_type: "urn:ietf:params:oauth:token-type:id-jag", subject_token_type: "urn:ietf:params:oauth:token-type:id_token", audience: as, resource: `${resource}/mcp`, client_id: "idp-client", subject_token: idToken });
      expect(row.form.get("client_secret")).toBe(oauth.crossAppAccess?.clientSecret === undefined ? null : "idp-secret");
      const original = claims(row.form.get("subject_token")!, idpKey.publicKey); expect(original.aud).toBe("idp-client");
      json(res, { access_token: jwt({ iss: idp, sub: "user", aud: as, resource: `${resource}/mcp`, client_id: id, exp: Math.floor(Date.now() / 1000) + 300 }, idpKey.privateKey, "oauth-id-jag+jwt"), issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", token_type: "N_A" });
    } catch { json(res, { error: "invalid_request", error_description: "fixture identity rejection" }, 400); }
  });
  idp = await listen(idpServer);
  const asServer = createServer(async (req, res) => {
    if (req.url!.startsWith("/.well-known/")) {
      if (!metadata) return void res.writeHead(404).end();
      return void json(res, { issuer: wrongIssuer ? "https://wrong-as.example" : as, authorization_endpoint: `${as}/authorize`, token_endpoint: `${as}/token`, response_types_supported: ["code"], grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_methods_supported: [identity === "secret" ? "client_secret_basic" : identity === "public" ? "none" : "private_key_jwt"], client_id_metadata_document_supported: true });
    }
    if (req.url!.startsWith("/document")) {
      documents.push(new URL(req.url!, as).searchParams.get("id")!);
      return void json(res, { client_id: id, redirect_uris: [], grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer"], token_endpoint_auth_method: identity === "public" ? "none" : "private_key_jwt", jwks: { keys: [mcpKey.publicKey.export({ format: "jwk" })] } });
    }
    const form = new URLSearchParams(await body(req));
    if (req.url === "/register") { registrations.push(Object.fromEntries(form)); return void json(res, { error: "unsupported" }, 400); }
    if (req.url !== "/token") return void res.writeHead(404).end();
    exchanges.push({ headers: req.headers, form });
    await holds.get("mcp-token")?.hold(res);
    try {
      const grant = claims(form.get("assertion")!, idpKey.publicKey);
      expect(grant).toMatchObject({ aud: as, resource: `${resource}/mcp`, client_id: id, iss: idp });
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      expect(form.get("resource")).toBe(`${resource}/mcp`);
      expect(form.has("subject_token")).toBe(false); expect(form.has("client_secret")).toBe(false);
      if (identity === "secret") expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${id}:mcp-secret`).toString("base64")}`);
      else {
        expect(form.get("client_id")).toBe(id); expect(req.headers.authorization).toBeUndefined();
        let publicKey = mcpKey.publicKey;
        if (id.startsWith("https:")) {
          const document = await (await fetch(`${as}/document?id=${encodeURIComponent(id)}`)).json();
          expect(document.client_id).toBe(id);
          expect(document.token_endpoint_auth_method).toBe(identity === "public" ? "none" : "private_key_jwt");
          publicKey = createPublicKey({ key: document.jwks.keys[0], format: "jwk" });
        }
        if (identity !== "public") expect(claims(form.get("client_assertion")!, publicKey)).toMatchObject({ iss: id, sub: id, aud: as });
        else expect(form.has("client_assertion")).toBe(false);
      }
      if (rejectTokens) return void json(res, { error: "invalid_grant" }, 400);
      const token = `access-${exchanges.length}`; tokens.add(token);
      json(res, { access_token: token, token_type: "Bearer", expires_in: 3600, scope: form.get("scope") ?? undefined });
    } catch { json(res, { error: "invalid_request", error_description: "fixture grant rejection" }, 400); }
  });
  as = await listen(asServer);
  const resourceServer = createServer(async (req, res) => {
    if (req.url!.startsWith("/.well-known/oauth-protected-resource")) {
      if (!prm) return void res.writeHead(404).end();
      return void json(res, { resource: wrongResource ? "https://wrong-resource.example/mcp" : `${resource}/mcp`, authorization_servers: [as], scopes_supported: ["tools"] });
    }
    // Discovery fallback must still reach the same AS, so missing PRM tests isolate the absent resource.
    if (req.url!.startsWith("/.well-known/")) return void json(res, { issuer: resource, authorization_endpoint: `${as}/authorize`, token_endpoint: `${as}/token`, response_types_supported: ["code"] });
    if (req.method !== "POST") return void res.writeHead(405).end();
    const message = JSON.parse(await body(req)); requests.push({ ...message, headers: req.headers });
    if (!publicMcp && (rejectResourceTokens || !tokens.has(req.headers.authorization?.replace(/^Bearer /, "") ?? ""))) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return void res.writeHead(202).end();
    if (message.method === "tools/call" && forbidden) return void res.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="extra"' }).end();
    if (message.method === "tools/call" && toolFailure++ === 0 && definition.retryOnTransportFailure) return void res.writeHead(503).end("unavailable");
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "caa", version: "1" } }
      : message.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : message.method === "tools/list" ? { ttlMs: 10000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "enterprise tool" }] };
    json(res, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } });
  });
  resource = await listen(resourceServer);
  idToken = jwt({ iss: idp, aud: "idp-client", sub: "user", exp: Math.floor(Date.now() / 1000) + 3600 }, idpKey.privateKey);
  const oauth: OAuthConfig = { ...(id.startsWith("https:") ? { clientMetadataUrl: id } : { clientId: id }),
    ...(identity === "secret" ? { clientSecret: "mcp-secret" } : identity === "public" ? {} : { privateKeyJwt: { privateKey: mcpKey.privateKey.export({ format: "jwk" }), algorithm: "ES256" } }),
    crossAppAccess: { idpUrl: idp, clientId: "idp-client", idToken, clientSecret: "idp-secret" } };
  const definition: ServerEntry = { url: `${resource}/mcp`, auth: "oauth", headers: { "X-Resource-Only": "resource-secret" }, oauth };
  const stored = () => getAuthForUrl(name, definition.url!);
  cleanups.push(async () => {
    for (const hold of holds.values()) hold.release();
    await manager.closeAll(); await shutdownOAuth(runtime);
    if (process.env.CAA_PROOF_FILE) appendFileSync(process.env.CAA_PROOF_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, node: process.version, execPath: process.execPath, identity,
      idpRequests: idpRequests.map(r => ({ path: r.path, formKeys: [...(r.form?.keys() ?? [])], audience: r.form?.get("audience"), resource: r.form?.get("resource"), scope: r.form?.get("scope"), hasResourceHeader: !!r.headers["x-resource-only"], hasAuthorization: !!r.headers.authorization })),
      mcpTokenPosts: exchanges.length, grants: exchanges.map(e => e.form.get("grant_type")), tools: requests.filter(r => r.method === "tools/call").length, holds: [...holds].map(([stage, hold]) => ({ stage, aborted: hold.wasAborted() })), documents, registrations: registrations.length })}\n`);
    clearAllCredentials(name);
    for (const server of [resourceServer, asServer, idpServer]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  return { name, runtime, manager, definition, oauth, stored, idp, as, resource, id, idpRequests, exchanges, requests, documents, registrations,
    connect: (signal?: AbortSignal) => manager.connect(name, definition, signal),
    start: (signal?: AbortSignal) => startAuth(name, definition.url!, definition, { runtime, ...(signal ? { signal } : {}) }),
    provider: () => new McpOAuthProvider(name, definition.url!, extractOAuthConfig(definition), { onRedirect: () => { browser.open(); } }, {}, runtime.signal),
    hold: (stage: Stage) => { const hold = gate(); holds.set(stage, hold); return hold; },
    expire: () => tokens.clear(), wrongResource: () => { wrongResource = true; }, wrongIssuer: () => { wrongIssuer = true; }, wrongIdp: () => { wrongIdp = true; }, noResource: () => { prm = false; }, noMetadata: () => { metadata = false; },
    rejectResource: (value: boolean) => { rejectResourceTokens = value; },
    idpError: (error: unknown, status = 400) => { idpError = error; idpStatus = status; }, rejectTokens: () => { rejectTokens = true; }, publicMcp: () => { publicMcp = true; }, forbid: () => { forbidden = true; },
    rotate: () => { idToken = jwt({ iss: idp, aud: "idp-client", sub: "user", jti: crypto.randomUUID() }, idpKey.privateKey); return idToken; },
  };
}

it.each(["secret", "public", "private", "private-cimd"] as const)("completes native two-stage enterprise authorization with %s MCP identity", async identity => {
  const f = await fixture(identity);
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  const connection = await f.connect();
  expect(await connection.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
  expect(f.exchanges).toHaveLength(1); expect(f.idpRequests.filter(r => r.form)).toHaveLength(1);
  expect(f.idpRequests.every(r => !r.headers.authorization && !r.headers["x-resource-only"])).toBe(true);
  expect(f.idpRequests.find(r => r.form)?.form?.get("scope")).toBe("tools");
  expect(f.requests.find(r => r.method === "tools/call").headers["x-resource-only"]).toBe("resource-secret");
  const saved = JSON.stringify(f.stored());
  for (const value of [f.oauth.crossAppAccess!.idToken, "idp-secret", "mcp-secret", f.exchanges[0].form.get("assertion")!]) expect(saved).not.toContain(value);
  expect(f.registrations).toHaveLength(0); expect(browser.open).not.toHaveBeenCalled(); expect(hasPendingAuth(f.name, {}, f.runtime)).toBe(false);
  if (identity === "public" || identity === "private-cimd") expect(f.stored()?.clientInfo).toMatchObject({ registrationType: "cimd", redirectUris: [] });
});

it("keeps all IdP sources lazy and renews the user-managed token without another store", async () => {
  const f = await fixture(); const dir = scratch(), token = join(dir, "token"), marker = join(dir, "reads");
  writeFileSync(token, f.oauth.crossAppAccess!.idToken);
  f.oauth.crossAppAccess = { idpUrl: "${CAA_IDP}", clientId: "!printf idp-client", idToken: `!printf x >> '${marker}'; cat '${token}'`, clientSecret: "{env:CAA_SECRET}" };
  const provider = f.provider(); void provider.clientMetadata; await provider.clientInformation();
  expect(existsSync(marker)).toBe(false);
  process.env.CAA_IDP = f.idp; process.env.CAA_SECRET = "idp-secret";
  try {
    const connection = await f.connect(); f.expire(); writeFileSync(token, f.rotate());
    expect(await connection.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
    expect(readFileSync(marker, "utf8")).toBe("xx");
    expect(f.idpRequests.filter(r => r.form).map(r => r.form!.get("subject_token"))[0]).not.toBe(f.oauth.crossAppAccess.idToken);
    expect(f.exchanges).toHaveLength(2);
  } finally { delete process.env.CAA_IDP; delete process.env.CAA_SECRET; }
});

it.each(["client", "tokens", "metadata", "resource", "missing-resource"])("rejects %s target failure before any IdP request or secret source", async failure => {
  const f = await fixture(); const marker = join(scratch(), "ran");
  f.oauth.crossAppAccess!.idToken = `!touch '${marker}'; printf TOKEN_SENTINEL`;
  if (failure === "client" || failure === "tokens") saveAuthEntry(f.name, { clientInfo: { clientId: f.id, issuer: failure === "client" ? "https://old.example" : f.as, configPreRegistered: true }, tokens: { accessToken: "old", issuer: failure === "tokens" ? "https://old.example" : f.as } }, f.definition.url!);
  if (failure === "metadata") f.wrongIssuer();
  if (failure === "resource") f.wrongResource();
  if (failure === "missing-resource") f.noResource();
  const before = f.stored();
  await expect(f.start()).rejects.toThrow();
  expect(existsSync(marker)).toBe(false); expect(f.idpRequests).toHaveLength(0); expect(f.exchanges).toHaveLength(0);
  if (before) expect(f.stored()).toEqual(before);
});

it("uses the native selected-AS fallback when MCP AS metadata is absent but PRM is valid", async () => {
  const f = await fixture("public"); f.oauth.clientId = f.id; f.noMetadata();
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.idpRequests.find(r => r.form)?.form?.get("audience")).toBe(f.as);
  expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
  expect(f.exchanges).toHaveLength(1);
});

it.each(["issued", "rejected"])("resets the native resource after an %s grant, including cached discovery with absent new metadata", async outcome => {
  const f = await fixture(); const provider = f.provider();
  if (outcome === "rejected") f.idpError({ error: "invalid_grant" });
  const first = await auth(provider, { serverUrl: f.definition.url!, fetchFn: provider.fetch }).catch(error => error);
  if (outcome === "rejected") expect(first).toBeInstanceOf(OAuthError); else expect(first).toBe("AUTHORIZED");
  f.idpError(undefined);
  await provider.saveDiscoveryState({ authorizationServerUrl: f.as, authorizationServerMetadata: { issuer: f.as, token_endpoint: `${f.as}/token`, response_types_supported: ["code"] } });
  f.noResource();
  await expect(auth(provider, { serverUrl: f.definition.url!, fetchFn: provider.fetch })).rejects.toThrow(/protected resource metadata/);
  expect(f.exchanges).toHaveLength(outcome === "rejected" ? 0 : 1); expect(f.idpRequests.filter(r => r.form)).toHaveLength(1);
});

it.each(["invalid_client", "invalid_grant", "malformed", "malformed-success", "issuer", "command", "nul"])("keeps IdP %s failures private and never erases the existing MCP login", async failure => {
  const f = await fixture(); await f.start(); const before = f.stored();
  if (failure === "issuer") f.wrongIdp();
  else if (failure === "command") f.oauth.crossAppAccess!.idToken = "!printf 'TOKEN_SENTINEL' >&2; exit 7";
  else if (failure === "nul") f.oauth.crossAppAccess!.idToken = "!printf 'TOKEN_SENTINEL'\0";
  else f.idpError(failure.startsWith("malformed") ? { raw: "TOKEN_SENTINEL" } : { error: failure, error_description: "TOKEN_SENTINEL" }, failure === "malformed-success" ? 200 : 400);
  const error = await f.start().catch(error => error);
  expect(error).toBeInstanceOf(OAuthError); expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(error.message).toContain("crossAppAccess"); expect(String(error)).not.toContain("TOKEN_SENTINEL"); expect(error.cause).toBeUndefined();
  expect(f.stored()).toEqual(before); expect(f.exchanges).toHaveLength(1); expect(browser.open).not.toHaveBeenCalled();
});

it.each(["auto", "legacy"] as const)("uses native %s capabilities and preserves scope precedence", async protocolVersion => {
  const f = await fixture(); f.definition.protocolVersion = protocolVersion; f.oauth.scope = "configured";
  await f.start(); expect(f.exchanges[0].form.get("scope")).toBe("configured"); f.expire();
  await f.connect(); expect(f.exchanges[1].form.get("scope")).toBe("tools");
  const handshakes = f.requests.filter(r => r.method === (protocolVersion === "auto" ? "server/discover" : "initialize"));
  expect(handshakes.length).toBeGreaterThanOrEqual(2);
  for (const request of handshakes) expect((protocolVersion === "auto" ? request.params._meta["io.modelcontextprotocol/clientCapabilities"] : request.params.capabilities).extensions).toEqual({ "io.modelcontextprotocol/enterprise-managed-authorization": {} });
});

it.each([false, "bearer", "implicit-header"])("does not advertise CAA for an ineligible ordinary connection (%s), but preserves explicit discovery", async mode => {
  const f = await fixture(); f.publicMcp();
  if (mode === "implicit-header") delete f.definition.auth; else f.definition.auth = mode as false | "bearer";
  await f.connect();
  expect(f.requests.find(r => r.method === "server/discover").params._meta["io.modelcontextprotocol/clientCapabilities"]?.extensions).toBeUndefined();
  await f.start();
  expect(f.requests.filter(r => r.method === "server/discover").at(-1).params._meta["io.modelcontextprotocol/clientCapabilities"].extensions).toEqual({ "io.modelcontextprotocol/enterprise-managed-authorization": {} });
});

it.each(["idp-discovery", "idp-token", "mcp-token"] as const)("actually aborts %s HTTP during explicit startAuth, not just its outward promise", async stage => {
  const f = await fixture(); const hold = f.hold(stage), controller = new AbortController();
  const pending = f.start(controller.signal).catch(error => error); await hold.started;
  const before = structuredClone(f.stored()); controller.abort();
  await hold.aborted; expect(await pending).toBeInstanceOf(Error); hold.release();
  expect(hold.wasAborted()).toBe(true); expect(f.stored()).toEqual(before);
  expect(f.exchanges).toHaveLength(stage === "mcp-token" ? 1 : 0); expect(f.runtime.signal.aborted).toBe(false);
});

it.each(["auto", "legacy"] as const)("cancels actual %s IdP exchange on individual close while sibling runtime work survives", async protocolVersion => {
  const f = await fixture(); f.definition.protocolVersion = protocolVersion;
  const sibling = await fixture(); const connected = await f.manager.connect(sibling.name, sibling.definition);
  const hold = f.hold("idp-token"), sends = nativeSends();
  try {
    const pending = f.connect().catch(error => error); await hold.started;
    const before = structuredClone(f.stored()); await f.manager.close(f.name); await hold.aborted; hold.release(); await sends.finish();
    expect(await pending).toBeInstanceOf(Error); expect(sends.count()).toBe(0); expect(f.exchanges).toHaveLength(0); expect(f.stored()).toEqual(before);
    sibling.expire(); expect(await connected.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
    expect(f.runtime.signal.aborted).toBe(false);
  } finally { hold.release(); await sends.finish(); sends.restore(); }
});

it.each(["idp-discovery", "idp-token", "mcp-token"] as const)("cancels a modern tool's %s network work without stopping a sibling", async stage => {
  const sends = nativeSends();
  const f = await fixture(), connection = await f.connect(); f.expire();
  const hold = f.hold(stage), controller = new AbortController();
  try {
    const pending = connection.client.callTool({ name: "echo" }, { signal: controller.signal }).catch(error => error);
    await hold.started; const before = structuredClone(f.stored()); controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await Promise.race([hold.aborted, new Promise(resolve => setTimeout(resolve, 100))]);
    hold.release(); await sends.finish();
    const outcome = { networkAborted: hold.wasAborted(), storageChanged: JSON.stringify(f.stored()) !== JSON.stringify(before), tokenPosts: f.exchanges.length, pendingNativeSends: sends.count() };
    if (process.env.CAA_PROOF_FILE) appendFileSync(process.env.CAA_PROOF_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, outcome })}\n`);
    expect(outcome).toEqual({ networkAborted: true, storageChanged: false, tokenPosts: stage === "mcp-token" ? 2 : 1, pendingNativeSends: 0 });
    expect(f.runtime.signal.aborted).toBe(false);
    expect(await connection.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
  } finally { hold.release(); await sends.finish(); sends.restore(); }
});

it("keeps an already-running same-provider sibling exchange alive when the other caller cancels", async () => {
  const sends = nativeSends(), f = await fixture(), connection = await f.connect(); f.expire();
  const hold = f.hold("idp-token"), controller = new AbortController();
  try {
    const first = connection.client.callTool({ name: "echo" }, { signal: controller.signal }).catch(error => error);
    await hold.started;
    const second = connection.client.callTool({ name: "echo" });
    await vi.waitFor(() => expect(f.idpRequests.filter(r => r.form)).toHaveLength(3));
    expect(sends.count()).toBe(2); controller.abort(); expect(await first).toBeInstanceOf(Error);
    await Promise.race([hold.aborted, new Promise(resolve => setTimeout(resolve, 100))]);
    expect(sends.count()).toBeGreaterThan(0); hold.release(); await sends.finish();
    expect(await second).toMatchObject({ content: [{ text: "enterprise tool" }] });
    expect(hold.wasAborted()).toBe(true); expect(f.exchanges).toHaveLength(2); expect(sends.count()).toBe(0);
    expect(f.runtime.signal.aborted).toBe(false);
  } finally { hold.release(); await sends.finish(); sends.restore(); }
});

it.each(["idp-discovery", "idp-token", "mcp-token"] as const)("aborts %s during initial connect and runtime shutdown, and established close", async stage => {
  for (const mode of ["connect-signal", "shutdown", "established-close"] as const) {
    const sends = nativeSends(), f = await fixture(), controller = new AbortController();
    const connection = mode === "established-close" ? await f.connect() : undefined;
    if (connection) f.expire();
    const hold = f.hold(stage);
    try {
      const pending = (connection ? connection.client.callTool({ name: "echo" }) : f.connect(controller.signal)).catch(error => error);
      await hold.started; const before = structuredClone(f.stored()), count = f.exchanges.length;
      if (mode === "shutdown") await shutdownOAuth(f.runtime);
      else if (mode === "established-close") await f.manager.close(f.name);
      else controller.abort();
      await hold.aborted; hold.release(); await sends.finish();
      expect(await pending).toBeInstanceOf(Error); expect(sends.count()).toBe(0);
      expect(f.exchanges).toHaveLength(count); expect(f.stored()).toEqual(before);
    } finally { hold.release(); await sends.finish(); sends.restore(); }
  }
});

it("does not advertise CAA or execute IdP sources on native stdio connections", async () => {
  const f = await fixture(), marker = join(scratch(), "ran");
  const code = `import {Server} from '@modelcontextprotocol/server'; import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
    const server=new Server({name:'caps',version:'1'},{capabilities:{tools:{}}});
    server.setRequestHandler('tools/list',async()=>({tools:[{name:'caps',inputSchema:{type:'object'}}]}));
    server.setRequestHandler('tools/call',async()=>({content:[{type:'text',text:JSON.stringify(server.getClientCapabilities())}]}));
    await server.connect(new StdioServerTransport());`;
  const connection = await f.manager.connect("stdio", { command: process.execPath, args: ["--input-type=module", "-e", code], oauth: { crossAppAccess: { idpUrl: f.idp, clientId: "idp", idToken: `!touch '${marker}'` } } });
  const result = await connection.client.callTool({ name: "caps" });
  expect(JSON.parse((result.content[0] as { text: string }).text).extensions).toBeUndefined();
  expect(existsSync(marker)).toBe(false); expect(f.idpRequests).toHaveLength(0);
});

it("does not retain a completed connect caller signal and lets shared reconnect outlive one waiter", async () => {
  const f = await fixture(), controller = new AbortController();
  const stale = await f.connect(controller.signal); controller.abort(); f.expire();
  expect(await stale.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
  f.expire(); const hold = f.hold("idp-token"), waiter = new AbortController();
  const first = f.manager.reconnect(f.name, f.definition, stale, waiter.signal).catch(error => error); await hold.started;
  waiter.abort(); expect(await first).toBeInstanceOf(Error); expect(hold.wasAborted()).toBe(false);
  const second = f.manager.reconnect(f.name, f.definition, stale); hold.release();
  expect(await (await second).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
});

it("drains accepted authentication before retirement without cancelling the IdP exchange", async () => {
  const f = await fixture(), stale = await f.connect(); f.expire(); const hold = f.hold("idp-token");
  const accepted = stale.client.callTool({ name: "echo" }); await hold.started;
  f.manager.retire(f.name, stale); expect(hold.wasAborted()).toBe(false); hold.release();
  expect(await accepted).toMatchObject({ content: [{ text: "enterprise tool" }] });
  const fresh = await f.connect(); expect(fresh).not.toBe(stale);
  expect(await fresh.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "enterprise tool" }] });
});

it("keeps the native noninteractive scope retry bound and transport-failure tracking", async () => {
  const f = await fixture(); f.definition.retryOnTransportFailure = true; await f.connect();
  const deps = { manager: f.manager, config: { mcpServers: { [f.name]: f.definition } }, retryOnTransportFailure: true, onNeedsAuth: vi.fn() };
  expect(await withSessionRecovery(deps, f.name, c => c.client.callTool({ name: "echo" }))).toMatchObject({ content: [{ text: "enterprise tool" }] });
  expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(2);
  f.forbid();
  await expect(withSessionRecovery(deps, f.name, c => c.client.callTool({ name: "echo" }))).rejects.toThrow(/retry limit/);
  expect(f.exchanges).toHaveLength(2); expect(deps.onNeedsAuth).not.toHaveBeenCalled();
});

it("refuses positively identified stored shared CIMD without deleting it, but preserves opaque/static identity priority", async () => {
  const f = await fixture("public");
  saveAuthEntry(f.name, { clientInfo: { clientId: sharedDocument.client_id, issuer: f.as, redirectUris: [], registrationType: "cimd" }, tokens: { accessToken: "old", issuer: f.as } }, f.definition.url!);
  const before = f.stored(); await expect(f.start()).rejects.toThrow(/shared browser registration/);
  expect(f.idpRequests).toHaveLength(0); expect(f.stored()).toEqual(before);
  for (const configured of [false, true]) {
    const provider = f.provider();
    saveAuthEntry(f.name, { clientInfo: { clientId: sharedDocument.client_id, issuer: f.as, redirectUris: [] } }, f.definition.url!);
    if (configured) f.oauth.clientId = sharedDocument.client_id;
    expect((await (configured ? f.provider() : provider).clientInformation({ issuer: f.as }))?.client_id).toBe(sharedDocument.client_id);
  }
});

function stateFor(f: Awaited<ReturnType<typeof fixture>>, autoAuth = true): McpExtensionState {
  return { manager: f.manager, oauthRuntime: f.runtime, config: { mcpServers: { [f.name]: f.definition }, settings: { autoAuth } },
    toolMetadata: new Map([[f.name, [{ name: `${f.name}_echo`, originalName: "echo", description: "echo", inputSchema: { type: "object" } }]]]),
    serverInstructions: new Map(), failureTracker: new Map(), failureMessages: new Map(), completedUiSessions: [], metadataCacheEnabled: false,
  } as unknown as McpExtensionState;
}
async function callHost(f: Awaited<ReturnType<typeof fixture>>, state: McpExtensionState, host: string) {
  if (host === "proxy") return executeCall(state, `${f.name}_echo`, {}, f.name);
  if (host === "script") return runMcpScript(state, `emit(await tools.call(${JSON.stringify(`${f.name}_echo`)}, {}));`);
  const execute = createDirectToolExecutor(() => state, () => null, { serverName: f.name, originalName: "echo", prefixedName: `${f.name}_echo`, description: "echo" });
  return execute("call", {}, undefined, undefined, {} as never);
}

it.each(["proxy", "direct", "script"])("finishes %s automatic auth without UI or callback after a real needs-auth connection", async host => {
  const f = await fixture(); f.rejectResource(true); expect((await f.connect()).status).toBe("needs-auth"); f.rejectResource(false);
  const result = await callHost(f, stateFor(f), host);
  expect(JSON.stringify(result)).toContain("enterprise tool"); expect(result.details?.error).toBeUndefined();
  expect(f.exchanges).toHaveLength(2); expect(browser.open).not.toHaveBeenCalled(); expect(hasPendingAuth(f.name, {}, f.runtime)).toBe(false);
});

it.each(["proxy", "direct"])("gives truthful %s CAA failure guidance and preserves custom instructions", async host => {
  const f = await fixture(); f.rejectResource(true); expect((await f.connect()).status).toBe("needs-auth"); f.rejectResource(false);
  f.idpError({ error: "invalid_client", error_description: "TOKEN_SENTINEL" });
  const state = stateFor(f);
  for (const custom of [undefined, "Contact your workspace administrator"]) {
    state.config.settings!.authRequiredMessage = custom;
    const result = await callHost(f, state, host), text = JSON.stringify(result);
    expect(text).toContain(custom ?? "ID-token source"); expect(text).not.toContain("browser URL"); expect(text).not.toContain("TOKEN_SENTINEL");
  }
});

it("runs explicit proxy auth-start and public IdP authentication through the same native flow", async () => {
  const f = await fixture(); delete f.oauth.crossAppAccess!.clientSecret;
  const result = await executeAuthStart(stateFor(f), f.name);
  expect(result.details?.error).toBeUndefined(); expect(result.details?.authenticated).toBe(true);
  expect(f.idpRequests.find(r => r.form)?.form?.has("client_secret")).toBe(false);
  expect(f.exchanges).toHaveLength(1); expect(browser.open).not.toHaveBeenCalled();
});

it("re-resolves an ID-token source for the native bounded MCP invalid-grant retry", async () => {
  const f = await fixture(), marker = join(scratch(), "reads"), token = f.oauth.crossAppAccess!.idToken;
  f.oauth.crossAppAccess!.idToken = `!printf x >> '${marker}'; printf '%s' '${token}'`; f.rejectTokens();
  await expect(f.start()).rejects.toThrow(/invalid_grant/);
  expect(readFileSync(marker, "utf8")).toBe("xx"); expect(f.exchanges).toHaveLength(2); expect(browser.open).not.toHaveBeenCalled();
});

it("rejects bad CAA shapes and contradictory grants without disclosing or resolving inputs", () => {
  const valid = { idpUrl: "https://idp.example", clientId: "idp", idToken: "TOKEN_SENTINEL" };
  const configs: unknown[] = [null, false, [], {}, { ...valid, idToken: "" }, { ...valid, idpUrl: 42 }, { ...valid, clientId: [] }, { ...valid, clientSecret: null }, { ...valid, audience: "override" }, { ...valid, resource: "override" }].map(crossAppAccess => ({ crossAppAccess }));
  configs.push({ crossAppAccess: valid, grantType: "authorization_code" }, { crossAppAccess: valid, grantType: "client_credentials" });
  for (const config of configs) for (const build of [() => extractOAuthConfig({ oauth: config as OAuthConfig }), () => new McpOAuthProvider("bad", "https://resource.example", config as OAuthConfig, { onRedirect() {} })]) {
    let error: unknown; try { build(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).toContain("crossAppAccess"); expect(String(error)).not.toContain("TOKEN_SENTINEL"); expect((error as Error).cause).toBeUndefined();
  }
});
