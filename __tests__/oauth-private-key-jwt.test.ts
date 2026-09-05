import { createServer, type Server } from "node:http";
import { constants, createHash, createPublicKey, generateKeyPairSync, verify, type JsonWebKey } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { auth, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/client";
import { completeAuthFromInput, createOAuthRuntime, extractOAuthConfig, shutdownOAuth, startAuth } from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { McpServerManager } from "../server-manager.ts";
import sharedDocument from "../docs/client-metadata.json" with { type: "json" };
import type { OAuthConfig, ServerEntry } from "../types.ts";

const browser = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  browser.open.mockReset();
});
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function key(algorithm = "ES256") {
  const pair = algorithm.startsWith("Ed") ? generateKeyPairSync("ed25519")
    : algorithm.startsWith("ES") ? generateKeyPairSync("ec", { namedCurve: "P-256" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: pair.privateKey.export({ format: "jwk" }), publicJwk: pair.publicKey.export({ format: "jwk" }), algorithm };
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pi-jwt-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Claims = { iss: string; sub: string; aud: string; iat: number; exp: number; jti: string; [key: string]: unknown };
async function fixture(config: OAuthConfig = {}, pair = key()) {
  const name = `jwt-${crypto.randomUUID()}`;
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager(); manager.setOAuthRuntime(runtime);
  const id = config.clientId ?? (typeof config.clientMetadataUrl === "string" ? config.clientMetadataUrl : "configured-jwt-client");
  const oauth: OAuthConfig = { clientId: id, grantType: "client_credentials", privateKeyJwt: { privateKey: pair.pem, algorithm: pair.algorithm }, ...config };
  if (config.clientMetadataUrl && config.clientId === undefined) delete oauth.clientId;
  let origin = "";
  let verificationKey = pair.publicJwk;
  let issuer: string | undefined;
  let publicMcp = false;
  const exchanges: Array<{ params: URLSearchParams; authorization?: string; claims?: Claims; header?: Record<string, unknown> }> = [];
  const requests: Array<{ method: string; params: any }> = [];
  const authorizations: URL[] = [];
  const documentFetches: string[] = [];
  const registrations: object[] = [];
  const codes = new Map<string, URL>();
  const refreshes = new Set<string>();
  const tokens = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return void json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return void json({
      issuer: issuer ?? origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: [pair.algorithm], authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    // AS-only local document hosting; the adapter uses the real HTTPS client_id and never fetches it.
    if (url.pathname === "/document") {
      documentFetches.push(url.searchParams.get("id")!);
      return void json({ client_id: id, token_endpoint_auth_method: "private_key_jwt", jwks: { keys: [verificationKey] } });
    }
    if (url.pathname === "/authorize") {
      authorizations.push(url);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      const code = `code-${authorizations.length}`; codes.set(code, url);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", origin); callback.searchParams.set("code", code);
      res.writeHead(302, { location: callback.href }).end(); return;
    }
    let data = ""; for await (const chunk of req) data += chunk;
    if (url.pathname === "/register") { registrations.push(JSON.parse(data)); return void json({ error: "registration_not_supported" }, 400); }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(data);
      const exchange: typeof exchanges[number] = { params, authorization: req.headers.authorization };
      exchanges.push(exchange);
      try {
        if (oauth.privateKeyJwt) {
          const assertion = params.get("client_assertion")!;
          const [encodedHeader, encodedClaims, signature] = assertion.split(".");
          const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
          const claims: Claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString());
          exchange.header = header; exchange.claims = claims;
          let publicJwk = verificationKey;
          if (id.startsWith("https:")) {
            const doc = await (await fetch(`${origin}/document?id=${encodeURIComponent(params.get("client_id")!)}`)).json();
            if (doc.client_id !== params.get("client_id") || doc.token_endpoint_auth_method !== "private_key_jwt") throw new Error("document");
            publicJwk = doc.jwks.keys[0];
          }
          const publicKey = createPublicKey({ key: publicJwk as JsonWebKey, format: "jwk" });
          const valid = verify(pair.algorithm.startsWith("Ed") ? null : "sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`),
            { key: publicKey, dsaEncoding: "ieee-p1363", ...(pair.algorithm.startsWith("PS") ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : {}) }, Buffer.from(signature, "base64url"));
          if (!valid || header.alg !== pair.algorithm || header.typ !== "JWT" || header.kid !== undefined
            || claims.iss !== id || claims.sub !== id || claims.aud !== (oauth.privateKeyJwt.audience ?? origin)
            || claims.exp <= Date.now() / 1000 || params.get("client_id") !== id
            || params.get("resource") !== `${origin}/mcp` || params.has("client_secret") || req.headers.authorization
            || params.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") throw new Error("assertion");
        } else if (params.get("client_id") !== id || params.has("client_assertion") || params.has("client_secret")) throw new Error("public client");
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          const authorization = codes.get(params.get("code")!);
          if (!authorization || authorization.searchParams.get("client_id") !== id
            || authorization.searchParams.get("code_challenge") !== createHash("sha256").update(params.get("code_verifier")!).digest("base64url")
            || authorization.searchParams.get("redirect_uri") !== params.get("redirect_uri")) throw new Error("code");
        } else if (grant === "refresh_token") {
          if (!refreshes.has(params.get("refresh_token")!)) throw new Error("refresh");
        } else if (grant !== "client_credentials") throw new Error("grant");
      } catch { return void json({ error: "invalid_request", error_description: "fixture rejected client assertion" }, 400); }
      const accessToken = `access-${exchanges.length}`; const refreshToken = `refresh-${exchanges.length}`;
      tokens.add(accessToken); refreshes.add(refreshToken);
      return void json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "tools" });
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const body = JSON.parse(data); requests.push(body);
    if (!publicMcp && !tokens.has(req.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    if (body.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "jwt", version: "1" } }
      : body.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : body.method === "tools/list" ? { ttlMs: 10000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "signed tool" }] };
    return void json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...result } });
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  const definition: ServerEntry = { url: `${origin}/mcp`, auth: "oauth", oauth };
  const start = () => startAuth(name, definition.url!, definition, { runtime });
  const stored = () => getAuthForUrl(name, definition.url!);
  cleanups.push(async () => {
    if (process.env.JWT_PROOF_FILE) appendFileSync(process.env.JWT_PROOF_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, node: process.version, execPath: process.execPath,
      exchanges: exchanges.map(e => ({ grant: e.params.get("grant_type"), claims: e.claims, header: e.header, hasSecret: e.params.has("client_secret"), hasBasic: !!e.authorization })),
      requests, authorizations: authorizations.length, documentFetches, registrations: registrations.length })}\n`);
    await manager.closeAll(); await shutdownOAuth(runtime); clearAllCredentials(name); await close(server);
  });
  return { name, origin, pair, id, definition, oauth, runtime, manager, exchanges, requests, authorizations, registrations, documentFetches, stored, start,
    provider: (signal?: AbortSignal) => new McpOAuthProvider(name, definition.url!, extractOAuthConfig(definition), { onRedirect: () => { browser.open(); } }, {}, signal, "fixture-state"),
    rotate: (next: ReturnType<typeof key>) => { verificationKey = next.publicJwk; },
    changeIssuer: (next: string) => { issuer = next; },
    publicMcp: () => { publicMcp = true; },
    expire: () => tokens.clear(),
    connect: () => manager.connect(name, definition),
    login: async () => {
      const { authorizationUrl } = await start();
      const location = (await fetch(authorizationUrl, { redirect: "manual" })).headers.get("location")!;
      expect((await fetch(location)).status).toBe(200);
      expect(await completeAuthFromInput(name, location, { runtime })).toBe("authenticated");
    },
  };
}

it.each(["ES256", "RS256", "PS256", "EdDSA", "Ed25519"])("authenticates native %s signatures then uses the MCP tool", async algorithm => {
  const pair = key(algorithm); pair.jwk.kid = "fixture-kid";
  const f = await fixture({ privateKeyJwt: { privateKey: algorithm.startsWith("Ed") ? pair.jwk : pair.pem, algorithm } }, pair);
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect((await f.connect()).status).toBe("connected");
  expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "signed tool" }] });
  const { claims, params } = f.exchanges[0];
  expect(claims).toMatchObject({ iss: f.id, sub: f.id, aud: f.origin });
  expect(claims!.exp - claims!.iat).toBe(300); expect(claims!.jti).toBeTruthy();
  expect(params.get("scope")).toBe("tools");
  expect(f.registrations).toHaveLength(0); expect(f.authorizations).toHaveLength(0);
  expect(JSON.stringify(f.stored())).not.toContain(pair.pem);
  expect(JSON.stringify(f.stored())).not.toContain(pair.jwk.d);
  expect(JSON.stringify(f.stored())).not.toContain(params.get("client_assertion"));
});

it.each(["PEM", "JWK"])("resolves a %s command afresh after test-key rotation, with SDK-owned claims", async format => {
  const dir = scratch(), file = join(dir, "key"), counter = join(dir, "reads");
  const pair = key(); writeFileSync(file, format === "PEM" ? pair.pem : JSON.stringify(pair.jwk));
  const f = await fixture({ privateKeyJwt: { privateKey: `!printf x >> '${counter}'; cat '${file}'`, algorithm: "ES256", audience: "urn:jwt-audience", lifetimeSeconds: 90,
    claims: { role: "test", iss: "wrong", sub: "wrong", aud: "wrong", iat: 1, exp: 2, jti: "wrong" } } }, pair);
  const provider = f.provider();
  expect(provider.clientMetadata.token_endpoint_auth_method).toBe("private_key_jwt");
  expect(JSON.stringify(provider.clientMetadata)).not.toContain(file);
  expect(extractOAuthConfig(f.definition).privateKeyJwt?.privateKey).toBe(f.oauth.privateKeyJwt?.privateKey);
  await provider.clientInformation(); void provider.clientMetadata;
  expect(existsSync(counter)).toBe(false);
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  const next = key(); f.rotate(next); writeFileSync(file, format === "PEM" ? next.pem : JSON.stringify(next.jwk));
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(readFileSync(counter, "utf8")).toBe("xx");
  expect(f.exchanges[0].params.get("client_assertion")).not.toBe(f.exchanges[1].params.get("client_assertion"));
  for (const { claims } of f.exchanges) {
    expect(claims).toMatchObject({ iss: f.id, sub: f.id, aud: "urn:jwt-audience", role: "test" });
    expect(claims!.exp - claims!.iat).toBe(90); expect(claims!.jti).not.toBe("wrong"); expect(claims!.iat).toBeGreaterThan(2);
  }
});

it.each(["${JWT_TEST_KEY}", "$env:JWT_TEST_KEY", "{env:JWT_TEST_KEY}"])("resolves JWK environment source %s only at authentication", async source => {
  const pair = key();
  const f = await fixture({ privateKeyJwt: { privateKey: source, algorithm: pair.algorithm } }, pair);
  const provider = f.provider();
  expect(extractOAuthConfig(f.definition).privateKeyJwt?.privateKey).toBe(source);
  process.env.JWT_TEST_KEY = JSON.stringify(pair.jwk);
  try { expect(await auth(provider, { serverUrl: f.definition.url! })).toBe("AUTHORIZED"); }
  finally { delete process.env.JWT_TEST_KEY; }
});

it.each([false, true])("signs browser PKCE and refresh with custom document=%s", async custom => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const f = await fixture({ grantType: "authorization_code", redirectUri: `http://127.0.0.1:${port}/callback`,
    ...(custom ? { clientMetadataUrl: "https://jwt.example/client.json" } : {}) });
  await f.login();
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges.map(e => e.params.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
  expect(f.exchanges.every(e => e.claims?.iss === f.id && e.claims?.sub === f.id)).toBe(true);
  expect(f.authorizations).toHaveLength(1); expect(f.registrations).toHaveLength(0);
  expect(f.documentFetches).toHaveLength(custom ? 2 : 0);
  expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "signed tool" }] });
});

it("round-trips private-key custom CIMD client_credentials without the shared document", async () => {
  const f = await fixture({ clientMetadataUrl: "https://jwt.example/machine.json" });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  f.oauth.clientMetadataUrl = "https://jwt.example/changed.json";
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.stored()?.clientInfo).toMatchObject({ clientId: f.id, registrationType: "cimd", redirectUris: [] });
  expect(f.exchanges.every(e => e.claims?.iss === f.id)).toBe(true);
  expect(f.documentFetches).toEqual([f.id, f.id]); expect(f.registrations).toHaveLength(0);
});

it.each(["!printf 'COMMAND_SECRET_SENTINEL' >&2; exit 7", "!true", "!printf '{PRIVATE_KEY_SENTINEL}'", "!printf 'PRIVATE_KEY_SENTINEL'", "!printf '[]'", "!printf 'COMMAND_SECRET_SENTINEL'\0"])("fails refresh privately without token request, consent or invalidation: case %#", async source => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const f = await fixture({ grantType: "authorization_code", redirectUri: `http://127.0.0.1:${port}/callback` });
  await f.login(); const before = f.stored();
  f.oauth.privateKeyJwt!.privateKey = source;
  const error = await f.start().catch(error => error);
  expect(error).toBeInstanceOf(OAuthError); expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(error.message).toContain("privateKeyJwt");
  expect(String(error)).not.toContain("SENTINEL"); expect(error.cause).toBeUndefined();
  if (source.includes("exit 7")) expect(error.message).toContain("command exited with code 7");
  if (source === "!true") expect(error.message).toContain("command returned empty output");
  expect(f.exchanges).toHaveLength(1); expect(f.authorizations).toHaveLength(1);
  expect(f.stored()).toEqual(before); expect(browser.open).not.toHaveBeenCalled();
});

it.each(["client", "tokens"])("checks the stored %s issuer before resolving a key", async binding => {
  const dir = scratch(), marker = join(dir, "ran");
  const f = await fixture({ privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" }, skipIssuerMetadataValidation: true });
  saveAuthEntry(f.name, { clientInfo: { clientId: f.id, configPreRegistered: true, issuer: binding === "client" ? "https://old.example" : f.origin },
    tokens: { accessToken: "old", refreshToken: "old", issuer: binding === "tokens" ? "https://old.example" : f.origin } }, f.definition.url!);
  const before = f.stored();
  await expect(f.start()).rejects.toThrow("issuer changed");
  expect(existsSync(marker)).toBe(false); expect(f.exchanges).toHaveLength(0); expect(f.stored()).toEqual(before);
});

it("retains strict discovered issuer validation on the new signing path", async () => {
  const dir = scratch(), marker = join(dir, "ran");
  const f = await fixture({ privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" } });
  f.changeIssuer("https://wrong.example");
  await expect(f.start()).rejects.toThrow(/issuer/i);
  expect(existsSync(marker)).toBe(false); expect(f.exchanges).toHaveLength(0);
});

it.each(["abort", "deactivate"])("stops native async signing on %s before any token request or write", async stop => {
  const f = await fixture(); const controller = new AbortController(); const provider = f.provider(controller.signal);
  const original = crypto.subtle.sign.bind(crypto.subtle);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(r => { began = r; }); const gate = new Promise<void>(r => { release = r; });
  const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => { began(); await gate; return original(...args); });
  try {
    const pending = auth(provider, { serverUrl: f.definition.url! }).catch(error => error);
    await started;
    const before = f.stored();
    if (stop === "abort") controller.abort(); else provider.deactivate();
    release(); const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(f.exchanges).toHaveLength(0); expect(f.stored()).toEqual(before);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(0);
  } finally { release(); spy.mockRestore(); }
});

it.each(["auto", "legacy"] as const)("lets native %s encode configured client-credentials capabilities for ordinary and discovery clients", async protocolVersion => {
  const f = await fixture(); f.definition.protocolVersion = protocolVersion;
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "signed tool" }] });
  const handshakes = f.requests.filter(r => r.method === (protocolVersion === "auto" ? "server/discover" : "initialize"));
  expect(handshakes.length).toBeGreaterThanOrEqual(2);
  for (const r of handshakes) {
    const caps = protocolVersion === "auto" ? r.params._meta["io.modelcontextprotocol/clientCapabilities"] : r.params.capabilities;
    expect(caps.extensions).toEqual({ "io.modelcontextprotocol/oauth-client-credentials": {} });
  }
});

it.each([
  [false, undefined, false], ["bearer", undefined, false], [undefined, { "X-Fixture": "test" }, false],
  [undefined, undefined, true], ["oauth", { "X-Fixture": "test" }, true],
] as const)("advertises ordinary machine auth only when OAuth is enabled: auth=%s headers=%j", async (authMode, headers, enabled) => {
  const f = await fixture(); f.publicMcp();
  f.definition.auth = authMode;
  f.definition.headers = headers;
  expect((await f.connect()).status).toBe("connected");
  const discover = f.requests.find(r => r.method === "server/discover")!;
  expect(discover.params._meta["io.modelcontextprotocol/clientCapabilities"]?.extensions).toEqual(
    enabled ? { "io.modelcontextprotocol/oauth-client-credentials": {} } : undefined,
  );
  expect(f.exchanges).toHaveLength(0);
});

it("does not resolve commands during discovery or declare machine auth for browser clients", async () => {
  const dir = scratch(), marker = join(dir, "ran");
  const f = await fixture({ grantType: "authorization_code", clientMetadataUrl: "https://jwt.example/browser.json",
    privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" } });
  f.publicMcp();
  const { authorizationUrl } = await f.start(); expect(authorizationUrl).toBeTruthy();
  expect((await f.connect()).status).toBe("connected");
  expect(existsSync(marker)).toBe(false);
  for (const r of f.requests) expect(r.params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions).toBeUndefined();
});

it("keeps native ordinary-versus-explicit scope precedence without changing step-up policy", async () => {
  const ordinary = await fixture({ scope: "configured-scope" });
  expect(await (await ordinary.connect()).client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "signed tool" }] });
  expect(ordinary.exchanges[0].params.get("scope")).toBe("tools");
  expect(ordinary.exchanges[0].params.get("resource")).toBe(`${ordinary.origin}/mcp`);
  const explicit = await fixture({ scope: "configured-scope" });
  await explicit.start();
  expect(explicit.exchanges[0].params.get("scope")).toBe("configured-scope");
});

it("stops failed signing during ordinary browser refresh without consent or credential invalidation", async () => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const f = await fixture({ grantType: "authorization_code", redirectUri: `http://127.0.0.1:${port}/callback` });
  await f.login(); const connection = await f.connect(); const before = f.stored(); f.expire();
  f.oauth.privateKeyJwt!.privateKey = key("RS256").pem; // Real incompatible key, not a mocked signer.
  await expect(connection.client.callTool({ name: "echo" })).rejects.toThrow(/privateKeyJwt/);
  expect(f.exchanges).toHaveLength(1); expect(f.authorizations).toHaveLength(1);
  expect(f.stored()).toEqual(before); expect(browser.open).not.toHaveBeenCalled();
});

it("cancels the real manager authentication while native signing is in flight without late token or tool dispatch", async () => {
  const f = await fixture();
  const original = crypto.subtle.sign.bind(crypto.subtle);
  let began!: () => void, release!: () => void, signed!: () => void;
  const started = new Promise<void>(r => { began = r; }); const gate = new Promise<void>(r => { release = r; });
  const finished = new Promise<void>(r => { signed = r; });
  const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => { began(); await gate; const result = await original(...args); signed(); return result; });
  try {
    const pending = f.connect().then(c => c.client.callTool({ name: "echo" })).catch(error => error);
    await started; const before = f.stored();
    await shutdownOAuth(f.runtime); release(); await finished;
    expect(await pending).toBeInstanceOf(Error);
    expect(f.exchanges).toHaveLength(0); expect(f.stored()).toEqual(before);
    expect(f.requests.filter(r => r.method === "tools/call")).toHaveLength(0);
  } finally { release(); spy.mockRestore(); }
});

it("validates private-key configuration and identity conflicts at both public boundaries without disclosure", () => {
  const valid = { privateKey: "PRIVATE_KEY_SENTINEL", algorithm: "ES256" };
  const invalid: unknown[] = [null, false, [], "PRIVATE_KEY_SENTINEL", {}, { ...valid, privateKey: null }, { ...valid, privateKey: [] }, { ...valid, privateKey: "" },
    { ...valid, algorithm: "HS256" }, { ...valid, algorithm: "none" }, { ...valid, algorithm: 42 }, { ...valid, algorithm: "" },
    { ...valid, audience: "" }, { ...valid, audience: [] }, { ...valid, lifetimeSeconds: 0 }, { ...valid, lifetimeSeconds: 1.5 }, { ...valid, lifetimeSeconds: Infinity },
    { ...valid, claims: [] }, { ...valid, claims: null }];
  const configs: unknown[] = invalid.map(privateKeyJwt => ({ clientId: "id", privateKeyJwt }));
  configs.push({ privateKeyJwt: valid }, { clientId: "id", clientSecret: "SECRET_SENTINEL", privateKeyJwt: valid },
    { clientMetadataUrl: sharedDocument.client_id, privateKeyJwt: valid });
  for (const config of configs) for (const build of [
    () => extractOAuthConfig({ oauth: config as OAuthConfig }),
    () => new McpOAuthProvider("validation", "https://server.example/mcp", config as OAuthConfig, { onRedirect: () => {} }),
  ]) {
    let error: unknown; try { build(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).toContain("privateKeyJwt");
    expect(String(error)).not.toContain("SENTINEL"); expect((error as Error).cause).toBeUndefined();
  }
});

it("does not migrate a real saved shared browser login into private-key auth after a custom URL change", async () => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const f = await fixture({ grantType: "authorization_code", redirectUri: `http://127.0.0.1:${port}/callback`, clientMetadataUrl: sharedDocument.client_id, privateKeyJwt: undefined });
  await f.login(); const before = f.stored();
  expect(before?.clientInfo).toMatchObject({ clientId: sharedDocument.client_id, registrationType: "cimd" });
  const dir = scratch(), marker = join(dir, "ran");
  f.oauth.clientMetadataUrl = "https://jwt.example/replacement.json";
  f.oauth.privateKeyJwt = { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" };
  const error = await f.start().catch(error => error);
  expect(error).toBeInstanceOf(OAuthError); expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(existsSync(marker)).toBe(false); expect(f.exchanges).toHaveLength(1);
  expect(f.authorizations).toHaveLength(1); expect(f.stored()).toEqual(before);
});

it("refuses keyless machine authentication with a real saved shared browser registration", async () => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const f = await fixture({ grantType: "authorization_code", redirectUri: `http://127.0.0.1:${port}/callback`, clientMetadataUrl: sharedDocument.client_id, privateKeyJwt: undefined });
  await f.login(); const before = f.stored();
  f.oauth.grantType = "client_credentials";
  const error = await f.start().catch(error => error);
  expect(error).toBeInstanceOf(OAuthError); expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(error.message).toContain("shared browser registration");
  expect(f.exchanges).toHaveLength(1); expect(f.authorizations).toHaveLength(1); expect(f.stored()).toEqual(before);
});

it.each(["configured", "opaque-dcr"])("does not classify a %s client by its URL-shaped ID", async kind => {
  const f = await fixture({ clientId: sharedDocument.client_id, clientMetadataUrl: "https://jwt.example/unused.json" });
  if (kind === "opaque-dcr") {
    delete f.oauth.clientId;
    saveAuthEntry(f.name, { clientInfo: { clientId: f.id, issuer: f.origin, redirectUris: [] }, tokens: { accessToken: "old", issuer: f.origin } }, f.definition.url!);
  }
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges[0].claims).toMatchObject({ iss: f.id, sub: f.id });
  expect(f.stored()?.clientInfo?.registrationType).toBeUndefined();
});

it.each(["shared", "secret"])("refuses a stored %s client before signing without rewriting credentials", async kind => {
  const dir = scratch(), marker = join(dir, "ran");
  const f = await fixture({ clientMetadataUrl: "https://jwt.example/client.json", privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" } });
  saveAuthEntry(f.name, { clientInfo: { clientId: kind === "shared" ? sharedDocument.client_id : "stored", issuer: f.origin, redirectUris: [], ...(kind === "secret" ? { clientSecret: "SECRET_SENTINEL" } : { registrationType: "cimd" as const }) }, tokens: { accessToken: "old", issuer: f.origin } }, f.definition.url!);
  const before = f.stored();
  await expect(f.start()).rejects.toThrow(/privateKeyJwt/);
  expect(existsSync(marker)).toBe(false); expect(f.exchanges).toHaveLength(0); expect(f.stored()).toEqual(before);
});
