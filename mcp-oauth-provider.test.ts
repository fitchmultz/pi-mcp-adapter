/**
 * Tests for mcp-oauth-provider.ts - OAuth provider implementation
 */

import { describe as nodeDescribe, it as nodeIt, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// Set up isolated temp directory for tests
const TEST_DIR = join(tmpdir(), `mcp-oauth-test-${randomBytes(4).toString("hex")}`);
process.env.FITCH_MCP_OAUTH_DIR = TEST_DIR;

import {
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  McpOAuthProvider,
  setOAuthCallbackPath,
  setOAuthCallbackPort,
  type McpOAuthConfig,
} from "./mcp-oauth-provider.ts";
import { clearAllCredentials, getAuthForUrl, saveAuthEntry } from "./mcp-auth.ts";
import {
  UnauthorizedError,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from "@modelcontextprotocol/client";

nodeDescribe("McpOAuthProvider", () => {
  const serverName = "test-server";
  const serverUrl = "https://api.example.com";
  let redirectCaptured: URL | undefined;

  before(() => {
    // Ensure clean state
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true });
      }
      mkdirSync(TEST_DIR, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  after(() => {
    // Clean up temp directory
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    redirectCaptured = undefined;
  });

  function createProvider(config: McpOAuthConfig = {}) {
    return new McpOAuthProvider({
      serverName,
      serverUrl,
      config,
      callbacks: {
        onRedirect: async (url) => {
          redirectCaptured = url;
        },
      },
    });
  }

  nodeDescribe("redirectUrl", () => {
    nodeIt("should return the correct redirect URL", () => {
      const provider = createProvider();
      assert.strictEqual(provider.redirectUrl, "http://localhost:19876/callback");
    });

    nodeIt("should use a configured redirect URI", () => {
      const provider = createProvider({ redirectUri: "http://localhost:3118/slack/callback" });
      assert.strictEqual(provider.redirectUrl, "http://localhost:3118/slack/callback");
    });

    nodeIt("should snapshot generated redirect URI at construction", () => {
      const originalPort = getOAuthCallbackPort();
      const originalPath = getOAuthCallbackPath();
      setOAuthCallbackPort(41234);
      setOAuthCallbackPath("/snapshot/callback");

      try {
        const provider = createProvider();
        setOAuthCallbackPort(52345);
        setOAuthCallbackPath("/changed/callback");

        assert.strictEqual(provider.redirectUrl, "http://localhost:41234/snapshot/callback");
        assert.deepStrictEqual(provider.clientMetadata.redirect_uris, [
          "http://localhost:41234/snapshot/callback",
        ]);
      } finally {
        setOAuthCallbackPort(originalPort);
        setOAuthCallbackPath(originalPath);
      }
    });
  });

  nodeDescribe("clientMetadata", () => {
    nodeIt("should return correct metadata for public client", () => {
      const provider = createProvider();
      const metadata = provider.clientMetadata;

      assert.deepStrictEqual(metadata.redirect_uris, ["http://localhost:19876/callback"]);
      assert.strictEqual(metadata.client_name, "Pi Coding Agent");
      assert.strictEqual(metadata.client_uri, "https://github.com/fitchmultz/pi-mcp-adapter");
      assert.deepStrictEqual(metadata.grant_types, ["authorization_code", "refresh_token"]);
      assert.deepStrictEqual(metadata.response_types, ["code"]);
      assert.strictEqual(metadata.token_endpoint_auth_method, "none");
    });

    nodeIt("should return correct metadata for confidential client", () => {
      const provider = createProvider({ clientSecret: "secret" });
      const metadata = provider.clientMetadata;

      assert.strictEqual(metadata.token_endpoint_auth_method, "client_secret_post");
    });

    nodeIt("should use configured redirect URI and client metadata", () => {
      const provider = createProvider({
        redirectUri: "http://localhost:3118/slack/callback",
        clientName: "Slack MCP",
        clientUri: "https://example.com/slack-mcp",
      });
      const metadata = provider.clientMetadata;

      assert.deepStrictEqual(metadata.redirect_uris, ["http://localhost:3118/slack/callback"]);
      assert.strictEqual(metadata.client_name, "Slack MCP");
      assert.strictEqual(metadata.client_uri, "https://example.com/slack-mcp");
    });

    nodeIt("should use configured client name for client_credentials", () => {
      const provider = createProvider({
        grantType: "client_credentials",
        clientName: "Service MCP",
      });
      const metadata = provider.clientMetadata;

      assert.strictEqual(metadata.client_name, "Service MCP");
      assert.deepStrictEqual(metadata.redirect_uris, []);
      assert.deepStrictEqual(metadata.grant_types, ["client_credentials"]);
    });
  });

  nodeDescribe("clientInformation", () => {
    nodeIt("should return config clientId when provided", async () => {
      const provider = createProvider({ clientId: "config-client", clientSecret: "config-secret" });
      const info = await provider.clientInformation();

      assert.strictEqual(info?.client_id, "config-client");
      assert.strictEqual(info.client_secret, "config-secret");
    });

    nodeIt("should return stored client info when no config", async () => {
      const provider = createProvider();

      // Save client info directly
      saveAuthEntry(
        { serverName, serverUrl },
        {
          clientInfo: {
            clientId: "stored-client",
            clientSecret: "stored-secret",
            clientIdIssuedAt: Math.floor(Date.now() / 1000),
            clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          serverUrl,
        },
      );

      const info = await provider.clientInformation();
      assert.strictEqual(info?.client_id, "stored-client");
      assert.strictEqual(info.client_secret, "stored-secret");
    });

    nodeIt("should return undefined when URL doesn't match", async () => {
      clearAllCredentials({ serverName, serverUrl });
      const provider = createProvider();

      // Save client info with different URL
      saveAuthEntry(
        { serverName, serverUrl: "https://different.com" },
        {
          clientInfo: {
            clientId: "stored-client",
            clientSecret: "stored-secret",
          },
          serverUrl: "https://different.com",
        },
      );

      const info = await provider.clientInformation();
      assert.strictEqual(info, undefined);
    });

    nodeIt("should return undefined when client secret expired", async () => {
      const provider = createProvider();

      // Save client info with expired secret
      saveAuthEntry(
        { serverName, serverUrl },
        {
          clientInfo: {
            clientId: "stored-client",
            clientSecret: "stored-secret",
            clientSecretExpiresAt: 1, // Expired in 1970
          },
          serverUrl,
        },
      );

      const info = await provider.clientInformation();
      assert.strictEqual(info, undefined);
    });

    nodeIt(
      "should not serve a config-pre-registered stub when no config clientId is present",
      async () => {
        // Stub written by the config-clientId path of saveClientInformation
        // (SEP-2352 stamp-and-resave): {clientId, issuer} with the marker.
        const provider = createProvider();
        saveAuthEntry(
          { serverName, serverUrl },
          {
            clientInfo: {
              clientId: "config-client",
              issuer: "https://auth.example.com",
              configPreRegistered: true,
            },
            serverUrl,
          },
        );

        assert.strictEqual(await provider.clientInformation(), undefined);
      },
    );

    nodeIt(
      "should not serve a legacy unmarked {clientId, issuer} stub when no config clientId is present",
      async () => {
        const provider = createProvider();
        saveAuthEntry(
          { serverName, serverUrl },
          {
            clientInfo: {
              clientId: "config-client",
              issuer: "https://auth.example.com",
            },
            serverUrl,
          },
        );

        assert.strictEqual(await provider.clientInformation(), undefined);
      },
    );

    nodeIt(
      "should still serve a dynamically-registered public client (no secret) with registration metadata",
      async () => {
        const provider = createProvider();
        saveAuthEntry(
          { serverName, serverUrl },
          {
            clientInfo: {
              clientId: "public-client",
              clientIdIssuedAt: Math.floor(Date.now() / 1000),
              redirectUris: ["http://localhost:19876/callback"],
            },
            serverUrl,
          },
        );

        const info = await provider.clientInformation();
        assert.strictEqual(info?.client_id, "public-client");
        assert.strictEqual(info.client_secret, undefined);
      },
    );

    nodeIt("should prefer config over stored", async () => {
      const provider = createProvider({ clientId: "config-client" });

      // Save different client info
      saveAuthEntry(
        { serverName, serverUrl },
        {
          clientInfo: {
            clientId: "stored-client",
            clientSecret: "stored-secret",
          },
          serverUrl,
        },
      );

      const info = await provider.clientInformation();
      assert.strictEqual(info?.client_id, "config-client");
    });
  });

  nodeDescribe("saveClientInformation", () => {
    nodeIt("should save client information", async () => {
      const provider = createProvider();
      const futureTime = Math.floor(Date.now() / 1000) + 3600;
      const info: OAuthClientInformationFull = {
        client_id: "new-client",
        client_secret: "new-secret",
        redirect_uris: ["http://localhost:3118/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      };

      await provider.saveClientInformation(info);

      const storedInfo = await provider.clientInformation();
      assert.strictEqual(storedInfo?.client_id, "new-client");
      assert.strictEqual(storedInfo.client_secret, "new-secret");
      assert.deepStrictEqual(getAuthForUrl({ serverName, serverUrl })?.clientInfo?.redirectUris, [
        "http://localhost:3118/callback",
      ]);
    });

    nodeIt(
      "should save the current redirect URL when registration omits redirect_uris",
      async () => {
        const provider = new McpOAuthProvider({
          serverName: "redirect-fallback",
          serverUrl,
          config: { redirectUri: "http://localhost:3118/custom" },
          callbacks: {
            onRedirect() {
              throw new Error("Unexpected authorization redirect");
            },
          },
        });

        await provider.saveClientInformation({
          client_id: "fallback-client",
          client_secret: "fallback-secret",
        });

        assert.deepStrictEqual(
          getAuthForUrl({ serverName: "redirect-fallback", serverUrl })?.clientInfo?.redirectUris,
          ["http://localhost:3118/custom"],
        );
      },
    );

    nodeIt(
      "should return stored dynamic client info even when redirect URIs are stale",
      async () => {
        const provider = new McpOAuthProvider({
          serverName: "stale-redirect-client",
          serverUrl,
          config: { redirectUri: "http://localhost:3118/current" },
          callbacks: {
            onRedirect() {
              throw new Error("Unexpected authorization redirect");
            },
          },
        });
        saveAuthEntry(
          { serverName: "stale-redirect-client", serverUrl },
          {
            clientInfo: {
              clientId: "stored-client",
              clientSecret: "stored-secret",
              redirectUris: ["http://localhost:19876/callback"],
            },
            serverUrl,
          },
        );

        const info = await provider.clientInformation();
        assert.strictEqual(info?.client_id, "stored-client");
        assert.strictEqual(info.client_secret, "stored-secret");
      },
    );
  });

  nodeDescribe("tokens / saveTokens", () => {
    nodeIt("should save and retrieve tokens", async () => {
      const provider = createProvider();
      const tokens: OAuthTokens = {
        access_token: "access-123",
        token_type: "Bearer",
        refresh_token: "refresh-456",
        expires_in: 3600,
        scope: "read write",
      };

      await provider.saveTokens(tokens);
      const stored = await provider.tokens();

      assert.strictEqual(stored?.access_token, "access-123");
      assert.strictEqual(stored.refresh_token, "refresh-456");
      assert.strictEqual(stored.scope, "read write");
    });

    nodeIt("should calculate expires_in from stored expiresAt", async () => {
      const provider = createProvider();

      await provider.saveTokens({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 3600,
      });

      const stored = await provider.tokens();
      assert.ok(stored?.expires_in !== undefined);
      assert.ok(stored.expires_in > 0);
      assert.ok(stored.expires_in <= 3600);
    });

    nodeIt("should return undefined when URL doesn't match", async () => {
      clearAllCredentials({ serverName, serverUrl });
      const provider = createProvider();

      // Save tokens with different URL
      saveAuthEntry(
        { serverName, serverUrl: "https://different.com" },
        {
          tokens: {
            accessToken: "token",
          },
          serverUrl: "https://different.com",
        },
      );

      const stored = await provider.tokens();
      assert.strictEqual(stored, undefined);
    });
  });

  nodeDescribe("redirectToAuthorization", () => {
    nodeIt("should call onRedirect with URL when a flow is in progress", async () => {
      const provider = new McpOAuthProvider({
        serverName: "redirect-with-state",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect: async (url) => {
            redirectCaptured = url;
          },
        },
        storageOptions: {},
        runtimeSignal: undefined,
        initialState: "state-abc",
      });
      const testUrl = new URL("https://example.com/auth");

      await provider.redirectToAuthorization(testUrl);

      assert.strictEqual(redirectCaptured, testUrl);
    });

    nodeIt("should throw UnauthorizedError when no flow is in progress", async () => {
      const provider = new McpOAuthProvider({
        serverName: "redirect-no-state",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });

      await assert.rejects(
        async () => provider.redirectToAuthorization(new URL("https://example.com/auth")),
        (err: unknown) =>
          err instanceof UnauthorizedError && /Re-authentication required/.test(err.message),
      );
    });

    nodeIt(
      "should ignore OAuth state saved for a different server URL before redirecting",
      async () => {
        let redirected = false;
        const provider = new McpOAuthProvider({
          serverName: "redirect-url-bound",
          serverUrl,
          config: {},
          callbacks: {
            onRedirect: async () => {
              redirected = true;
            },
          },
        });
        saveAuthEntry(
          { serverName: "redirect-url-bound", serverUrl: "https://different.example.com" },
          {
            oauthState: "stale-state",
            serverUrl: "https://different.example.com",
          },
        );

        await assert.rejects(
          async () => provider.redirectToAuthorization(new URL("https://example.com/auth")),
          (err: unknown) =>
            err instanceof UnauthorizedError && /Re-authentication required/.test(err.message),
        );
        assert.strictEqual(redirected, false);
      },
    );
  });

  nodeDescribe("codeVerifier / saveCodeVerifier", () => {
    nodeIt("should save and retrieve code verifier", async () => {
      const provider = new McpOAuthProvider({
        serverName: "code-verifier-test",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });

      await provider.saveCodeVerifier("verifier-abc-123");

      const verifier = await provider.codeVerifier();
      assert.strictEqual(verifier, "verifier-abc-123");
      assert.strictEqual(getAuthForUrl({ serverName: "code-verifier-test", serverUrl }), undefined);
    });

    nodeIt("should throw when no code verifier", async () => {
      const provider = new McpOAuthProvider({
        serverName: "code-verifier-throw",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });

      await assert.rejects(async () => provider.codeVerifier(), /No code verifier saved/);
    });

    nodeIt("should ignore code verifiers saved for a different server URL", async () => {
      const provider = new McpOAuthProvider({
        serverName: "code-verifier-url-bound",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });
      saveAuthEntry(
        { serverName: "code-verifier-url-bound", serverUrl: "https://different.example.com" },
        {
          codeVerifier: "stale-verifier",
          serverUrl: "https://different.example.com",
        },
      );

      await assert.rejects(async () => provider.codeVerifier(), /No code verifier saved/);
    });
  });

  nodeDescribe("state / saveState", () => {
    nodeIt("should save and retrieve state", async () => {
      const provider = new McpOAuthProvider({
        serverName: "state-test-save",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });

      await provider.saveState("state-xyz-789");

      const state = await provider.state();
      assert.strictEqual(state, "state-xyz-789");
      assert.strictEqual(getAuthForUrl({ serverName: "state-test-save", serverUrl }), undefined);
    });

    nodeIt("should throw UnauthorizedError when no state is saved", async () => {
      const provider = new McpOAuthProvider({
        serverName: "state-test-throw",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });

      await assert.rejects(
        async () => provider.state(),
        (err: unknown) =>
          err instanceof UnauthorizedError && /Re-authentication required/.test(err.message),
      );
    });

    nodeIt("should ignore OAuth state saved for a different server URL", async () => {
      const provider = new McpOAuthProvider({
        serverName: "state-url-bound",
        serverUrl,
        config: {},
        callbacks: {
          onRedirect() {
            throw new Error("Unexpected authorization redirect");
          },
        },
      });
      saveAuthEntry(
        { serverName: "state-url-bound", serverUrl: "https://different.example.com" },
        {
          oauthState: "stale-state",
          serverUrl: "https://different.example.com",
        },
      );

      await assert.rejects(
        async () => provider.state(),
        (err: unknown) =>
          err instanceof UnauthorizedError && /Re-authentication required/.test(err.message),
      );
    });
  });

  nodeDescribe("invalidateCredentials", () => {
    nodeIt("should remove all credentials when type is 'all'", async () => {
      const provider = createProvider();

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      });
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
      });

      await provider.invalidateCredentials("all");

      assert.strictEqual(await provider.tokens(), undefined);
      assert.strictEqual(await provider.clientInformation(), undefined);
    });

    nodeIt("should only remove tokens when type is 'tokens'", async () => {
      const provider = createProvider();
      const futureTime = Math.floor(Date.now() / 1000) + 3600;

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      });
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      });

      await provider.invalidateCredentials("tokens");

      assert.strictEqual(await provider.tokens(), undefined);
      const clientInfo = await provider.clientInformation();
      assert.strictEqual(clientInfo?.client_id, "client");
    });

    nodeIt("should only remove client info when type is 'client'", async () => {
      const provider = createProvider();
      const futureTime = Math.floor(Date.now() / 1000) + 3600;

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      });
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      });

      await provider.invalidateCredentials("client");

      const tokens = await provider.tokens();
      assert.strictEqual(tokens?.access_token, "token");
      assert.strictEqual(await provider.clientInformation(), undefined);
    });
  });
});
