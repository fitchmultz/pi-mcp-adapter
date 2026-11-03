/**
 * Tests for mcp-auth.ts - Auth storage module
 */

import { describe as nodeDescribe, it as nodeIt, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { registerHooks } from "node:module";

// Set up isolated temp directory for tests
const TEST_DIR = join(tmpdir(), `mcp-oauth-test-${randomBytes(4).toString("hex")}`);
process.env.FITCH_MCP_OAUTH_DIR = TEST_DIR;

import {
  getAuthEntry,
  getAuthEntryFilePath,
  getAuthForUrl,
  saveAuthEntry,
  removeAuthEntry,
  updateTokens,
  updateClientInfo,
  clearCodeVerifier,
  getOAuthState,
  clearOAuthState,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  type AuthEntry,
} from "./mcp-auth.ts";

nodeDescribe("mcp-auth", () => {
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
  });

  nodeDescribe("keyring native binding fallback", () => {
    nodeIt("preserves loader failures and tries the Linux musl binding after gnu", () => {
      const originalStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
      assert(platformDescriptor !== undefined);
      assert(archDescriptor !== undefined);
      const loaderError = new Error("package loader failed");
      const resolved: string[] = [];
      let linuxFallback = false;
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@napi-rs/keyring") {
            throw loaderError;
          }
          if (linuxFallback && specifier.startsWith("@napi-rs/keyring-linux-x64-")) {
            resolved.push(specifier);
            if (specifier.includes("-gnu/")) {
              throw new Error("gnu binding unavailable");
            }
            return { url: "file:///tmp/keyring-linux-x64-musl/package.json", shortCircuit: true };
          }
          if (specifier.endsWith(".node")) {
            if (linuxFallback && specifier.endsWith("keyring.linux-x64-musl.node")) {
              return {
                url: new URL("./__tests__/fixtures/keyring-read-only.cts", import.meta.url).href,
                shortCircuit: true,
              };
            }
            throw new Error("native binding failed");
          }
          return nextResolve(specifier, context);
        },
      });
      try {
        delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
        assert.throws(
          () => getAuthEntry("fallback-failure"),
          (error) => {
            assert(error instanceof Error);
            assert.match(error.message, /Failed to read OAuth credentials/);
            let current: unknown = error;
            while (typeof current === "object" && current !== null) {
              if (current === loaderError) {
                return true;
              }
              current = "cause" in current ? current.cause : undefined;
            }
            assert.fail("original loader error was not preserved in the cause chain");
          },
        );

        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
        Object.defineProperty(process, "arch", { ...archDescriptor, value: "x64" });
        linuxFallback = true;
        assert.strictEqual(getAuthEntry("fallback-success"), undefined);
        assert.deepStrictEqual(resolved, [
          "@napi-rs/keyring-linux-x64-gnu/package.json",
          "@napi-rs/keyring-linux-x64-musl/package.json",
        ]);
      } finally {
        hooks.deregister();
        Object.defineProperty(process, "platform", platformDescriptor);
        Object.defineProperty(process, "arch", archDescriptor);
        if (originalStore === undefined) {
          delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
        } else {
          process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = originalStore;
        }
      }
    });
  });

  nodeDescribe("getAuthEntry", () => {
    nodeIt("should return undefined for non-existent entry", () => {
      const entry = getAuthEntry("non-existent");
      assert.strictEqual(entry, undefined);
    });

    nodeIt("should import legacy plaintext entries and remove the file", () => {
      const filePath = getAuthEntryFilePath("legacy-import");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          tokens: { accessToken: "legacy-token" },
          serverUrl: "https://api.example.com",
        }),
        "utf-8",
      );

      const entry = getAuthEntry("legacy-import");
      assert.strictEqual(entry?.tokens?.accessToken, "legacy-token");
      assert.strictEqual(existsSync(filePath), false);
      assert.strictEqual(getAuthEntry("legacy-import")?.tokens?.accessToken, "legacy-token");
    });

    nodeIt("should fail closed when the secure credential store is unavailable", () => {
      const previous = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
      try {
        assert.throws(
          () => getAuthEntry("secure-store-unavailable"),
          /Failed to read OAuth credentials.*OS secure credential store/,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
        } else {
          process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previous;
        }
      }
    });
  });

  nodeDescribe("saveAuthEntry / getAuthEntry", () => {
    nodeIt("should save and retrieve an auth entry", () => {
      const entry: AuthEntry = {
        tokens: {
          accessToken: "test-token",
          refreshToken: "refresh-token",
          expiresAt: 1234567890,
          scope: "read write",
        },
        serverUrl: "https://api.example.com",
      };

      saveAuthEntry("test-server", entry, "https://api.example.com");
      const retrieved = getAuthEntry("test-server");

      assert.deepStrictEqual(retrieved, entry);
    });

    nodeIt("should update existing entries", () => {
      const entry1: AuthEntry = {
        tokens: { accessToken: "token1" },
        serverUrl: "https://api.example.com",
      };
      const entry2: AuthEntry = {
        tokens: { accessToken: "token2" },
        serverUrl: "https://api.example.com",
      };

      saveAuthEntry("test-server", entry1, "https://api.example.com");
      saveAuthEntry("test-server", entry2, "https://api.example.com");
      const retrieved = getAuthEntry("test-server");

      assert.strictEqual(retrieved?.tokens?.accessToken, "token2");
    });
  });

  nodeDescribe("getAuthForUrl", () => {
    nodeIt("should return entry when URL matches", () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
        serverUrl: "https://api.example.com",
      };

      saveAuthEntry("test-server", entry, "https://api.example.com");
      const retrieved = getAuthForUrl("test-server", "https://api.example.com");

      assert.deepStrictEqual(retrieved, entry);
    });

    nodeIt("should return undefined when URL doesn't match", () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
        serverUrl: "https://api.example.com",
      };

      saveAuthEntry("test-server", entry, "https://api.example.com");
      const retrieved = getAuthForUrl("test-server", "https://different.com");

      assert.strictEqual(retrieved, undefined);
    });

    nodeIt("should return undefined when serverUrl is not stored", () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
      };

      saveAuthEntry("test-server", entry);
      const retrieved = getAuthForUrl("test-server", "https://api.example.com");

      assert.strictEqual(retrieved, undefined);
    });
  });

  nodeDescribe("removeAuthEntry", () => {
    nodeIt("should remove an entry", () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
      };

      saveAuthEntry("test-server", entry);
      removeAuthEntry("test-server");
      const retrieved = getAuthEntry("test-server");

      assert.strictEqual(retrieved, undefined);
    });
  });

  nodeDescribe("updateTokens", () => {
    nodeIt("should update tokens for a server", () => {
      updateTokens("test-server", {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: 1234567890,
        scope: "read",
      });

      const entry = getAuthEntry("test-server");
      assert.strictEqual(entry?.tokens?.accessToken, "new-token");
    });

    nodeIt("should preserve existing client info", () => {
      updateClientInfo("test-server", { clientId: "client-123" });
      updateTokens("test-server", { accessToken: "token" });

      const entry = getAuthEntry("test-server");
      assert.strictEqual(entry?.clientInfo?.clientId, "client-123");
      assert.strictEqual(entry.tokens?.accessToken, "token");
    });

    nodeIt("should clear URL-bound auth state when tokens move to a different server URL", () => {
      saveAuthEntry(
        "token-url-change",
        {
          tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
          clientInfo: { clientId: "old-client" },
          codeVerifier: "old-verifier",
          oauthState: "old-state",
          serverUrl: "https://old.example.com/mcp",
        },
        "https://old.example.com/mcp",
      );

      updateTokens("token-url-change", { accessToken: "new-token" }, "https://new.example.com/mcp");

      assert.strictEqual(
        getAuthForUrl("token-url-change", "https://old.example.com/mcp"),
        undefined,
      );
      const newEntry = getAuthForUrl("token-url-change", "https://new.example.com/mcp");
      assert.strictEqual(newEntry?.tokens?.accessToken, "new-token");
      assert.strictEqual(newEntry.clientInfo, undefined);
      assert.strictEqual(newEntry.codeVerifier, undefined);
      assert.strictEqual(newEntry.oauthState, undefined);
    });

    nodeIt("should clear legacy URL-bound auth state when saving tokens with a server URL", () => {
      saveAuthEntry("token-legacy-url-change", {
        tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
        clientInfo: { clientId: "old-client" },
        codeVerifier: "old-verifier",
        oauthState: "old-state",
      });

      updateTokens(
        "token-legacy-url-change",
        { accessToken: "new-token" },
        "https://new.example.com/mcp",
      );

      const newEntry = getAuthForUrl("token-legacy-url-change", "https://new.example.com/mcp");
      assert.strictEqual(newEntry?.tokens?.accessToken, "new-token");
      assert.strictEqual(newEntry.clientInfo, undefined);
      assert.strictEqual(newEntry.codeVerifier, undefined);
      assert.strictEqual(newEntry.oauthState, undefined);
    });
  });

  nodeDescribe("updateClientInfo", () => {
    nodeIt("should update client info for a server", () => {
      updateClientInfo("test-server", {
        clientId: "client-123",
        clientSecret: "secret",
        clientIdIssuedAt: 1234567890,
        clientSecretExpiresAt: 1234567999,
      });

      const entry = getAuthEntry("test-server");
      assert.strictEqual(entry?.clientInfo?.clientId, "client-123");
      assert.strictEqual(entry.clientInfo.clientSecret, "secret");
    });

    nodeIt(
      "should clear URL-bound credentials when client info moves to a different server URL",
      () => {
        saveAuthEntry(
          "url-change",
          {
            tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
            clientInfo: { clientId: "old-client" },
            codeVerifier: "old-verifier",
            oauthState: "old-state",
            serverUrl: "https://old.example.com/mcp",
          },
          "https://old.example.com/mcp",
        );

        updateClientInfo("url-change", { clientId: "new-client" }, "https://new.example.com/mcp");

        assert.strictEqual(getAuthForUrl("url-change", "https://old.example.com/mcp"), undefined);
        const newEntry = getAuthForUrl("url-change", "https://new.example.com/mcp");
        assert.strictEqual(newEntry?.clientInfo?.clientId, "new-client");
        assert.strictEqual(newEntry.tokens, undefined);
        assert.strictEqual(newEntry.codeVerifier, undefined);
        assert.strictEqual(newEntry.oauthState, undefined);
      },
    );

    nodeIt(
      "should clear stale verifier and state when legacy client info gains a server URL",
      () => {
        saveAuthEntry("legacy-url-change", {
          tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
          clientInfo: { clientId: "old-client" },
          codeVerifier: "old-verifier",
          oauthState: "old-state",
        });

        updateClientInfo(
          "legacy-url-change",
          { clientId: "new-client" },
          "https://new.example.com/mcp",
        );

        const newEntry = getAuthForUrl("legacy-url-change", "https://new.example.com/mcp");
        assert.strictEqual(newEntry?.clientInfo?.clientId, "new-client");
        assert.strictEqual(newEntry.tokens, undefined);
        assert.strictEqual(newEntry.codeVerifier, undefined);
        assert.strictEqual(newEntry.oauthState, undefined);
      },
    );
  });

  nodeDescribe("legacy flow state cleanup", () => {
    nodeIt("clears a code verifier", () => {
      saveAuthEntry("test-server", { codeVerifier: "verifier-123" });
      clearCodeVerifier("test-server");
      assert.strictEqual(getAuthEntry("test-server")?.codeVerifier, undefined);
    });

    nodeIt("clears OAuth state", () => {
      saveAuthEntry("test-server", { oauthState: "state-abc-123" });
      assert.strictEqual(getOAuthState("test-server"), "state-abc-123");
      clearOAuthState("test-server");
      assert.strictEqual(getOAuthState("test-server"), undefined);
    });
  });

  nodeDescribe("clearAllCredentials", () => {
    nodeIt("should remove all credentials", () => {
      saveAuthEntry("test-server", {
        tokens: { accessToken: "token" },
        clientInfo: { clientId: "client" },
        codeVerifier: "verifier",
      });

      clearAllCredentials("test-server");

      assert.strictEqual(getAuthEntry("test-server"), undefined);
    });
  });

  nodeDescribe("clearClientInfo", () => {
    nodeIt("should only remove client info", () => {
      updateTokens("test-server", { accessToken: "token" });
      updateClientInfo("test-server", { clientId: "client" });

      clearClientInfo("test-server");

      const entry = getAuthEntry("test-server");
      assert.strictEqual(entry?.clientInfo, undefined);
      assert.strictEqual(entry?.tokens?.accessToken, "token");
    });
  });

  nodeDescribe("clearTokens", () => {
    nodeIt("should only remove tokens", () => {
      updateTokens("test-server", { accessToken: "token" });
      updateClientInfo("test-server", { clientId: "client" });

      clearTokens("test-server");

      const entry = getAuthEntry("test-server");
      assert.strictEqual(entry?.tokens, undefined);
      assert.strictEqual(entry?.clientInfo?.clientId, "client");
    });
  });
});
