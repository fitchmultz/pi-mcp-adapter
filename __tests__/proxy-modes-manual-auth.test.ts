import assert from "node:assert/strict";
import { createTestState } from "./test-state.ts";
import { firstText, proxyRuntimeConnection } from "./fixtures/proxy-runtime.ts";
import type * as Auth from "../mcp-auth-flow.ts";
import type * as Init from "../init.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeAuthFromInput: vi.fn<typeof Auth.completeAuthFromInput>(),
  startAuth: vi.fn<typeof Auth.startAuth>(),
  supportsOAuth: vi.fn<typeof Auth.supportsOAuth>(),
  lazyConnect: vi.fn<typeof Init.lazyConnect>(),
  updateServerMetadata: vi.fn<typeof Init.updateServerMetadata>(),
  updateMetadataCache: vi.fn<typeof Init.updateMetadataCache>(),
  markKeepAliveAfterConnect: vi.fn<typeof Init.markKeepAliveAfterConnect>(),
  getFailureAgeSeconds: vi.fn<typeof Init.getFailureAgeSeconds>(),
  updateStatusBar: vi.fn<typeof Init.updateStatusBar>(),
  clearFailure: vi.fn<typeof Init.clearFailure>(),
}));

vi.mock("../mcp-auth-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Auth>()),
  authenticate: vi.fn<typeof Auth.authenticate>(),
  completeAuthFromInput: mocks.completeAuthFromInput,
  startAuth: mocks.startAuth,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  markKeepAliveAfterConnect: mocks.markKeepAliveAfterConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
  clearFailure: mocks.clearFailure,
}));

async function createState() {
  const state = createTestState({
    config: {
      settings: {},
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        bearer: { url: "https://api.example.com/mcp", auth: "bearer" },
      },
    },
    failureTracker: new Map([["demo", Date.now()]]),
    failureMessages: new Map([["demo", "stale failure"]]),
  });
  const definition = state.config.mcpServers.demo;
  assert.ok(definition);
  const connection = await proxyRuntimeConnection(definition);
  const getConnection = vi.spyOn(state.manager, "getConnection").mockReturnValue(connection);
  const retire = vi.spyOn(state.manager, "retire").mockImplementation(() => {
    /* Observe retirement of the captured connection. */
  });
  const close = vi.spyOn(state.manager, "close");
  return { state, getConnection, retire, close };
}

describe("manual OAuth proxy actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.resetModules();
    mocks.completeAuthFromInput.mockReset().mockResolvedValue("authenticated");
    mocks.startAuth.mockReset().mockResolvedValue({
      authorizationUrl:
        "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A19876%2Fcallback",
    });
    mocks.supportsOAuth.mockReset().mockImplementation((definition) => definition.auth === "oauth");
    mocks.updateStatusBar.mockReset();
    mocks.clearFailure.mockReset().mockImplementation((state, serverName) => {
      state.failureTracker.delete(serverName);
      state.failureMessages.delete(serverName);
    });
  });

  it("returns copyable instructions and authorization URL", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const { state } = await createState();

    const result = await executeAuthStart(state, "demo");

    expect(mocks.startAuth).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      {
        authStorageOptions: state.authStorageOptions,
        runtime: state.oauthRuntime,
        signal: state.owner.signal,
      },
    );
    expect(firstText(result)).toContain("Open this URL in your local browser");
    expect(firstText(result)).toContain("https://auth.example.com/authorize");
    expect(firstText(result)).toContain('mcp({ action: "auth-complete", server: "demo" })');
    expect(firstText(result)).toContain('args: { redirectUrl: "PASTE_REDIRECT_URL_HERE" }');
    expect(firstText(result)).toContain('args: { code: "PASTE_CODE_HERE" }');
    expect(result.details).toMatchObject({ mode: "auth-start", server: "demo" });
  });

  it("rejects auth-start for non-OAuth servers", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");

    const result = await executeAuthStart((await createState()).state, "bearer");

    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(firstText(result)).toContain("not configured for OAuth");
    expect(result.details).toMatchObject({ error: "oauth_not_supported" });
  });

  it("completes auth from a copied redirect URL and retires the captured connection", async () => {
    const { executeAuthComplete } = await import("../proxy-modes.ts");
    const { state, getConnection, retire, close } = await createState();

    const result = await executeAuthComplete(
      state,
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
    );

    expect(mocks.completeAuthFromInput).toHaveBeenCalledWith(
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
      {
        authStorageOptions: state.authStorageOptions,
        runtime: state.oauthRuntime,
        signal: state.owner.signal,
      },
    );
    expect(retire).toHaveBeenCalledWith("demo", getConnection.mock.results[0]?.value);
    expect(close).not.toHaveBeenCalled();
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
    expect(firstText(result)).toContain("OAuth authentication successful");
  });
});
