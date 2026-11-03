import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import metadataDocument from "../docs/client-metadata.json" with { type: "json" };
import { clearAllCredentials, getAuthEntryFilePath, saveAuthEntry } from "../mcp-auth.ts";
import {
  getOAuthCallbackPort,
  loopbackRedirectsMatch,
  McpOAuthProvider,
} from "../mcp-oauth-provider.ts";
import type { OAuthConfig } from "../types.ts";
import { callbackUri, CimdFixture } from "./fixtures/oauth-cimd.ts";

const browser = vi.hoisted(() => ({ open: vi.fn<(_url: string) => Promise<void>>() }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => Promise<void>> = [];
let authDir: string;

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), "pi-mcp-cimd-"));
  vi.stubEnv("FITCH_MCP_OAUTH_DIR", authDir);
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup();
    }
  } finally {
    cleanups.length = 0;
    browser.open.mockReset();
    rmSync(authDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

function metadataConfig(clientMetadataUrl: OAuthConfig["clientMetadataUrl"]): OAuthConfig {
  return clientMetadataUrl === undefined ? {} : { clientMetadataUrl };
}

async function fixture(oauth: OAuthConfig = {}): Promise<CimdFixture> {
  const server = new CimdFixture(oauth);
  await server.listen();
  browser.open.mockImplementation(async (url) => {
    const callback = await server.authorize(url);
    expect((await fetch(callback)).status).toBe(200);
  });
  cleanups.push(() => server.close(expect.getState().currentTestName));
  return server;
}

it("uses the default document through native PKCE, callback, refresh, resource and tool HTTP with zero DCR", async () => {
  const f = await fixture();
  expect(await f.login()).toBe("authenticated");
  expect(f.authorizations[0]?.searchParams.get("client_id")).toBe(metadataDocument.client_id);
  expect(f.stored()?.clientInfo).toMatchObject({
    clientId: metadataDocument.client_id,
    registrationType: "cimd",
    issuer: f.origin,
  });
  const connection = await f.connect();
  expect(connection.status).toBe("connected");
  expect(await f.manager.readResource(f.name, "test://document")).toMatchObject({
    contents: [{ text: "authorized resource" }],
  });
  f.expire();
  expect(await connection.client.callTool({ name: "echo" })).toMatchObject({
    content: [{ text: "authorized tool" }],
  });
  expect(f.exchanges.map((p) => p.get("grant_type"))).toEqual([
    "authorization_code",
    "refresh_token",
  ]);
  expect(
    f.exchanges.every(
      (p) =>
        p.get("client_id") === metadataDocument.client_id &&
        p.get("resource") === `${f.origin}/mcp`,
    ),
  ).toBe(true);
  expect(f.documentFetches).toEqual([
    metadataDocument.client_id,
    metadataDocument.client_id,
    metadataDocument.client_id,
  ]);
  expect(f.registrations).toHaveLength(0);
});

it.each([
  [undefined, undefined],
  [undefined, false],
  [undefined, "https://custom.example/next.json"],
  ["https://custom.example/client.json", undefined],
  ["https://custom.example/client.json", false],
  ["https://custom.example/client.json", "https://custom.example/next.json"],
] satisfies Array<[string | undefined, OAuthConfig["clientMetadataUrl"]]>)(
  "keeps saved CIMD %s and refresh after restart/forced port change and setting %s",
  async (initial, setting) => {
    const f = await fixture(metadataConfig(initial));
    const id = initial ?? metadataDocument.client_id;
    f.documents.set(id, { ...metadataDocument, client_id: id });
    await f.login();
    const before = f.stored();
    assert(before !== undefined);
    const oldPort = getOAuthCallbackPort();
    expect(await f.restart()).toBe(oldPort);
    f.definition.oauth = metadataConfig(setting);
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(getOAuthCallbackPort()).not.toBe(oldPort);
    expect(f.stored()?.clientInfo).toEqual(before.clientInfo);
    const refresh = f.exchanges[1];
    assert(refresh !== undefined);
    expect(refresh.get("refresh_token")).toBe(before.tokens?.refreshToken);
    expect(refresh.get("client_id")).toBe(id);
    expect(f.authorizations).toHaveLength(1);
    expect(f.registrations).toHaveLength(0);
  },
);

it.each([undefined, false])(
  "uses native DCR when capability is %s, even with a URL-shaped client ID",
  async (capability) => {
    const f = await fixture({ clientMetadataUrl: "https://opaque.example/registration/1" });
    if (capability === undefined) {
      delete f.metadata.client_id_metadata_document_supported;
    } else {
      f.metadata.client_id_metadata_document_supported = capability;
    }
    expect(await f.login()).toBe("authenticated");
    expect(f.stored()?.clientInfo?.registrationType).toBeUndefined();
    expect(f.registrations).toHaveLength(1);
    expect(f.documentFetches).toHaveLength(0);
  },
);

it("does not treat opaque HTTPS DCR IDs as CIMD on a port change", async () => {
  const f = await fixture({ clientMetadataUrl: false });
  await f.login();
  const before = f.stored();
  assert(before !== undefined);
  expect(before.clientInfo?.clientId).toMatch(/^https:/);
  expect(before.clientInfo?.registrationType).toBeUndefined();
  await f.restart();
  const { authorizationUrl } = await f.start();
  expect(authorizationUrl).toBeTruthy();
  expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(
    "https://opaque.example/registration/2",
  );
  expect(f.stored()?.tokens).toBeUndefined();
  expect(f.exchanges).toHaveLength(1);
  expect(f.registrations).toHaveLength(2);
});

it.each(["rejected", "unavailable"])(
  "surfaces AS document %s without claiming a DCR fallback",
  async (failure) => {
    const f = await fixture();
    f.documents.set(
      metadataDocument.client_id,
      failure === "rejected" ? { ...metadataDocument, client_id: "wrong" } : null,
    );
    const callback = await f.authorize((await f.start()).authorizationUrl);
    await expect(f.complete(callback)).rejects.toThrow("invalid_client_metadata");
    expect(f.exchanges).toHaveLength(0);
    expect(f.registrations).toHaveLength(0);
    expect(f.documentFetches).toEqual([metadataDocument.client_id]);
    expect(f.stored()?.tokens).toBeUndefined();
  },
);

it.each([
  undefined,
  false,
  "https://custom.example/client.json",
] satisfies OAuthConfig["clientMetadataUrl"][])(
  "keeps configured clients ahead of CIMD setting %s",
  async (clientMetadataUrl) => {
    const redirectUri = await callbackUri();
    const f = await fixture({
      clientId: "configured",
      ...metadataConfig(clientMetadataUrl),
      redirectUri,
    });
    f.registered.set("configured", { ...metadataDocument, redirect_uris: [redirectUri] });
    expect(await f.login()).toBe("authenticated");
    expect(f.exchanges[0]?.get("client_id")).toBe("configured");
    expect(f.registrations).toHaveLength(0);
    expect(f.documentFetches).toHaveLength(0);
    expect(f.stored()?.clientInfo).toEqual({
      clientId: "configured",
      issuer: f.origin,
      configPreRegistered: true,
    });
  },
);

it.each([
  [{ clientName: metadataDocument.client_name, clientUri: metadataDocument.client_uri }, true],
  [{ clientName: "Another app" }, false],
  [{ clientUri: "https://another.example/app" }, false],
  [{ clientMetadataUrl: false }, false],
  [{ clientSecret: "secret" }, false],
  [{ clientSecret: "secret", clientMetadataUrl: "https://custom.example/client.json" }, false],
] satisfies Array<[OAuthConfig, boolean]>)(
  "preserves identity/secret policy %j",
  async (config, shared) => {
    const f = await fixture(config);
    const { authorizationUrl } = await f.start();
    expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe(
      shared ? metadataDocument.client_id : "https://opaque.example/registration/1",
    );
    expect(f.registrations).toHaveLength(shared ? 0 : 1);
  },
);

it.each(["/callback", "/custom", "/callback?tenant=one"])(
  "uses shared metadata only for represented callback %s",
  async (path) => {
    const redirectUri = await callbackUri(`http://127.0.0.1:PORT${path}`);
    const f = await fixture({ redirectUri });
    expect(await f.login()).toBe("authenticated");
    expect(f.authorizations[0]?.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(f.authorizations[0]?.searchParams.get("client_id")).toBe(
      path === "/callback" ? metadataDocument.client_id : "https://opaque.example/registration/1",
    );
    expect(f.registrations).toHaveLength(path === "/callback" ? 0 : 1);
  },
);

it.each([
  "HTTP://LOCALHOST:PORT/callback",
  "http://[0:0:0:0:0:0:0:1]:PORT/callback",
  "http://localhost:PORT?tenant=one",
])("retains custom CIMD refresh for raw port-only callback changes: %s", async (template) => {
  const id = "https://custom.example/ports.json";
  const redirectUri = await callbackUri(template);
  const port = getOAuthCallbackPort();
  const f = await fixture({ clientMetadataUrl: id, redirectUri });
  f.documents.set(id, { ...metadataDocument, client_id: id, redirect_uris: [redirectUri] });
  expect(await f.login()).toBe("authenticated");
  const before = f.stored();
  assert(before !== undefined);
  expect(await f.restart()).toBe(port);
  const nextRedirectUri = await callbackUri(template);
  const nextPort = getOAuthCallbackPort();
  expect(nextPort).not.toBe(port);
  f.definition.oauth = { clientMetadataUrl: false, redirectUri: nextRedirectUri };
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(getOAuthCallbackPort()).toBe(nextPort);
  expect(f.stored()?.clientInfo).toEqual(before.clientInfo);
  const refresh = f.exchanges[1];
  assert(refresh !== undefined);
  expect(refresh.get("refresh_token")).toBe(before.tokens?.refreshToken);
  expect(refresh.get("client_id")).toBe(id);
  expect(f.registrations).toHaveLength(0);
  expect(f.authorizations).toHaveLength(1);
});

it.each(["?return_to=/../welcome", "?next=https://other.example/a/../b"])(
  "accepts document URLs with dot segments inside a query %s",
  async (query) => {
    const id = `https://custom.example/client.json${query}`;
    const f = await fixture({ clientMetadataUrl: id });
    f.documents.set(id, { ...metadataDocument, client_id: id });
    expect(await f.login()).toBe("authenticated");
    expect(f.exchanges[0]?.get("client_id")).toBe(id);
    expect(f.registrations).toHaveLength(0);
  },
);

it("uses a custom document with an exact custom callback and identity", async () => {
  const id = "https://custom.example/app.json";
  const redirectUri = await callbackUri("http://127.0.0.1:PORT/custom?tenant=one");
  const f = await fixture({
    clientMetadataUrl: id,
    clientName: "Custom",
    clientUri: "https://custom.example/",
    redirectUri,
  });
  f.documents.set(id, {
    ...metadataDocument,
    client_id: id,
    client_name: "Custom",
    client_uri: "https://custom.example/",
    redirect_uris: [redirectUri],
  });
  expect(await f.login()).toBe("authenticated");
  expect(f.exchanges[0]?.get("redirect_uri")).toBe(redirectUri);
  expect(f.exchanges[0]?.get("client_id")).toBe(id);
  expect(f.registrations).toHaveLength(0);
});

it("retains state and issuer validation before exchanging a CIMD code", async () => {
  const f = await fixture();
  const callback = new URL(await f.authorize((await f.start()).authorizationUrl));
  const missingState = new URL(callback);
  missingState.searchParams.delete("state");
  await expect(f.complete(missingState.href)).rejects.toThrow("state missing");
  const wrongState = new URL(callback);
  wrongState.searchParams.set("state", "wrong");
  expect((await fetch(wrongState)).status).toBe(400);
  const missingIssuer = new URL(callback);
  missingIssuer.searchParams.delete("iss");
  await expect(f.complete(missingIssuer.href)).rejects.toThrow('requires the RFC 9207 "iss"');
  const wrongIssuer = new URL(callback);
  wrongIssuer.searchParams.set("iss", "https://wrong.example");
  expect((await fetch(wrongIssuer)).status).toBe(400);
  expect(f.exchanges).toHaveLength(0);
  expect(await f.complete(callback.href)).toBe("authenticated");
});

it.each([
  undefined,
  "not-an-array",
  [null],
  ["http://127.0.0.1:19876/callback"],
  ["https://localhost:19876/callback"],
  ["http://localhost:19876/other"],
  ["http://localhost:19876/callback?tenant=one"],
  ["http://localhost:19876/a/../callback"],
])("still clears mismatched or malformed stored CIMD callbacks %j", async (redirects) => {
  const f = await fixture();
  await f.login();
  const before = f.stored();
  assert(before !== undefined);
  assert(before.clientInfo !== undefined);
  clearAllCredentials(f.name);
  const file = getAuthEntryFilePath(f.name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify({
      ...before,
      clientInfo: { ...before.clientInfo, redirectUris: redirects },
    }),
    { mode: 0o600 },
  );
  await f.restart();
  expect((await f.start()).authorizationUrl).toBeTruthy();
  expect(f.stored()?.tokens).toBeUndefined();
  expect(f.exchanges).toHaveLength(1); // No refresh may use the old callback binding.
});

it("keeps stored client and token issuer guards after CIMD port reuse", async () => {
  const f = await fixture({ skipIssuerMetadataValidation: true });
  await f.login();
  const before = f.stored();
  await f.restart();
  f.metadata.issuer = `${f.origin}/changed`;
  await expect(f.start()).rejects.toThrow("issuer changed");
  expect(f.exchanges).toHaveLength(1);
  expect(f.stored()).toEqual(before);
});

it.each([undefined, metadataDocument.client_id])(
  "never gives machine clients the shared browser identity (%s)",
  async (clientMetadataUrl) => {
    const f = await fixture({
      grantType: "client_credentials",
      ...metadataConfig(clientMetadataUrl),
    });
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(f.exchanges[0]?.get("client_id")).toBe("https://opaque.example/registration/1");
    expect(f.registrations).toHaveLength(1);
    expect(f.documentFetches).toHaveLength(0);
  },
);

it("rejects legacy and explicit config stubs instead of sending an orphaned client_id", async () => {
  const f = await fixture({ grantType: "client_credentials" });
  for (const clientInfo of [
    { clientId: "legacy", issuer: f.origin },
    { clientId: "explicit", issuer: f.origin, configPreRegistered: true, redirectUris: [] },
  ]) {
    saveAuthEntry(f.name, { clientInfo }, f.definition.url);
    const provider = new McpOAuthProvider({
      serverName: f.name,
      serverUrl: f.definition.url,
      config: { grantType: "client_credentials" },
      callbacks: {
        onRedirect() {
          throw new Error("Stored client lookup must not redirect");
        },
      },
    });
    expect(await provider.clientInformation({ issuer: f.origin })).toBeUndefined();
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    await provider.addClientAuthentication(new Headers(), params, f.definition.url);
    expect(params.has("client_id")).toBe(false);
    saveAuthEntry(
      f.name,
      { clientInfo, tokens: { accessToken: "old", refreshToken: "old", issuer: f.origin } },
      f.definition.url,
    );
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(f.exchanges.at(-1)?.get("client_id")).toBe(
      `https://opaque.example/registration/${f.registrations.length}`,
    );
  }
});

it("limits port matching to valid raw HTTP loopback endpoints", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(
      loopbackRedirectsMatch(`http://${host}:19876/callback`, `http://${host}:32123/callback`),
    ).toBe(true);
  }
  const current = "http://localhost:32123/callback";
  for (const other of [
    undefined,
    null,
    1,
    {},
    "not a URL",
    "http://localhost:99999/callback",
    "http://127.0.0.1:19876/callback",
    "https://localhost:19876/callback",
    "http://localhost:19876/other",
    "http://localhost:19876/callback?x=1",
    "http://localhost:19876/callback#",
    "http://@localhost:19876/callback",
    "http://localhost:19876/a/../callback",
    "http://localhost:19876/%2e/callback",
  ]) {
    expect(loopbackRedirectsMatch(current, other)).toBe(false);
  }
  expect(
    loopbackRedirectsMatch(
      "http://localhost:19876/a/../callback",
      "http://localhost:32123/a/../callback",
    ),
  ).toBe(true);
  expect(
    loopbackRedirectsMatch("HTTP://LOCALHOST:19876/callback", "http://localhost:32123/callback"),
  ).toBe(false);
  expect(
    loopbackRedirectsMatch(
      "http://[0:0:0:0:0:0:0:1]:19876/callback",
      "http://[::1]:32123/callback",
    ),
  ).toBe(false);
  expect(
    loopbackRedirectsMatch(
      "http://localhost:19876?tenant=one",
      "http://localhost:32123/?tenant=one",
    ),
  ).toBe(false);
  expect(
    loopbackRedirectsMatch(
      "http://localhost:19876/callback?x=1",
      "http://localhost:32123/callback?x=1",
    ),
  ).toBe(true);
});

it("round-trips custom noninteractive CIMD as a real client_id, not a legacy config stub", async () => {
  const id = "https://machine.example/client.json";
  const f = await fixture({ grantType: "client_credentials", clientMetadataUrl: id });
  f.documents.set(id, {
    client_id: id,
    redirect_uris: [],
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "none",
  });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.stored()?.clientInfo).toMatchObject({
    clientId: id,
    redirectUris: [],
    registrationType: "cimd",
  });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges.map((p) => p.get("client_id"))).toEqual([id, id]);
  expect(f.exchanges.every((p) => p.get("grant_type") === "client_credentials")).toBe(true);
  expect(f.registrations).toHaveLength(0);
  expect(f.authorizations).toHaveLength(0);
});
