/**
 * Tests for mcp-auth-flow.ts - OAuth flow using MCP SDK
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { existsSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"

// Set up isolated temp directory for tests
const TEST_DIR = join(tmpdir(), `mcp-oauth-test-${randomBytes(4).toString('hex')}`)
process.env.MCP_OAUTH_DIR = TEST_DIR

import {
  authenticate,
  startAuth,
  removeAuth,
  supportsOAuth,
  extractOAuthConfig,
  shutdownOAuth,
} from "./mcp-auth-flow.ts"
import { getAuthEntry, updateTokens } from "./mcp-auth.ts"
import type { ServerEntry } from "./types.ts"

describe("mcp-auth-flow", () => {
  before(() => {
    // Ensure clean state
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
      mkdirSync(TEST_DIR, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  after(async () => {
    // Shutdown OAuth and clean up
    await shutdownOAuth()
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }
  })

  describe("supportsOAuth", () => {
    it("should return true for OAuth HTTP server", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
      }
      assert.strictEqual(supportsOAuth(definition), true)
    })

    it("should return false for bearer auth", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "bearer",
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return false for implicit OAuth when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        headers: { "X-Goog-Api-Key": "api-key" },
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return true for explicit OAuth even when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        headers: { "X-Tenant": "tenant-id" },
      }
      assert.strictEqual(supportsOAuth(definition), true)
    })

    it("should return false for stdio server", () => {
      const definition: ServerEntry = {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return false when no URL", () => {
      const definition: ServerEntry = {}
      assert.strictEqual(supportsOAuth(definition), false)
    })
  })

  describe("removeAuth", () => {
    it("should remove all credentials", async () => {
      await updateTokens("remove-test", { accessToken: "token" })

      await removeAuth("remove-test")

      assert.strictEqual(getAuthEntry("remove-test"), undefined)
    })
  })

  describe("authenticate / completeAuth", () => {
    it("should throw if no server URL provided", async () => {
      await assert.rejects(
        async () => await authenticate("no-url-test", ""),
        /Invalid URL/
      )
    })

    it("should reject malformed OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("bad-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "not a url" },
        }),
        /Invalid OAuth redirectUri/
      )
    })

    it("should reject non-local OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("remote-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "https://example.com:3118/callback" },
        }),
        /localhost or loopback/
      )
    })

    it("should reject OAuth redirectUri values without an explicit port", async () => {
      await assert.rejects(
        async () => await startAuth("no-port-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://localhost/callback" },
        }),
        /explicit numeric port/
      )
    })

    it("should reject blank OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("blank-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "  " },
        }),
        /redirectUri must not be empty/
      )
    })

    it("should reject non-string OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("typed-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: 3118 as unknown as string },
        }),
        /redirectUri must be a string/
      )
    })

    it("should reject OAuth redirectUri values with fragments", async () => {
      await assert.rejects(
        async () => await startAuth("fragment-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://localhost:3118/callback#fragment" },
        }),
        /redirectUri must not include a fragment/
      )
    })

    it("should reject OAuth redirectUri values with username or password", async () => {
      await assert.rejects(
        async () => await startAuth("credential-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://user:pass@localhost:3118/callback" },
        }),
        /redirectUri must not include username or password/
      )
    })

    it("should reject non-string OAuth clientName and clientUri values", () => {
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { clientName: 123 as unknown as string },
        }),
        /clientName must be a string/
      )
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { clientUri: 123 as unknown as string },
        }),
        /clientUri must be a string/
      )
    })

    it("should reject malformed OAuth authorizationParams", () => {
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { authorizationParams: [] as unknown as Record<string, string> },
        }),
        /authorizationParams must be an object/
      )
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { authorizationParams: { prompt: 123 as unknown as string } },
        }),
        /authorizationParams\.prompt must be a string/
      )
    })

    it("should trim OAuth redirectUri and client metadata values", () => {
      const config = extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: {
          redirectUri: "  http://localhost:3118/callback  ",
          clientName: "  Custom MCP  ",
          clientUri: "  https://example.com/custom  ",
        },
      })

      assert.strictEqual(config.redirectUri, "http://localhost:3118/callback")
      assert.strictEqual(config.clientName, "Custom MCP")
      assert.strictEqual(config.clientUri, "https://example.com/custom")
    })
  })
})
