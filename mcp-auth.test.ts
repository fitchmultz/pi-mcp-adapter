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
    nodeIt("preserves loader failures and tries the Linux musl binding after gnu", async () => {
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
        await assert.rejects(
          async () =>
            getAuthEntry({ serverName: "fallback-failure", serverUrl: "https://api.example.com" }),
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
        let eventLoopTicks = 0;
        let settled = false;
        const tick = setInterval(() => {
          if (!settled) {
            eventLoopTicks += 1;
          }
        }, 2);
        try {
          const entry = await getAuthEntry({
            serverName: "fallback-success",
            serverUrl: "https://api.example.com",
          });
          settled = true;
          assert.strictEqual(entry, undefined);
        } finally {
          clearInterval(tick);
        }
        assert.ok(
          eventLoopTicks > 0,
          `expected other event-loop work to progress during AsyncEntry read, got ${eventLoopTicks} ticks`,
        );
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
    nodeIt("should return undefined for non-existent entry", async () => {
      const entry = await getAuthEntry({
        serverName: "non-existent",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry, undefined);
    });

    nodeIt("should import legacy plaintext entries and remove the file", async () => {
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

      const entry = await getAuthEntry({
        serverName: "legacy-import",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.tokens?.accessToken, "legacy-token");
      assert.strictEqual(existsSync(filePath), false);
      assert.strictEqual(
        (await getAuthEntry({ serverName: "legacy-import", serverUrl: "https://api.example.com" }))
          ?.tokens?.accessToken,
        "legacy-token",
      );
    });

    nodeIt("should fail closed when the secure credential store is unavailable", async () => {
      const previous = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
      try {
        await assert.rejects(
          async () =>
            getAuthEntry({
              serverName: "secure-store-unavailable",
              serverUrl: "https://api.example.com",
            }),
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
    nodeIt("saves the URL without mutating the supplied auth entry", async () => {
      const entry: AuthEntry = Object.freeze({
        tokens: {
          accessToken: "test-token",
          refreshToken: "refresh-token",
          expiresAt: 1234567890,
          scope: "read write",
        },
      });

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry,
      );
      assert.strictEqual(entry.serverUrl, undefined);
      const retrieved = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.deepStrictEqual(retrieved, { ...entry, serverUrl: "https://api.example.com" });
    });

    nodeIt("should update existing entries", async () => {
      const entry1: AuthEntry = {
        tokens: { accessToken: "token1" },
        serverUrl: "https://api.example.com",
      };
      const entry2: AuthEntry = {
        tokens: { accessToken: "token2" },
        serverUrl: "https://api.example.com",
      };

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry1,
      );
      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry2,
      );
      const retrieved = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.strictEqual(retrieved?.tokens?.accessToken, "token2");
    });
  });

  nodeDescribe("getAuthForUrl", () => {
    nodeIt("should return entry when URL matches", async () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
        serverUrl: "https://api.example.com",
      };

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry,
      );
      const retrieved = await getAuthForUrl({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.deepStrictEqual(retrieved, entry);
    });

    nodeIt("should return undefined when URL doesn't match", async () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
        serverUrl: "https://api.example.com",
      };

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry,
      );
      const retrieved = await getAuthForUrl({
        serverName: "test-server",
        serverUrl: "https://different.com",
      });

      assert.strictEqual(retrieved, undefined);
    });

    nodeIt("stores the URL from identity even when the supplied record omits it", async () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
      };

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry,
      );
      const retrieved = await getAuthForUrl({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.strictEqual(retrieved?.serverUrl, "https://api.example.com");
    });
  });

  nodeDescribe("removeAuthEntry", () => {
    nodeIt("should remove an entry", async () => {
      const entry: AuthEntry = {
        tokens: { accessToken: "test-token" },
      };

      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        entry,
      );
      await removeAuthEntry({ serverName: "test-server", serverUrl: "https://api.example.com" });
      const retrieved = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.strictEqual(retrieved, undefined);
    });
  });

  nodeDescribe("updateTokens", () => {
    nodeIt("should update tokens for a server", async () => {
      await updateTokens(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        {
          accessToken: "new-token",
          refreshToken: "new-refresh",
          expiresAt: 1234567890,
          scope: "read",
        },
      );

      const entry = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.tokens?.accessToken, "new-token");
    });

    nodeIt("should preserve existing client info", async () => {
      await updateClientInfo(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { clientId: "client-123" },
      );
      await updateTokens(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { accessToken: "token" },
      );

      const entry = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.clientInfo?.clientId, "client-123");
      assert.strictEqual(entry.tokens?.accessToken, "token");
    });

    nodeIt("keeps old URL credentials separate when saving tokens for a new URL", async () => {
      await saveAuthEntry(
        { serverName: "token-url-change", serverUrl: "https://old.example.com/mcp" },
        {
          tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
          clientInfo: { clientId: "old-client" },
          codeVerifier: "old-verifier",
          oauthState: "old-state",
          serverUrl: "https://old.example.com/mcp",
        },
      );

      await updateTokens(
        { serverName: "token-url-change", serverUrl: "https://new.example.com/mcp" },
        { accessToken: "new-token" },
      );

      assert.strictEqual(
        (
          await getAuthForUrl({
            serverName: "token-url-change",
            serverUrl: "https://old.example.com/mcp",
          })
        )?.tokens?.accessToken,
        "old-token",
      );
      const newEntry = await getAuthForUrl({
        serverName: "token-url-change",
        serverUrl: "https://new.example.com/mcp",
      });
      assert.strictEqual(newEntry?.tokens?.accessToken, "new-token");
      assert.strictEqual(newEntry.clientInfo, undefined);
      assert.strictEqual(newEntry.codeVerifier, undefined);
      assert.strictEqual(newEntry.oauthState, undefined);
    });

    nodeIt(
      "should clear legacy URL-bound auth state when saving tokens with a server URL",
      async () => {
        await saveAuthEntry(
          { serverName: "token-legacy-url-change", serverUrl: "https://api.example.com" },
          {
            tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
            clientInfo: { clientId: "old-client" },
            codeVerifier: "old-verifier",
            oauthState: "old-state",
          },
        );

        await updateTokens(
          { serverName: "token-legacy-url-change", serverUrl: "https://new.example.com/mcp" },
          { accessToken: "new-token" },
        );

        const newEntry = await getAuthForUrl({
          serverName: "token-legacy-url-change",
          serverUrl: "https://new.example.com/mcp",
        });
        assert.strictEqual(newEntry?.tokens?.accessToken, "new-token");
        assert.strictEqual(newEntry.clientInfo, undefined);
        assert.strictEqual(newEntry.codeVerifier, undefined);
        assert.strictEqual(newEntry.oauthState, undefined);
      },
    );
  });

  nodeDescribe("updateClientInfo", () => {
    nodeIt("should update client info for a server", async () => {
      await updateClientInfo(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        {
          clientId: "client-123",
          clientSecret: "secret",
          clientIdIssuedAt: 1234567890,
          clientSecretExpiresAt: 1234567999,
        },
      );

      const entry = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.clientInfo?.clientId, "client-123");
      assert.strictEqual(entry.clientInfo.clientSecret, "secret");
    });

    nodeIt("keeps old URL credentials separate when saving client info for a new URL", async () => {
      await saveAuthEntry(
        { serverName: "url-change", serverUrl: "https://old.example.com/mcp" },
        {
          tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
          clientInfo: { clientId: "old-client" },
          codeVerifier: "old-verifier",
          oauthState: "old-state",
          serverUrl: "https://old.example.com/mcp",
        },
      );

      await updateClientInfo(
        { serverName: "url-change", serverUrl: "https://new.example.com/mcp" },
        { clientId: "new-client" },
      );

      assert.strictEqual(
        (
          await getAuthForUrl({
            serverName: "url-change",
            serverUrl: "https://old.example.com/mcp",
          })
        )?.tokens?.accessToken,
        "old-token",
      );
      const newEntry = await getAuthForUrl({
        serverName: "url-change",
        serverUrl: "https://new.example.com/mcp",
      });
      assert.strictEqual(newEntry?.clientInfo?.clientId, "new-client");
      assert.strictEqual(newEntry.tokens, undefined);
      assert.strictEqual(newEntry.codeVerifier, undefined);
      assert.strictEqual(newEntry.oauthState, undefined);
    });

    nodeIt(
      "should clear stale verifier and state when legacy client info gains a server URL",
      async () => {
        await saveAuthEntry(
          { serverName: "legacy-url-change", serverUrl: "https://api.example.com" },
          {
            tokens: { accessToken: "old-token", refreshToken: "old-refresh" },
            clientInfo: { clientId: "old-client" },
            codeVerifier: "old-verifier",
            oauthState: "old-state",
          },
        );

        await updateClientInfo(
          { serverName: "legacy-url-change", serverUrl: "https://new.example.com/mcp" },
          { clientId: "new-client" },
        );

        const newEntry = await getAuthForUrl({
          serverName: "legacy-url-change",
          serverUrl: "https://new.example.com/mcp",
        });
        assert.strictEqual(newEntry?.clientInfo?.clientId, "new-client");
        assert.strictEqual(newEntry.tokens, undefined);
        assert.strictEqual(newEntry.codeVerifier, undefined);
        assert.strictEqual(newEntry.oauthState, undefined);
      },
    );
  });

  nodeDescribe("legacy flow state cleanup", () => {
    nodeIt("clears a code verifier", async () => {
      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { codeVerifier: "verifier-123" },
      );
      await clearCodeVerifier({ serverName: "test-server", serverUrl: "https://api.example.com" });
      assert.strictEqual(
        (await getAuthEntry({ serverName: "test-server", serverUrl: "https://api.example.com" }))
          ?.codeVerifier,
        undefined,
      );
    });

    nodeIt("clears OAuth state", async () => {
      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { oauthState: "state-abc-123" },
      );
      assert.strictEqual(
        await getOAuthState({ serverName: "test-server", serverUrl: "https://api.example.com" }),
        "state-abc-123",
      );
      await clearOAuthState({ serverName: "test-server", serverUrl: "https://api.example.com" });
      assert.strictEqual(
        await getOAuthState({ serverName: "test-server", serverUrl: "https://api.example.com" }),
        undefined,
      );
    });
  });

  nodeDescribe("clearAllCredentials", () => {
    nodeIt("should remove all credentials", async () => {
      await saveAuthEntry(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        {
          tokens: { accessToken: "token" },
          clientInfo: { clientId: "client" },
          codeVerifier: "verifier",
        },
      );

      await clearAllCredentials({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });

      assert.strictEqual(
        await getAuthEntry({ serverName: "test-server", serverUrl: "https://api.example.com" }),
        undefined,
      );
    });
  });

  nodeDescribe("clearClientInfo", () => {
    nodeIt("should only remove client info", async () => {
      await updateTokens(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { accessToken: "token" },
      );
      await updateClientInfo(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { clientId: "client" },
      );

      await clearClientInfo({ serverName: "test-server", serverUrl: "https://api.example.com" });

      const entry = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.clientInfo, undefined);
      assert.strictEqual(entry?.tokens?.accessToken, "token");
    });
  });

  nodeDescribe("clearTokens", () => {
    nodeIt("should only remove tokens", async () => {
      await updateTokens(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { accessToken: "token" },
      );
      await updateClientInfo(
        { serverName: "test-server", serverUrl: "https://api.example.com" },
        { clientId: "client" },
      );

      await clearTokens({ serverName: "test-server", serverUrl: "https://api.example.com" });

      const entry = await getAuthEntry({
        serverName: "test-server",
        serverUrl: "https://api.example.com",
      });
      assert.strictEqual(entry?.tokens, undefined);
      assert.strictEqual(entry?.clientInfo?.clientId, "client");
    });
  });
});
