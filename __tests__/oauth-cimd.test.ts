import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import metadataDocument from "../docs/client-metadata.json" with { type: "json" };
import { authenticate, completeAuthFromInput, createOAuthRuntime, extractOAuthConfig, shutdownOAuth, startAuth } from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { getOAuthCallbackPort, loopbackRedirectsMatch, McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { McpServerManager } from "../server-manager.ts";
import type { OAuthConfig, ServerEntry } from "../types.ts";

const browser = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => {}) }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  browser.open.mockReset();
});
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};
const listen = async (server: Server, port = 0, host = "127.0.0.1") => {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return address.port;
};

async function fixture(oauth: OAuthConfig = {}) {
  const name = `cimd-${crypto.randomUUID()}`;
  let origin = "";
  let runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  manager.setOAuthRuntime(runtime);
  const documents = new Map<string, object | null>([[metadataDocument.client_id, metadataDocument]]);
  type Document = { client_id?: string; redirect_uris: string[]; grant_types: string[]; token_endpoint_auth_method?: string; application_type?: string };
  const registered = new Map<string, Document>();
  const authorizations: URL[] = [];
  const exchanges: URLSearchParams[] = [];
  const documentFetches: string[] = [];
  const registrations: object[] = [];
  const requests: Array<{ method: string; token?: string }> = [];
  const codes = new Map<string, URL>();
  const refreshes = new Map<string, string>();
  const tokens = new Set<string>();
  const metadata: Record<string, unknown> = { client_id_metadata_document_supported: true };
  // Only the AS resolves this local mapping. Native client_id remains the real HTTPS URL.
  const client = async (id: string) => {
    if (registered.has(id)) return registered.get(id);
    const response = await fetch(`${origin}/document?id=${encodeURIComponent(id)}`);
    if (!response.ok) return undefined;
    const doc = await response.json();
    return doc.client_id === id && doc.token_endpoint_auth_method === "none" ? doc : undefined;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return void json({
      resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"],
    });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return void json({
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true, ...metadata,
    });
    if (url.pathname === "/document") {
      const id = url.searchParams.get("id")!;
      documentFetches.push(id);
      return void json(documents.get(id) ?? { error: "unavailable" }, documents.get(id) ? 200 : 503);
    }
    if (url.pathname === "/authorize") {
      authorizations.push(url);
      const doc = await client(url.searchParams.get("client_id")!);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      const allowed = doc?.redirect_uris?.some((uri: string) => {
        const saved = new URL(uri);
        return saved.protocol === callback.protocol && saved.hostname === callback.hostname
          && saved.pathname === callback.pathname && saved.search === callback.search
          && (saved.port === callback.port || (doc.application_type === "native" && saved.protocol === "http:"
            && ["localhost", "127.0.0.1", "[::1]"].includes(saved.hostname)));
      });
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", origin);
      if (!allowed) callback.searchParams.set("error", "invalid_client_metadata");
      else {
        const code = `code-${authorizations.length}`;
        codes.set(code, url);
        callback.searchParams.set("code", code);
      }
      res.writeHead(302, { location: callback.href }).end(); return;
    }
    let data = "";
    for await (const chunk of req) data += chunk;
    if (url.pathname === "/register") {
      const doc = JSON.parse(data);
      registrations.push(doc);
      const id = `https://opaque.example/registration/${registrations.length}`;
      registered.set(id, doc);
      return void json({ ...doc, client_id: id }, 201);
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(data);
      exchanges.push(params);
      const id = params.get("client_id")!;
      const doc = await client(id);
      if (!doc) return void json({ error: "invalid_client" }, 400);
      const grant = params.get("grant_type");
      if (!doc.grant_types.includes(grant) || params.get("resource") !== `${origin}/mcp`) return void json({ error: "invalid_request" }, 400);
      if (grant === "authorization_code") {
        const authorization = codes.get(params.get("code")!);
        const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (!authorization || authorization.searchParams.get("client_id") !== id
          || authorization.searchParams.get("code_challenge") !== challenge
          || authorization.searchParams.get("redirect_uri") !== params.get("redirect_uri")) return void json({ error: "invalid_grant" }, 400);
        codes.delete(params.get("code")!);
      }
      if (grant === "refresh_token" && refreshes.get(params.get("refresh_token")!) !== id) return void json({ error: "invalid_grant" }, 400);
      const token = `access-${exchanges.length}`;
      const refresh = `refresh-${exchanges.length}`;
      tokens.add(token); refreshes.set(refresh, id);
      return void json({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "tools" });
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const body = JSON.parse(data);
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    requests.push({ method: body.method, token });
    if (!tokens.has(token ?? "")) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    const result = body.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } }
      : body.method === "tools/list" ? { ttlMs: 10000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : body.method === "resources/list" ? { ttlMs: 10000, cacheScope: "private", resources: [{ name: "document", uri: "test://document" }] }
      : body.method === "resources/read" ? { ttlMs: 10000, cacheScope: "private", contents: [{ uri: "test://document", text: "authorized resource" }] }
      : { content: [{ type: "text", text: "authorized tool" }] };
    return void json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...result } });
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  const definition: ServerEntry = { url: `${origin}/mcp`, auth: "oauth", oauth };
  const start = () => startAuth(name, definition.url!, definition, { runtime });
  const complete = (callback: string) => completeAuthFromInput(name, callback, { runtime });
  const authorize = async (authorizationUrl: string) => {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    return response.headers.get("location")!;
  };
  browser.open.mockImplementation(async url => {
    const callback = await authorize(url);
    expect((await fetch(callback)).status).toBe(200);
  });
  cleanups.push(async () => {
    if (process.env.CIMD_PROOF_FILE) appendFileSync(process.env.CIMD_PROOF_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, node: process.version, execPath: process.execPath, authorizations: authorizations.map(u => Object.fromEntries(u.searchParams)), exchanges: exchanges.map(p => Object.fromEntries(p)), documentFetches, registrations, requests, stored: getAuthForUrl(name, definition.url!) })}\n`);
    await manager.closeAll(); await shutdownOAuth(runtime); clearAllCredentials(name); await close(server);
  });
  return { name, origin, definition, metadata, documents, registered, authorizations, exchanges, documentFetches, registrations, requests, manager,
    start, complete, authorize, stored: () => getAuthForUrl(name, definition.url!),
    login: () => authenticate(name, definition.url!, definition, { runtime, onAuthorizationUrl: () => {} }),
    expire: () => tokens.clear(),
    restart: async () => {
      await manager.closeAll(); await shutdownOAuth(runtime);
      const blocker = createServer(); await listen(blocker, getOAuthCallbackPort(), "localhost");
      cleanups.push(() => close(blocker));
      runtime = createOAuthRuntime(); manager.setOAuthRuntime(runtime);
    },
    connect: () => manager.connect(name, definition),
  };
}

it("uses the default document through native PKCE, callback, refresh, resource and tool HTTP with zero DCR", async () => {
  const f = await fixture();
  expect(await f.login()).toBe("authenticated");
  expect(f.authorizations[0].searchParams.get("client_id")).toBe(metadataDocument.client_id);
  expect(f.stored()?.clientInfo).toMatchObject({ clientId: metadataDocument.client_id, registrationType: "cimd", issuer: f.origin });
  const connection = await f.connect();
  expect(connection.status).toBe("connected");
  expect(await f.manager.readResource(f.name, "test://document")).toMatchObject({ contents: [{ text: "authorized resource" }] });
  f.expire();
  expect(await connection.client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "authorized tool" }] });
  expect(f.exchanges.map(p => p.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
  expect(f.exchanges.every(p => p.get("client_id") === metadataDocument.client_id && p.get("resource") === `${f.origin}/mcp`)).toBe(true);
  expect(f.documentFetches).toEqual([metadataDocument.client_id, metadataDocument.client_id, metadataDocument.client_id]);
  expect(f.registrations).toHaveLength(0);
});

it.each([
  [undefined, undefined], [undefined, false], [undefined, "https://custom.example/next.json"],
  ["https://custom.example/client.json", undefined], ["https://custom.example/client.json", false], ["https://custom.example/client.json", "https://custom.example/next.json"],
] as const)("keeps saved CIMD %s and refresh after restart/forced port change and setting %s", async (initial, setting) => {
  const f = await fixture({ clientMetadataUrl: initial });
  const id = initial ?? metadataDocument.client_id;
  f.documents.set(id, { ...metadataDocument, client_id: id });
  await f.login();
  const before = f.stored()!;
  const oldPort = getOAuthCallbackPort();
  await f.restart();
  f.definition.oauth = { clientMetadataUrl: setting };
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(getOAuthCallbackPort()).not.toBe(oldPort);
  expect(f.stored()?.clientInfo).toEqual(before.clientInfo);
  expect(f.exchanges[1].get("refresh_token")).toBe(before.tokens?.refreshToken);
  expect(f.exchanges[1].get("client_id")).toBe(id);
  expect(f.authorizations).toHaveLength(1); expect(f.registrations).toHaveLength(0);
});

it.each([undefined, false])("uses native DCR when capability is %s, even with a URL-shaped client ID", async capability => {
  const f = await fixture({ clientMetadataUrl: "https://opaque.example/registration/1" });
  if (capability === undefined) delete f.metadata.client_id_metadata_document_supported;
  else f.metadata.client_id_metadata_document_supported = capability;
  expect(await f.login()).toBe("authenticated");
  expect(f.stored()?.clientInfo?.registrationType).toBeUndefined();
  expect(f.registrations).toHaveLength(1); expect(f.documentFetches).toHaveLength(0);
});

it("does not treat opaque HTTPS DCR IDs as CIMD on a port change", async () => {
  const f = await fixture({ clientMetadataUrl: false }); await f.login();
  const before = f.stored()!;
  expect(before.clientInfo?.clientId).toMatch(/^https:/);
  expect(before.clientInfo?.registrationType).toBeUndefined();
  await f.restart();
  const { authorizationUrl } = await f.start();
  expect(authorizationUrl).toBeTruthy();
  expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("https://opaque.example/registration/2");
  expect(f.stored()?.tokens).toBeUndefined();
  expect(f.exchanges).toHaveLength(1); expect(f.registrations).toHaveLength(2);
});

it.each(["rejected", "unavailable"])("surfaces AS document %s without claiming a DCR fallback", async failure => {
  const f = await fixture();
  f.documents.set(metadataDocument.client_id, failure === "rejected" ? { ...metadataDocument, client_id: "wrong" } : null);
  const callback = await f.authorize((await f.start()).authorizationUrl);
  await expect(f.complete(callback)).rejects.toThrow("invalid_client_metadata");
  expect(f.exchanges).toHaveLength(0); expect(f.registrations).toHaveLength(0);
  expect(f.documentFetches).toEqual([metadataDocument.client_id]);
  expect(f.stored()?.tokens).toBeUndefined();
});

it.each([undefined, false, "https://custom.example/client.json"])("keeps configured clients ahead of CIMD setting %s", async clientMetadataUrl => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const f = await fixture({ clientId: "configured", clientMetadataUrl, redirectUri });
  f.registered.set("configured", { ...metadataDocument, redirect_uris: [redirectUri] });
  expect(await f.login()).toBe("authenticated");
  expect(f.exchanges[0].get("client_id")).toBe("configured");
  expect(f.registrations).toHaveLength(0); expect(f.documentFetches).toHaveLength(0);
  expect(f.stored()?.clientInfo).toEqual({ clientId: "configured", issuer: f.origin, configPreRegistered: true });
});

it.each([
  [{ clientName: metadataDocument.client_name, clientUri: metadataDocument.client_uri }, true],
  [{ clientName: "Another app" }, false],
  [{ clientUri: "https://another.example/app" }, false],
  [{ clientMetadataUrl: false }, false],
  [{ clientSecret: "secret" }, false],
  [{ clientSecret: "secret", clientMetadataUrl: "https://custom.example/client.json" }, false],
] satisfies Array<[OAuthConfig, boolean]>)("preserves identity/secret policy %j", async (config, shared) => {
  const f = await fixture(config);
  const { authorizationUrl } = await f.start();
  expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(shared ? metadataDocument.client_id : "https://opaque.example/registration/1");
  expect(f.registrations).toHaveLength(shared ? 0 : 1);
});

it.each(["/callback", "/custom", "/callback?tenant=one"])("uses shared metadata only for represented callback %s", async path => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const redirectUri = `http://127.0.0.1:${port}${path}`;
  const f = await fixture({ redirectUri });
  expect(await f.login()).toBe("authenticated");
  expect(f.authorizations[0].searchParams.get("redirect_uri")).toBe(redirectUri);
  expect(f.authorizations[0].searchParams.get("client_id")).toBe(path === "/callback" ? metadataDocument.client_id : "https://opaque.example/registration/1");
  expect(f.registrations).toHaveLength(path === "/callback" ? 0 : 1);
});

it("uses a custom document with an exact custom callback and identity", async () => {
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const id = "https://custom.example/app.json";
  const redirectUri = `http://127.0.0.1:${port}/custom?tenant=one`;
  const f = await fixture({ clientMetadataUrl: id, clientName: "Custom", clientUri: "https://custom.example/", redirectUri });
  f.documents.set(id, { ...metadataDocument, client_id: id, client_name: "Custom", client_uri: "https://custom.example/", redirect_uris: [redirectUri] });
  expect(await f.login()).toBe("authenticated");
  expect(f.exchanges[0].get("redirect_uri")).toBe(redirectUri);
  expect(f.exchanges[0].get("client_id")).toBe(id);
  expect(f.registrations).toHaveLength(0);
});

it("retains state and issuer validation before exchanging a CIMD code", async () => {
  const f = await fixture();
  const callback = new URL(await f.authorize((await f.start()).authorizationUrl));
  const missingState = new URL(callback); missingState.searchParams.delete("state");
  await expect(f.complete(missingState.href)).rejects.toThrow("state missing");
  const wrongState = new URL(callback); wrongState.searchParams.set("state", "wrong");
  expect((await fetch(wrongState)).status).toBe(400);
  const missingIssuer = new URL(callback); missingIssuer.searchParams.delete("iss");
  await expect(f.complete(missingIssuer.href)).rejects.toThrow('requires the RFC 9207 "iss"');
  const wrongIssuer = new URL(callback); wrongIssuer.searchParams.set("iss", "https://wrong.example");
  expect((await fetch(wrongIssuer)).status).toBe(400);
  expect(f.exchanges).toHaveLength(0);
  expect(await f.complete(callback.href)).toBe("authenticated");
});

it.each([undefined, "not-an-array", [null], ["http://127.0.0.1:19876/callback"], ["https://localhost:19876/callback"],
  ["http://localhost:19876/other"], ["http://localhost:19876/callback?tenant=one"], ["http://localhost:19876/a/../callback"],
])("still clears mismatched or malformed stored CIMD callbacks %j", async redirects => {
  const f = await fixture(); await f.login();
  const before = f.stored()!;
  const clientInfo = { ...before.clientInfo!, redirectUris: redirects as unknown as string[] };
  saveAuthEntry(f.name, { ...before, clientInfo }, f.definition.url!);
  await f.restart();
  expect((await f.start()).authorizationUrl).toBeTruthy();
  expect(f.stored()?.tokens).toBeUndefined();
  expect(f.exchanges).toHaveLength(1); // No refresh may use the old callback binding.
});

it("keeps stored client and token issuer guards after CIMD port reuse", async () => {
  const f = await fixture({ skipIssuerMetadataValidation: true }); await f.login();
  const before = f.stored(); await f.restart();
  f.metadata.issuer = `${f.origin}/changed`;
  await expect(f.start()).rejects.toThrow("issuer changed");
  expect(f.exchanges).toHaveLength(1); expect(f.stored()).toEqual(before);
});

it.each([undefined, metadataDocument.client_id])("never gives machine clients the shared browser identity (%s)", async clientMetadataUrl => {
  const f = await fixture({ grantType: "client_credentials", clientMetadataUrl });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges[0].get("client_id")).toBe("https://opaque.example/registration/1");
  expect(f.registrations).toHaveLength(1); expect(f.documentFetches).toHaveLength(0);
});

it("rejects legacy and explicit config stubs instead of sending an orphaned client_id", async () => {
  const f = await fixture({ grantType: "client_credentials" });
  for (const clientInfo of [
    { clientId: "legacy", issuer: f.origin },
    { clientId: "explicit", issuer: f.origin, configPreRegistered: true, redirectUris: [] },
  ]) {
    saveAuthEntry(f.name, { clientInfo }, f.definition.url!);
    const provider = new McpOAuthProvider(f.name, f.definition.url!, { grantType: "client_credentials" }, { onRedirect: () => {} });
    expect(await provider.clientInformation({ issuer: f.origin })).toBeUndefined();
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    await provider.addClientAuthentication(new Headers(), params, f.definition.url!);
    expect(params.has("client_id")).toBe(false);
    saveAuthEntry(f.name, { clientInfo, tokens: { accessToken: "old", refreshToken: "old", issuer: f.origin } }, f.definition.url!);
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(f.exchanges.at(-1)?.get("client_id")).toBe(`https://opaque.example/registration/${f.registrations.length}`);
  }
});

it("validates document URLs at extraction and direct-provider boundaries without leaking userinfo", () => {
  const invalid: unknown[] = [true, null, 12, "", "https://example.com/", "http://example.com/client.json", "/client.json",
    "https://user:secret@example.com/client.json", "https://@example.com/client.json", "https://example.com/client.json#", "https://example.com/client.json#fragment",
    "https://example.com/a/../client.json", "https://example.com/./client.json", "https://example.com/%2e/client.json", "https://example.com/a/.%2E/client.json",
    "https://example.com/a/%2e%2e/client.json", "https://example.com/a\\..\\client.json"];
  for (const clientMetadataUrl of invalid) {
    const config = { clientMetadataUrl } as OAuthConfig;
    expect(() => extractOAuthConfig({ oauth: config })).toThrow(/clientMetadataUrl/);
    expect(() => new McpOAuthProvider("validation", "https://server.example/mcp", config, { onRedirect: () => {} })).toThrow(/clientMetadataUrl/);
  }
  process.env.CIMD_DOCUMENT_URL = "https://example.com/client.json?version=1";
  try {
    expect(extractOAuthConfig({ oauth: { clientMetadataUrl: "${CIMD_DOCUMENT_URL}" } }).clientMetadataUrl).toBe(process.env.CIMD_DOCUMENT_URL);
  } finally { delete process.env.CIMD_DOCUMENT_URL; }
  expect(extractOAuthConfig({ oauth: { clientMetadataUrl: false } }).clientMetadataUrl).toBe(false);
});

it("limits port matching to valid raw HTTP loopback endpoints", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(loopbackRedirectsMatch(`http://${host}:19876/callback`, `http://${host}:32123/callback`)).toBe(true);
  }
  const current = "http://localhost:32123/callback";
  for (const other of [undefined, null, 1, {}, "not a URL", "http://localhost:99999/callback", "http://127.0.0.1:19876/callback",
    "https://localhost:19876/callback", "http://localhost:19876/other", "http://localhost:19876/callback?x=1", "http://localhost:19876/callback#",
    "http://@localhost:19876/callback", "http://localhost:19876/a/../callback", "http://localhost:19876/%2e/callback"]) {
    expect(loopbackRedirectsMatch(current, other)).toBe(false);
  }
  expect(loopbackRedirectsMatch("http://localhost:19876/a/../callback", "http://localhost:32123/a/../callback")).toBe(false);
  expect(loopbackRedirectsMatch("http://localhost:19876/callback?x=1", "http://localhost:32123/callback?x=1")).toBe(true);
});

it("round-trips custom noninteractive CIMD as a real client_id, not a legacy config stub", async () => {
  const id = "https://machine.example/client.json";
  const f = await fixture({ grantType: "client_credentials", clientMetadataUrl: id });
  f.documents.set(id, { client_id: id, redirect_uris: [], grant_types: ["client_credentials"], token_endpoint_auth_method: "none" });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.stored()?.clientInfo).toMatchObject({ clientId: id, redirectUris: [], registrationType: "cimd" });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges.map(p => p.get("client_id"))).toEqual([id, id]);
  expect(f.exchanges.every(p => p.get("grant_type") === "client_credentials")).toBe(true);
  expect(f.registrations).toHaveLength(0); expect(f.authorizations).toHaveLength(0);
});
