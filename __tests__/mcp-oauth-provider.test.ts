import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";

describe("McpOAuthProvider clientMetadata scope", () => {
  it("includes configured scope in authorization_code client metadata", () => {
    const provider = new McpOAuthProvider({
      serverName: "scope-test",
      serverUrl: "https://api.example.com/mcp",
      config: { scope: "api://resource/.default openid" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });

    expect(provider.clientMetadata.scope).toBe("api://resource/.default openid");
  });

  it("omits scope from client metadata when not configured", () => {
    const provider = new McpOAuthProvider({
      serverName: "no-scope-test",
      serverUrl: "https://api.example.com/mcp",
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });

    expect(provider.clientMetadata).not.toHaveProperty("scope");
  });
});

describe("McpOAuthProvider addClientAuthentication", () => {
  const originalOAuthDir = process.env.FITCH_MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-auth-"));
    process.env.FITCH_MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.FITCH_MCP_OAUTH_DIR;
    } else {
      process.env.FITCH_MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("adds configured scope to authorization_code token params", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-scope",
      serverUrl,
      config: { clientId: "my-client", scope: "api://res/.default" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(
      new Headers(),
      params,
      new URL("https://auth.example.com/token"),
    );

    expect(params.get("scope")).toBe("api://res/.default");
    expect(params.get("client_id")).toBe("my-client");
  });

  it("uses client_secret_basic when the token endpoint only supports basic auth", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-basic",
      serverUrl,
      config: { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(
      headers,
      params,
      new URL("https://auth.example.com/token"),
      {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      },
    );

    expect(headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("my-client:my-secret").toString("base64")}`,
    );
    expect(params.get("scope")).toBe("api://res/.default");
    expect(params.has("client_id")).toBe(false);
    expect(params.has("client_secret")).toBe(false);
  });

  it("uses client_secret_post when metadata is absent", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-post",
      serverUrl,
      config: { clientId: "my-client", clientSecret: "my-secret" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(
      headers,
      params,
      new URL("https://auth.example.com/token"),
    );

    expect(headers.has("Authorization")).toBe(false);
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");
  });

  it("does not overwrite token params that are already present", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-no-overwrite",
      serverUrl,
      config: { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      scope: "already-set",
      client_id: "already-set-id",
      client_secret: "already-set-secret",
    });

    await provider.addClientAuthentication(
      new Headers(),
      params,
      new URL("https://auth.example.com/token"),
    );

    expect(params.get("scope")).toBe("already-set");
    expect(params.get("client_id")).toBe("already-set-id");
    expect(params.get("client_secret")).toBe("already-set-secret");
  });

  it("does not add scope to refresh token requests", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-refresh",
      serverUrl,
      config: { clientId: "my-client", scope: "api://res/.default" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh" });

    await provider.addClientAuthentication(
      new Headers(),
      params,
      new URL("https://auth.example.com/token"),
    );

    expect(params.has("scope")).toBe(false);
    expect(params.get("client_id")).toBe("my-client");
  });

  it("does not mutate token request credentials after deactivation", async () => {
    const provider = new McpOAuthProvider({
      serverName: "auth-inactive",
      serverUrl,
      config: { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code" });
    provider.deactivate();

    await expect(
      provider.addClientAuthentication(headers, params, new URL("https://auth.example.com/token")),
    ).rejects.toThrow("OAuth flow is no longer active");
    expect([...params.entries()]).toEqual([["grant_type", "authorization_code"]]);
    expect([...headers.entries()]).toEqual([]);
  });

  it.each(["client", "tokens"] as const)(
    "does not stamp %s credentials when deactivated during a read",
    async (kind) => {
      const identity = { serverName: `inactive-read-${kind}`, serverUrl };
      saveAuthEntry(identity, {
        clientInfo: { clientId: "my-client" },
        tokens: { accessToken: "access-token" },
      });
      const provider = new McpOAuthProvider({
        ...identity,
        config: { clientId: "my-client" },
        callbacks: {
          onRedirect: async () => {
            // This read-only provider check does not open a browser.
          },
        },
      });
      const context = { issuer: "https://auth.example.com" };
      const reading =
        kind === "client" ? provider.clientInformation(context) : provider.tokens(context);
      provider.deactivate();
      await expect(reading).rejects.toThrow("OAuth flow is no longer active");
      const stored = getAuthForUrl(identity);
      expect(stored?.clientInfo?.issuer).toBeUndefined();
      expect(stored?.tokens?.issuer).toBeUndefined();
    },
  );

  it("does not persist a pre-registered issuer stub after deactivation", async () => {
    const provider = new McpOAuthProvider({
      serverName: "inactive-client-info",
      serverUrl,
      config: { clientId: "my-client", clientSecret: "my-secret" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    provider.deactivate();

    await expect(
      provider.saveClientInformation({
        client_id: "my-client",
        issuer: "https://auth.example.com",
      }),
    ).rejects.toThrow("OAuth flow is no longer active");

    expect(getAuthForUrl({ serverName: "inactive-client-info", serverUrl })).toBeUndefined();
  });
});

describe("McpOAuthProvider discovery state", () => {
  const originalOAuthDir = process.env.FITCH_MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-discovery-"));
    process.env.FITCH_MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.FITCH_MCP_OAUTH_DIR;
    } else {
      process.env.FITCH_MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("back-stamps legacy client information and tokens with the discovered issuer", async () => {
    saveAuthEntry(
      { serverName: "legacy-binding", serverUrl },
      {
        clientInfo: {
          clientId: "legacy-client",
          clientSecret: "legacy-secret",
          redirectUris: ["http://localhost:19876/callback"],
        },
        tokens: {
          accessToken: "legacy-access",
          refreshToken: "legacy-refresh",
        },
        serverUrl,
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "legacy-binding",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });

    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    expect(await provider.clientInformation()).toMatchObject({
      client_id: "legacy-client",
      issuer: "https://auth.example.com",
    });
    expect(await provider.tokens()).toMatchObject({
      access_token: "legacy-access",
      issuer: "https://auth.example.com",
    });
    expect(getAuthForUrl({ serverName: "legacy-binding", serverUrl })).toMatchObject({
      clientInfo: { issuer: "https://auth.example.com" },
      tokens: { issuer: "https://auth.example.com" },
    });
  });

  it("rejects stored credentials when the issuer changes before refresh", async () => {
    saveAuthEntry(
      { serverName: "changed-issuer", serverUrl },
      {
        clientInfo: {
          clientId: "bound-client",
          clientSecret: "bound-secret",
          redirectUris: ["http://localhost:19876/callback"],
          issuer: "https://old-auth.example.com",
        },
        tokens: {
          accessToken: "bound-access",
          refreshToken: "bound-refresh",
          issuer: "https://old-auth.example.com",
        },
        serverUrl,
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "changed-issuer",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });

    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://new-auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://new-auth.example.com",
        authorization_endpoint: "https://new-auth.example.com/authorize",
        token_endpoint: "https://new-auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    await expect(provider.clientInformation()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    await expect(provider.tokens()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
  });

  it("does not stamp unbound tokens when client information has a different issuer", async () => {
    saveAuthEntry(
      { serverName: "partial-client-binding", serverUrl },
      {
        clientInfo: {
          clientId: "bound-client",
          clientSecret: "bound-secret",
          redirectUris: ["http://localhost:19876/callback"],
          issuer: "https://old-auth.example.com",
        },
        tokens: { accessToken: "legacy-access", refreshToken: "legacy-refresh" },
        serverUrl,
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "partial-client-binding",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://new-auth.example.com" });

    await expect(provider.tokens()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    expect(
      getAuthForUrl({ serverName: "partial-client-binding", serverUrl })?.tokens?.issuer,
    ).toBeUndefined();
  });

  it("does not stamp unbound client information when tokens have a different issuer", async () => {
    saveAuthEntry(
      { serverName: "partial-token-binding", serverUrl },
      {
        clientInfo: {
          clientId: "legacy-client",
          clientSecret: "legacy-secret",
          redirectUris: ["http://localhost:19876/callback"],
        },
        tokens: {
          accessToken: "bound-access",
          refreshToken: "bound-refresh",
          issuer: "https://old-auth.example.com",
        },
        serverUrl,
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "partial-token-binding",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://new-auth.example.com" });

    await expect(provider.clientInformation()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    expect(
      getAuthForUrl({ serverName: "partial-token-binding", serverUrl })?.clientInfo?.issuer,
    ).toBeUndefined();
  });

  it("persists a pre-registered issuer binding without the config secret", async () => {
    const provider = new McpOAuthProvider({
      serverName: "pre-registered-binding",
      serverUrl,
      config: { clientId: "config-client", clientSecret: "config-secret" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    expect(await provider.clientInformation()).toMatchObject({
      client_id: "config-client",
      client_secret: "config-secret",
      issuer: "https://auth.example.com",
    });
    expect(getAuthForUrl({ serverName: "pre-registered-binding", serverUrl })?.clientInfo).toEqual({
      clientId: "config-client",
      issuer: "https://auth.example.com",
      configPreRegistered: true,
    });
  });

  it("fails closed when a pre-registered client issuer changes", async () => {
    saveAuthEntry(
      { serverName: "pre-registered-issuer-change", serverUrl },
      {
        clientInfo: {
          clientId: "config-client",
          issuer: "https://old-auth.example.com",
          configPreRegistered: true,
        },
        serverUrl,
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "pre-registered-issuer-change",
      serverUrl,
      config: { clientId: "config-client", clientSecret: "config-secret" },
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://new-auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://new-auth.example.com",
        authorization_endpoint: "https://new-auth.example.com/authorize",
        token_endpoint: "https://new-auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    await expect(provider.clientInformation()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    expect(
      getAuthForUrl({ serverName: "pre-registered-issuer-change", serverUrl })?.clientInfo?.issuer,
    ).toBe("https://old-auth.example.com");
  });

  it("round-trips callback-leg discovery state and invalidates it independently", async () => {
    const provider = new McpOAuthProvider({
      serverName: "discovery-state",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    const discoveryState = {
      authorizationServerUrl: "https://auth.example.com",
      resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    };

    await provider.saveDiscoveryState(discoveryState);
    expect(await provider.discoveryState()).toEqual(discoveryState);

    const otherRuntimeProvider = new McpOAuthProvider({
      serverName: "discovery-state",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });
    expect(await otherRuntimeProvider.discoveryState()).toBeUndefined();

    await provider.saveTokens({
      access_token: "access-token",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    });
    expect(await provider.discoveryState()).toBeUndefined();

    await provider.saveDiscoveryState(discoveryState);
    await provider.invalidateCredentials("discovery");

    expect(await provider.discoveryState()).toBeUndefined();
    expect((await provider.tokens())?.access_token).toBe("access-token");
  });
});

describe("McpOAuthProvider authorization fallback", () => {
  const originalOAuthDir = process.env.FITCH_MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-provider-"));
    process.env.FITCH_MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.FITCH_MCP_OAUTH_DIR;
    } else {
      process.env.FITCH_MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("throws UnauthorizedError when state is requested outside a user-initiated flow", async () => {
    const provider = new McpOAuthProvider({
      serverName: "state-missing",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          // These provider-only checks do not open a browser.
        },
      },
    });

    await expect(provider.state()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(provider.state()).rejects.toThrow(/Re-authentication required/);
  });

  it("throws UnauthorizedError before redirecting when no OAuth flow is in progress", async () => {
    let redirected = false;
    const provider = new McpOAuthProvider({
      serverName: "redirect-missing",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          redirected = true;
        },
      },
    });

    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redirected).toBe(false);
  });

  it("redirects when the active provider owns OAuth state", async () => {
    const authUrl = new URL("https://auth.example.com/authorize");
    let redirected: URL | undefined;
    const provider = new McpOAuthProvider({
      serverName: "redirect-active",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async (url) => {
          redirected = url;
        },
      },
      storageOptions: {},
      runtimeSignal: undefined,
      initialState: "state-abc",
    });

    await provider.redirectToAuthorization(authUrl);

    expect(redirected).toBe(authUrl);
  });

  it("throws before redirecting when only stale URL-bound state exists", async () => {
    let redirected = false;
    saveAuthEntry(
      { serverName: "redirect-stale-url", serverUrl: "https://old.example.com/mcp" },
      {
        oauthState: "state-abc",
        serverUrl: "https://old.example.com/mcp",
      },
    );
    const provider = new McpOAuthProvider({
      serverName: "redirect-stale-url",
      serverUrl,
      config: {},
      callbacks: {
        onRedirect: async () => {
          redirected = true;
        },
      },
    });

    await expect(
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redirected).toBe(false);
  });
});
