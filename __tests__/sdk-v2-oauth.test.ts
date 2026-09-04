import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { IssuerMismatchError } from "@modelcontextprotocol/client";
import { createOAuthRuntime, startAuth, completeAuthFromInput, hasPendingAuth, shutdownOAuth } from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl } from "../mcp-auth.ts";
import { McpServerManager } from "../server-manager.ts";
import { executeCall } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import type { ServerEntry } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function oauthFixture() {
  let origin = "";
  let issuer = "";
  let currentToken = "initial";
  let tokenFailure = false;
  let toolCalls = 0;
  let holdDiscovery = false;
  let discoveryStarted = false;
  let discoveryClosed = false;
  const tokenRequests: URLSearchParams[] = [];
  const name = `local-oauth-${crypto.randomUUID()}`;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        resource: `${origin}/mcp`, authorization_servers: [`${origin}/tenant`], scopes_supported: ["tools"],
      }));
      return;
    }
    if (req.url?.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"], authorization_response_iss_parameter_supported: true,
      }));
      return;
    }
    let data = "";
    for await (const chunk of req) data += chunk;
    if (req.url === "/token") {
      tokenRequests.push(new URLSearchParams(data));
      if (tokenFailure) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        access_token: currentToken, refresh_token: "refresh", token_type: "Bearer", expires_in: 3600,
      }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const body = JSON.parse(data);
    if (body.method === "server/discover" && holdDiscovery) {
      discoveryStarted = true;
      res.on("close", () => { discoveryClosed = true; });
      return;
    }
    if (body.method === "tools/call") toolCalls++;
    if (req.headers.authorization !== `Bearer ${currentToken}`) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
      return;
    }
    const result = body.method === "server/discover"
      ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : body.method === "tools/list"
        ? { resultType: "complete", ttlMs: 10000, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : { resultType: "complete", content: [{ type: "text", text: "authorized" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  issuer = origin; // Intentionally differs from the advertised /tenant AS.
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  manager.setOAuthRuntime(runtime);
  cleanups.push(async () => {
    await manager.closeAll();
    await shutdownOAuth(runtime);
    clearAllCredentials(name);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const definition: ServerEntry = {
    url: `${origin}/mcp`, auth: "oauth", retryOnTransportFailure: true,
    oauth: { clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: "http://127.0.0.1:19878/callback" },
  };
  const start = (skip?: boolean, signal?: AbortSignal) => startAuth(name, definition.url!, {
    ...definition, oauth: { ...definition.oauth as object, ...(skip !== undefined ? { skipIssuerMetadataValidation: skip } : {}) },
  }, { runtime, ...(signal ? { signal } : {}) });
  const complete = (authorizationUrl: string, iss: string | undefined = origin) => {
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const params = new URLSearchParams({ code: "fixture-code", state });
    if (iss !== undefined) params.set("iss", iss);
    return completeAuthFromInput(name, `http://127.0.0.1:19878/callback?${params}`, { runtime });
  };
  const connect = async (implicit = false) => {
    const config: ServerEntry = { ...definition, ...(implicit ? { auth: undefined } : {}), oauth: { ...definition.oauth as object, skipIssuerMetadataValidation: true } };
    await manager.connect(name, config);
    const state = { manager, config: { mcpServers: { [name]: config }, settings: {} },
      toolMetadata: new Map([[name, [{ name: "local_echo", originalName: "echo", description: "Echo" }]]]),
      failureTracker: new Map(), completedUiSessions: [],
    } as unknown as McpExtensionState;
    return () => executeCall(state, "local_echo", {}, name);
  };
  return { name, origin, runtime, definition, start, complete, connect, tokenRequests,
    toolCalls: () => toolCalls,
    expire: () => { currentToken = "refreshed"; },
    failTokenEndpoint: () => { tokenFailure = true; },
    changeIssuer: () => { issuer = `${origin}/other`; },
    holdDiscovery: () => { holdDiscovery = true; },
    discoveryStarted: () => discoveryStarted,
    discoveryClosed: () => discoveryClosed,
  };
}

describe("published SDK OAuth compatibility over local HTTP", () => {
  it.each([undefined, false])("rejects mismatched metadata unless explicitly opted out (%s)", async skip => {
    const f = await oauthFixture();
    await expect(f.start(skip)).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(f.tokenRequests).toHaveLength(0);
  });

  it("allows the explicit metadata exception, passes callback iss, and retains native refresh for implicit OAuth", async () => {
    const f = await oauthFixture();
    const { authorizationUrl } = await f.start(true);
    expect(await f.complete(authorizationUrl)).toBe("authenticated");
    expect(f.tokenRequests[0].get("code")).toBe("fixture-code");
    expect(f.tokenRequests[0].get("code_verifier")).toBeTruthy();
    const stored = await getAuthForUrl(f.name, f.definition.url!);
    expect(stored?.tokens?.issuer).toBe(f.origin);
    expect(stored?.clientInfo?.clientSecret).toBeUndefined();
    const call = await f.connect(true);
    expect(f.tokenRequests).toHaveLength(1); // A valid stored token needs no refresh or fresh consent.
    f.expire();
    expect((await call()).details.error).toBeUndefined();
    expect(f.tokenRequests[1].get("grant_type")).toBe("refresh_token");
  });

  it("keeps missing callback iss recoverable and rejects a wrong issuer before exchange", async () => {
    const f = await oauthFixture();
    const { authorizationUrl } = await f.start(true);
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    await expect(completeAuthFromInput(f.name, `code=fixture-code&state=${state}`, { runtime: f.runtime })).rejects.toThrow('requires the RFC 9207 "iss"');
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    await expect(f.complete(authorizationUrl, "http://wrong.invalid")).rejects.toThrow("does not match");
    expect(f.tokenRequests).toHaveLength(0);
  });

  it("keeps stored issuer binding enforced with the metadata exception enabled", async () => {
    const f = await oauthFixture();
    await f.complete((await f.start(true)).authorizationUrl);
    const call = await f.connect();
    f.expire();
    f.changeIssuer();
    const output = await call();
    expect(output.details.error).toBe("call_failed");
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("issuer changed") });
    expect(f.tokenRequests).toHaveLength(1);
    expect(f.toolCalls()).toBe(1);
  });

  it("aborts the actual native auth-discovery request and releases callback state", async () => {
    const f = await oauthFixture();
    f.holdDiscovery();
    const controller = new AbortController();
    const pending = f.start(true, controller.signal);
    const rejection = expect(pending).rejects.toThrow("cancel auth discovery");
    await expect.poll(f.discoveryStarted).toBe(true);
    controller.abort(new Error("cancel auth discovery"));
    await rejection;
    await expect.poll(f.discoveryClosed).toBe(true);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.tokenRequests).toHaveLength(0);
  });

  it("never retries a tool because an OAuth fetch rejected", async () => {
    const f = await oauthFixture();
    await f.complete((await f.start(true)).authorizationUrl);
    const call = await f.connect();
    f.expire();
    f.failTokenEndpoint();
    expect((await call()).details.error).toBe("call_failed");
    expect(f.toolCalls()).toBe(1);
    expect(f.tokenRequests).toHaveLength(2);
  });
});
