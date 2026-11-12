/**
 * Tests for mcp-auth-flow.ts - OAuth flow using MCP SDK
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
  authenticate,
  createOAuthRuntime,
  startAuth,
  removeAuth,
  supportsOAuth,
  extractOAuthConfig,
  shutdownOAuth,
} from "./mcp-auth-flow.ts";
import type { McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { getAuthEntry, updateTokens } from "./mcp-auth.ts";
import type { ServerEntry } from "./types.ts";

nodeDescribe("mcp-auth-flow", () => {
  let runtime: McpOAuthRuntime;

  before(() => {
    runtime = createOAuthRuntime();
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

  after(async () => {
    // Shutdown OAuth and clean up
    await shutdownOAuth(runtime);
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  nodeDescribe("supportsOAuth", () => {
    nodeIt("should return true for OAuth HTTP server", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
      };
      assert.strictEqual(supportsOAuth(definition), true);
    });

    nodeIt("should return false for bearer auth", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "bearer",
      };
      assert.strictEqual(supportsOAuth(definition), false);
    });

    nodeIt("should return false for implicit OAuth when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        headers: { "X-Goog-Api-Key": "api-key" },
      };
      assert.strictEqual(supportsOAuth(definition), false);
    });

    nodeIt("should return true for explicit OAuth even when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        headers: { "X-Tenant": "tenant-id" },
      };
      assert.strictEqual(supportsOAuth(definition), true);
    });

    nodeIt("should return false for stdio server", () => {
      const definition: ServerEntry = {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
      };
      assert.strictEqual(supportsOAuth(definition), false);
    });

    nodeIt("should return false when no URL", () => {
      const definition: ServerEntry = {};
      assert.strictEqual(supportsOAuth(definition), false);
    });
  });

  nodeDescribe("removeAuth", () => {
    nodeIt("should remove all credentials", async () => {
      updateTokens("remove-test", { accessToken: "token" });

      await removeAuth("remove-test", { runtime });

      assert.strictEqual(getAuthEntry("remove-test"), undefined);
    });
  });

  nodeDescribe("authenticate / completeAuth", () => {
    nodeIt("should throw if no server URL provided", async () => {
      await assert.rejects(
        async () => await authenticate("no-url-test", "", undefined, { runtime }),
        /Invalid URL/,
      );
    });

    nodeIt("should reject malformed OAuth redirectUri values", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "bad-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "not a url" },
            },
            { runtime },
          ),
        /Invalid OAuth redirectUri/,
      );
    });

    nodeIt("should reject non-local OAuth redirectUri values", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "remote-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "https://example.com:3118/callback" },
            },
            { runtime },
          ),
        /localhost or loopback/,
      );
    });

    nodeIt("should reject OAuth redirectUri values without an explicit port", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "no-port-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "http://localhost/callback" },
            },
            { runtime },
          ),
        /explicit numeric port/,
      );
    });

    nodeIt("should reject blank OAuth redirectUri values", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "blank-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "  " },
            },
            { runtime },
          ),
        /redirectUri must not be empty/,
      );
    });

    nodeIt("should reject OAuth redirectUri values with fragments", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "fragment-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "http://localhost:3118/callback#fragment" },
            },
            { runtime },
          ),
        /redirectUri must not include a fragment/,
      );
    });

    nodeIt("should reject OAuth redirectUri values with username or password", async () => {
      await assert.rejects(
        async () =>
          await startAuth(
            "credential-redirect",
            "https://api.example.com/mcp",
            {
              url: "https://api.example.com/mcp",
              auth: "oauth",
              oauth: { redirectUri: "http://user:pass@localhost:3118/callback" },
            },
            { runtime },
          ),
        /redirectUri must not include username or password/,
      );
    });

    nodeIt("should trim OAuth redirectUri and client metadata values", () => {
      const config = extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: {
          redirectUri: "  http://localhost:3118/callback  ",
          clientName: "  Custom MCP  ",
          clientUri: "  https://example.com/custom  ",
          authorizationParams: { prompt: "consent" },
        },
      });

      assert.strictEqual(config.redirectUri, "http://localhost:3118/callback");
      assert.strictEqual(config.clientName, "Custom MCP");
      assert.strictEqual(config.clientUri, "https://example.com/custom");
      assert.deepStrictEqual(config.authorizationParams, { prompt: "consent" });
    });
  });
});
