import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { extractOAuthConfig, startAuth } from "../mcp-auth-flow.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import sharedDocument from "../docs/client-metadata.json" with { type: "json" };

it("rejects bad CAA shapes and contradictory grants without disclosing or resolving inputs", () => {
  const valid = { idpUrl: "https://idp.example", clientId: "idp", idToken: "TOKEN_SENTINEL" };
  const configs: unknown[] = [
    null,
    false,
    [],
    {},
    { ...valid, idToken: "" },
    { ...valid, idpUrl: 42 },
    { ...valid, clientId: [] },
    { ...valid, clientSecret: null },
    { ...valid, audience: "override" },
    { ...valid, resource: "override" },
  ].map((crossAppAccess) => ({ crossAppAccess }));
  configs.push(
    { crossAppAccess: valid, grantType: "authorization_code" },
    { crossAppAccess: valid, grantType: "client_credentials" },
  );
  for (const config of configs) {
    for (const build of [
      () => {
        // @ts-expect-error Untrusted OAuth values are rejected by the typed extraction API.
        return extractOAuthConfig({ oauth: config });
      },
      () =>
        new McpOAuthProvider({
          serverName: "bad",
          serverUrl: "https://resource.example",
          // @ts-expect-error Untrusted OAuth values are rejected by the typed provider API.
          config,
          callbacks: {
            onRedirect() {
              throw new Error("Invalid configuration must not redirect");
            },
          },
        }),
    ]) {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("crossAppAccess");
      expect(String(error)).not.toContain("TOKEN_SENTINEL");
      expect(error.cause).toBeUndefined();
    }
  }
});

it("validates private-key configuration and identity conflicts at extraction and provider boundaries without disclosure", () => {
  const valid = { privateKey: "PRIVATE_KEY_SENTINEL", algorithm: "ES256" };
  const invalid: unknown[] = [
    null,
    false,
    [],
    "PRIVATE_KEY_SENTINEL",
    {},
    { ...valid, privateKey: null },
    { ...valid, privateKey: [] },
    { ...valid, privateKey: "" },
    { ...valid, algorithm: "HS256" },
    { ...valid, algorithm: "none" },
    { ...valid, algorithm: 42 },
    { ...valid, algorithm: "" },
    { ...valid, audience: "" },
    { ...valid, audience: [] },
    { ...valid, lifetimeSeconds: 0 },
    { ...valid, lifetimeSeconds: 1.5 },
    { ...valid, lifetimeSeconds: Infinity },
    { ...valid, claims: [] },
    { ...valid, claims: null },
  ];
  const configs: unknown[] = invalid.map((privateKeyJwt) => ({ clientId: "id", privateKeyJwt }));
  configs.push(
    { privateKeyJwt: valid },
    { clientId: "id", clientSecret: "SECRET_SENTINEL", privateKeyJwt: valid },
    { clientMetadataUrl: sharedDocument.client_id, privateKeyJwt: valid },
  );
  for (const config of configs) {
    for (const build of [
      () => {
        // @ts-expect-error Untrusted OAuth values are rejected by the typed extraction API.
        return extractOAuthConfig({ oauth: config });
      },
      () =>
        new McpOAuthProvider({
          serverName: "validation",
          serverUrl: "https://server.example/mcp",
          // @ts-expect-error Untrusted OAuth values are rejected by the typed provider API.
          config,
          callbacks: {
            onRedirect() {
              throw new Error("Invalid configuration must not redirect");
            },
          },
        }),
    ]) {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("privateKeyJwt");
      expect(String(error)).not.toContain("SENTINEL");
      expect(error.cause).toBeUndefined();
    }
  }
});

it("validates document URLs at extraction and direct-provider boundaries without leaking userinfo", () => {
  const invalid: unknown[] = [
    true,
    null,
    12,
    "",
    "https://example.com/",
    "http://example.com/client.json",
    "/client.json",
    "https://user:secret@example.com/client.json",
    "https://@example.com/client.json",
    "https://example.com/client.json#",
    "https://example.com/client.json#fragment",
    "https://example.com/a/../client.json",
    "https://example.com/./client.json",
    "https://example.com/%2e/client.json",
    "https://example.com/a/.%2E/client.json",
    "https://example.com/a/%2e%2e/client.json",
    "https://example.com/a\\..\\client.json",
  ];
  for (const clientMetadataUrl of invalid) {
    const config = { clientMetadataUrl };
    expect(() => {
      // @ts-expect-error Unknown client metadata values are rejected by the typed extraction API.
      return extractOAuthConfig({ oauth: config });
    }).toThrow(/clientMetadataUrl/);
    expect(
      () =>
        new McpOAuthProvider({
          serverName: "validation",
          serverUrl: "https://server.example/mcp",
          // @ts-expect-error Unknown client metadata values are rejected by the typed provider API.
          config,
          callbacks: {
            onRedirect() {
              throw new Error("Invalid client metadata must not redirect");
            },
          },
        }),
    ).toThrow(/clientMetadataUrl/);
  }
  process.env.CIMD_DOCUMENT_URL = "https://example.com/client.json?version=1";
  try {
    expect(
      extractOAuthConfig({ oauth: { clientMetadataUrl: "${CIMD_DOCUMENT_URL}" } })
        .clientMetadataUrl,
    ).toBe(process.env.CIMD_DOCUMENT_URL);
  } finally {
    delete process.env.CIMD_DOCUMENT_URL;
  }
  expect(extractOAuthConfig({ oauth: { clientMetadataUrl: false } }).clientMetadataUrl).toBe(false);
  const credentialUrl = "https://alice:USERINFO_SECRET_SENTINEL@example.com/client.json";
  for (const build of [
    () => extractOAuthConfig({ oauth: { clientMetadataUrl: credentialUrl } }),
    () =>
      new McpOAuthProvider({
        serverName: "validation",
        serverUrl: "https://server.example/mcp",
        config: { clientMetadataUrl: credentialUrl },
        callbacks: {
          onRedirect() {
            throw new Error("Invalid client metadata must not redirect");
          },
        },
      }),
  ]) {
    let message = "";
    try {
      build();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("OAuth clientMetadataUrl must be an HTTPS URL");
    expect(message).not.toContain("alice");
    expect(message).not.toContain("USERINFO_SECRET_SENTINEL");
    expect(message).not.toContain("example.com");
  }
});

it("rejects non-string OAuth redirectUri values", async () => {
  await assert.rejects(
    () =>
      startAuth("typed-redirect", "https://api.example.com/mcp", {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        // @ts-expect-error OAuth redirect URIs are strings, not port numbers.
        oauth: { redirectUri: 3118 },
      }),
    /redirectUri must be a string/,
  );
});

it("rejects non-string OAuth clientName and clientUri values", () => {
  assert.throws(
    () =>
      extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        // @ts-expect-error OAuth client names are strings, not numbers.
        oauth: { clientName: 123 },
      }),
    /clientName must be a string/,
  );
  assert.throws(
    () =>
      extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        // @ts-expect-error OAuth client URIs are strings, not numbers.
        oauth: { clientUri: 123 },
      }),
    /clientUri must be a string/,
  );
});

it("rejects malformed OAuth authorizationParams", () => {
  assert.throws(
    () =>
      extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        // @ts-expect-error OAuth authorization parameters require a string-valued object.
        oauth: { authorizationParams: [] },
      }),
    /authorizationParams must be an object/,
  );
  assert.throws(
    () =>
      extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        // @ts-expect-error Individual OAuth authorization parameter values must be strings.
        oauth: { authorizationParams: { prompt: 123 } },
      }),
    /authorizationParams\.prompt must be a string/,
  );
});
