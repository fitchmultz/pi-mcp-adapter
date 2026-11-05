import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  InsufficientScopeError,
  validateAuthorizationResponseIssuer,
} from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureCallbackServer, waitForCallback } from "../mcp-callback-server.ts";
import * as callbackServer from "../mcp-callback-server.ts";
import * as authStorage from "../mcp-auth.ts";
import { openMcpAuthPanel } from "../commands.ts";
import { createMcpAdapter } from "../index.ts";
import { runMcpScript } from "../mcp-code.ts";
import {
  startAuth,
  completeAuthFromInput,
  authenticate,
  hasPendingAuth,
  shutdownOAuth,
  getOAuthRequest,
  removeAuth,
} from "../mcp-auth-flow.ts";
import { getAuthBaseDir, updateTokens } from "../mcp-auth.ts";
import { McpServerManager } from "../server-manager.ts";
import { McpOAuthProvider, getOAuthCallbackPort } from "../mcp-oauth-provider.ts";
import { executeAuthStart, executeAuthComplete } from "../proxy-modes.ts";
import type { ServerEntry } from "../types.ts";
import { createLifecycleHost, requireValue } from "./fixtures/extension-lifecycle.ts";
import { createPanelHost } from "./fixtures/panel-host.ts";
import {
  createOAuthRecoveryFixture,
  content,
  scopes,
  settled,
  resultText,
  denialCallback,
  type RecoveryEra,
} from "./fixtures/oauth-recovery.ts";

const browser = vi.hoisted(() => ({ open: vi.fn<(_url: string) => Promise<void>>() }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => {
  initTheme();
});
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup();
  }
  cleanups.length = 0;
  vi.restoreAllMocks();
  browser.open.mockReset().mockResolvedValue();
});
browser.open.mockResolvedValue();

async function fixture(era: RecoveryEra = "legacy", name = `recovery-${crypto.randomUUID()}`) {
  const f = await createOAuthRecoveryFixture(era, name);
  cleanups.push(f.dispose);
  return {
    ...f,
    signIn: () =>
      browser.open.mockImplementation(async (url: string) => {
        const response = await fetch(await f.authorize(url));
        expect(response.status).toBe(200);
      }),
  };
}

const invalidCallbacks = [
  "wrong-state",
  "missing-state",
  "wrong-issuer",
  "missing-issuer",
  "trailing-slash",
  "unexpected-issuer",
] as const;

function invalidErrorCallback(
  authorizationUrl: string,
  origin: string,
  invalid: (typeof invalidCallbacks)[number],
): URL {
  const callback = denialCallback(authorizationUrl, origin, "UNTRUSTED_ERROR_MARKER");
  switch (invalid) {
    case "wrong-state":
      callback.searchParams.set("state", "wrong");
      break;
    case "missing-state":
      callback.searchParams.delete("state");
      break;
    case "missing-issuer":
      callback.searchParams.delete("iss");
      break;
    case "wrong-issuer":
    case "unexpected-issuer":
      callback.searchParams.set("iss", "http://wrong.invalid/UNTRUSTED_ISSUER");
      break;
    case "trailing-slash":
      callback.searchParams.set("iss", `${origin}/`);
      break;
  }
  return callback;
}

async function startAcceptedEffect() {
  const f = await fixture();
  f.definition.auth = "oauth";
  f.seed("basic");
  f.controls.holdEffect = true;
  f.signIn();
  f.settings.autoAuth = true;
  f.state.ui = f.ui;
  const nativeFetch = globalThis.fetch;
  const accepted = new Promise<void>((resolve) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await nativeFetch(...args);
      if (response.headers.has("x-accepted-effect")) {
        resolve();
      }
      return response;
    });
  });
  const old = await f.connect();
  const close = vi.spyOn(old.client, "close");
  const effect = f.call("effect");
  await accepted;
  return { f, old, close, effect };
}

async function openAuthPanel(f: Awaited<ReturnType<typeof fixture>>, input: string) {
  const old = f.manager.getConnection(f.name);
  const host = await createPanelHost();
  cleanups.push(host.dispose);
  const flow = openMcpAuthPanel(f.state, host.context);
  await expect.poll(host.component).toBeDefined();
  host.input(input);
  await expect.poll(() => f.manager.getConnection(f.name)).not.toBe(old);
  await expect.poll(() => f.manager.getConnection(f.name)?.status).toBe("connected");
  return { host, flow };
}

async function collidingAuthBindings(kind: "pending" | "single-flight") {
  const a = await fixture("legacy", "a");
  const b = await fixture("legacy", kind === "pending" ? "a|/b" : `a|${a.definition.url}|/b`);
  const storageA = { baseDir: kind === "pending" ? "/b|/c" : `/b|${a.definition.url}|/c` };
  const storageB = { baseDir: "/c" };
  a.manager.setAuthStorageOptions(storageA);
  b.manager.setAuthStorageOptions(storageB);
  b.manager.setOAuthRuntime(a.runtime);
  b.definition.url = a.definition.url;
  for (const f of [a, b]) {
    f.definition.auth = "oauth";
    updateTokens(
      f.name,
      { accessToken: "basic-token", scope: "basic", issuer: a.origin },
      a.definition.url,
    );
    const connection = await f.connect();
    await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(
      InsufficientScopeError,
    );
    a.controls.requiredScope = "admin";
  }
  return { a, b, storageA, storageB };
}

describe("OAuth permission recovery through native HTTP and production hosts", () => {
  it("retains ordered errors and the cleanup cause when callback binding and startup cleanup fail", async () => {
    const f = await fixture();
    const occupied = createServer();
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          occupied.close(() => resolve());
        }),
    );
    const address = occupied.address();
    assert(address !== null && typeof address !== "string");
    f.definition.oauth = { redirectUri: `http://127.0.0.1:${address.port}/callback` };
    const binding = vi.spyOn(callbackServer, "ensureCallbackServer");
    const cleanup = new Error("state cleanup unavailable");
    vi.spyOn(authStorage, "clearOAuthState").mockImplementationOnce(() => {
      throw cleanup;
    });

    const outcome = await settled(f.start());
    assert(outcome.status === "rejected" && outcome.reason instanceof AggregateError);
    const recorded = binding.mock.settledResults[0];
    assert(recorded?.type === "rejected" && recorded.value instanceof Error);
    expect(recorded.value).toHaveProperty("cause.code", "EADDRINUSE");
    expect(outcome.reason.message).toBe("OAuth startup cleanup failed");
    expect(outcome.reason.errors).toEqual([recorded.value, cleanup]);
    expect(outcome.reason.errors[0]).toBe(recorded.value);
    expect(outcome.reason.errors[1]).toBe(cleanup);
    expect(outcome.reason.cause).toBe(cleanup);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.exchanges).toHaveLength(0);
  });

  it("retains ordered errors and the cleanup cause when native client lookup and startup cleanup fail", async () => {
    const f = await fixture();
    const primary = new Error("client credentials unavailable");
    const cleanup = new Error("state cleanup unavailable");
    vi.spyOn(McpOAuthProvider.prototype, "clientInformation").mockRejectedValueOnce(primary);
    vi.spyOn(authStorage, "getOAuthState").mockImplementationOnce(() => {
      throw cleanup;
    });

    const outcome = await settled(f.start());
    assert(outcome.status === "rejected" && outcome.reason instanceof AggregateError);
    expect(outcome.reason.message).toBe("OAuth startup cleanup failed");
    expect(outcome.reason.errors).toEqual([primary, cleanup]);
    expect(outcome.reason.errors[0]).toBe(primary);
    expect(outcome.reason.errors[1]).toBe(cleanup);
    expect(outcome.reason.cause).toBe(cleanup);
    expect(f.http.some((request) => request.path.startsWith("/.well-known/"))).toBe(true);
    expect(f.exchanges).toHaveLength(0);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
  });

  it("retains ordered errors and the cleanup cause when token persistence and completion cleanup fail", async () => {
    const f = await fixture();
    const { authorizationUrl } = await f.start();
    const callback = await f.authorize(authorizationUrl);
    const primary = new Error("token persistence unavailable");
    const cleanup = new Error("state cleanup unavailable");
    vi.spyOn(McpOAuthProvider.prototype, "saveTokens").mockRejectedValueOnce(primary);
    vi.spyOn(authStorage, "getOAuthState").mockImplementationOnce(() => {
      throw cleanup;
    });

    const outcome = await settled(completeAuthFromInput(f.name, callback, { runtime: f.runtime }));
    assert(outcome.status === "rejected" && outcome.reason instanceof AggregateError);
    expect(outcome.reason.message).toBe("OAuth completion cleanup failed");
    expect(outcome.reason.errors).toEqual([primary, cleanup]);
    expect(outcome.reason.errors[0]).toBe(primary);
    expect(outcome.reason.errors[1]).toBe(cleanup);
    expect(outcome.reason.cause).toBe(cleanup);
    expect(f.exchanges).toHaveLength(1);
    expect(f.stored()?.tokens).toBeUndefined();
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect((await fetch(callback)).status).toBe(400);
  });

  it("retains ordered errors and the cleanup cause when cancellation and callback cleanup fail", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const primary = new Error("consent cancelled");
    const cleanup = new Error("state cleanup unavailable");
    const outcome = await settled(
      authenticate(f.name, f.definition.url, f.definition, {
        runtime: f.runtime,
        signal: controller.signal,
        onAuthorizationUrl: () => {
          vi.spyOn(authStorage, "getOAuthState").mockImplementationOnce(() => {
            throw cleanup;
          });
          controller.abort(primary);
        },
      }),
    );

    assert(outcome.status === "rejected" && outcome.reason instanceof AggregateError);
    expect(outcome.reason.message).toBe("OAuth cancellation cleanup failed");
    expect(outcome.reason.errors).toEqual([primary, cleanup]);
    expect(outcome.reason.errors[0]).toBe(primary);
    expect(outcome.reason.errors[1]).toBe(cleanup);
    expect(outcome.reason.cause).toBe(cleanup);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.exchanges).toHaveLength(0);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each(["tools/list", "prompts/list", "resources/list"])(
    "activates implicit OAuth for protected %s",
    async (method) => {
      const f = await fixture();
      f.controls.protectedMethod = method;
      expect((await f.connect()).status).toBe("needs-auth");
      await f.manual();
      await f.manager.close(f.name);
      expect((await f.connect()).status).toBe("connected");
      expect(f.exchanges).toHaveLength(1);
    },
  );

  it("uses a saved token after wholly public bootstrap and a first protected tool", async () => {
    const f = await fixture();
    f.seed("basic write");
    expect((await f.connect()).status).toBe("connected");
    expect((await f.call()).details.error).toBeUndefined();
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(2);
    expect(f.exchanges).toHaveLength(0);
  });

  it.each([false, true])(
    "carries a configured basic grant into manual write consent (refresh=%s)",
    async (refresh) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.definition.oauth = { scope: "basic" };
      f.seed("basic", refresh);
      await f.connect();
      expect((await f.call()).details.error).toBe("auth_required");
      const url = await f.manual();
      expect(scopes(new URL(url).searchParams.get("scope"))).toEqual(["basic", "write"]);
      expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual(["basic", "write"]);
      expect(requireValue(f.exchanges[0]).get("grant_type")).toBe("authorization_code");
      expect(f.stored()?.tokens?.scope).toBe("basic write");
      expect((await f.call()).details.error).toBeUndefined();
    },
  );

  it("validates issuer before provider error on the authenticate callback path", async () => {
    const f = await fixture();
    const marker = "UNTRUSTED_CALLBACK_MARKER";
    browser.open.mockImplementation(async (url: string) => {
      const response = await fetch(denialCallback(url, "http://wrong.invalid", marker));
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(marker);
    });
    const outcome = await settled(
      authenticate(f.name, f.definition.url, f.definition, { runtime: f.runtime }),
    );
    expect(outcome).toHaveProperty("status", "rejected");
    expect(outcome).toHaveProperty("reason.message", expect.not.stringContaining(marker));
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.exchanges).toHaveLength(0);
  });

  it("validates issuer before provider error on the manual callback path", async () => {
    const f = await fixture();
    const marker = "UNTRUSTED_CALLBACK_MARKER";
    const { authorizationUrl } = await f.start();
    const outcome = await settled(
      completeAuthFromInput(
        f.name,
        denialCallback(authorizationUrl, "http://wrong.invalid", marker).href,
        { runtime: f.runtime },
      ),
    );
    expect(outcome).toHaveProperty("status", "rejected");
    expect(outcome).toHaveProperty("reason.message", expect.not.stringContaining(marker));
    expect(f.exchanges).toHaveLength(0);
  });

  it("validates issuer before provider error on the HTTP callback path", async () => {
    const f = await fixture();
    const marker = "UNTRUSTED_CALLBACK_MARKER";
    const { authorizationUrl } = await f.start();
    const response = await fetch(denialCallback(authorizationUrl, "http://wrong.invalid", marker));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(marker);
    expect(f.exchanges).toHaveLength(0);
  });

  for (const era of ["legacy", "modern"] as const) {
    for (const host of ["proxy", "direct", "script"] as const) {
      it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ])(`${era} ${host} warm scope policy autoAuth=%s UI=%s`, async (autoAuth, ui) => {
        const f = await fixture(era);
        f.definition.auth = "oauth";
        f.seed("basic");
        f.signIn();
        f.settings.autoAuth = autoAuth;
        if (ui) {
          f.state.ui = f.ui;
        }
        await f.connect();
        const result = await f.callHost(host);
        const eligible = autoAuth && ui;
        expect(result).toMatchObject(
          eligible
            ? { ok: true, data: content("write") }
            : { ok: false, error: { code: "auth_required" } },
        );
        expect(browser.open).toHaveBeenCalledTimes(eligible ? 1 : 0);
        expect(f.authorizations).toHaveLength(eligible ? 1 : 0);
        expect(f.exchanges).toHaveLength(eligible ? 1 : 0);
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(eligible ? 2 : 1);
        expect(f.authorizations.map((url) => scopes(url.searchParams.get("scope")))).toEqual(
          eligible ? [["basic", "write"]] : [],
        );
      });
    }
    it.each([401, 403])(
      `${era} first protected tool %s activates once with stored tokens and survives replacement`,
      async (status) => {
        const f = await fixture(era);
        f.controls.challengeStatus = status;
        f.seed("basic write");
        await f.connect();
        expect((await f.call()).details.error).toBeUndefined();
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(2);
        const old = requireValue(f.manager.getConnection(f.name));
        await f.manager.reconnect(f.name, f.definition, old);
        expect((await f.call()).details.error).toBeUndefined();
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
        expect(f.authorizations).toHaveLength(0);
        expect(f.exchanges).toHaveLength(0);
      },
    );
    it(`${era} first protected tool 403 activates then permits only one auth flow`, async () => {
      const f = await fixture(era);
      f.controls.challengeStatus = 403;
      f.signIn();
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      expect((await f.call()).details.error).toBeUndefined();
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
      expect(f.exchanges).toHaveLength(1);
    });

    it(`${era} first protected tool 401 requires a later invocation for write consent`, async () => {
      const f = await fixture(era);
      f.controls.challengeStatus = 401;
      f.signIn();
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      expect((await f.call()).details.error).toBe("auth_required");
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
      expect(f.exchanges).toHaveLength(1);
      expect(f.request()?.challenge?.requiredScope).toBe("write");
      expect((await f.call()).details.error).toBeUndefined();
      expect(browser.open).toHaveBeenCalledTimes(2);
    });
  }

  it("does not turn a warm refresh fetch failure into automatic consent or tool replay", async () => {
    const f = await fixture("modern");
    f.definition.auth = "oauth";
    f.definition.retryOnTransportFailure = true;
    f.seed("basic", true);
    f.controls.tokenFailure = true;
    f.controls.toolStatuses = [401];
    f.signIn();
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    await f.connect();
    expect((await f.call()).details.error).toBe("call_failed");
    expect(browser.open).not.toHaveBeenCalled();
    expect(f.authorizations).toHaveLength(0);
    expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
  });

  it("rejects an unverifiable manual error without metadata", async () => {
    const f = await fixture();
    f.controls.metadataAbsent = true;
    const { authorizationUrl } = await f.start();
    const callback = denialCallback(authorizationUrl, f.origin, "UNVERIFIABLE_MARKER");
    await expect(
      completeAuthFromInput(f.name, callback.href, { runtime: f.runtime }),
    ).rejects.toThrow("Cannot verify");
  });

  it("rejects an unverifiable HTTP error without metadata but keeps code fallback", async () => {
    const f = await fixture();
    f.controls.metadataAbsent = true;
    const { authorizationUrl } = await f.start();
    const response = await fetch(denialCallback(authorizationUrl, f.origin, "UNVERIFIABLE_MARKER"));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("UNVERIFIABLE_MARKER");
    const codeCallback = await f.authorize(authorizationUrl);
    expect(await completeAuthFromInput(f.name, codeCallback, { runtime: f.runtime })).toBe(
      "authenticated",
    );
  });

  it.each([
    "tools/call",
    "prompts/get",
    "resources/read",
    "tools/list",
    "prompts/list",
    "resources/list",
  ])("captures native %s before formatting without changing stored tokens", async (method) => {
    const f = await fixture("modern");
    f.definition.auth = "oauth";
    f.seed("basic");
    const dir = await mkdtemp(join(tmpdir(), "oauth-trace-"));
    cleanups.unshift(() => rm(dir, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(dir, "trace.jsonl") });
    const connection = await f.connect();
    const before = f.stored();
    f.controls.protectedMethod = method;
    f.controls.protectScope = true;
    const operations: Record<string, () => Promise<unknown>> = {
      "prompts/get": () => f.manager.getPrompt(f.name, "prompt"),
      "resources/read": () => f.manager.readResource(f.name, "test://document"),
      "tools/list": () => connection.client.listTools(undefined, { cacheMode: "refresh" }),
      "prompts/list": () => connection.client.listPrompts(undefined, { cacheMode: "refresh" }),
      "resources/list": () => connection.client.listResources(undefined, { cacheMode: "refresh" }),
      "tools/call": () => connection.client.callTool({ name: "write" }),
    };
    await expect(requireValue(operations[method])()).rejects.toBeInstanceOf(InsufficientScopeError);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    expect(f.stored()).toEqual(before);
    expect(browser.open).not.toHaveBeenCalled();
    const { authorizationUrl } = await f.start();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic", "write"]);
  });

  it.each(["tools", "prompts", "resources"])(
    "retains %s list-change challenges from the native refresh",
    async (catalog) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.controls.notifications = true;
      f.seed("basic");
      await f.connect();
      await expect.poll(() => f.controls.stream).toBeDefined();
      f.controls.protectedMethod = `${catalog}/list`;
      f.controls.protectScope = true;
      requireValue(f.controls.stream).write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/${catalog}/list_changed` })}\n\n`,
      );
      await expect.poll(() => f.request()?.challenge?.requiredScope).toBe("write");
      expect(f.requests.filter((r) => r.method === `${catalog}/list`)).toHaveLength(2);
      expect(browser.open).not.toHaveBeenCalled();
    },
  );

  it("captures modern pre-Protocol discovery scope and never reads credentials for a public bootstrap", async () => {
    const f = await fixture("modern");
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try {
      expect((await f.connect()).status).toBe("connected");
    } finally {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    }
    expect(f.request()).toBeUndefined();
    await f.manager.close(f.name);
    f.controls.protectedMethod = "server/discover";
    f.controls.challengeStatus = 403;
    expect((await f.connect()).status).toBe("needs-auth");
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    const { authorizationUrl } = await f.start();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toContain("write");
  });

  it.each([
    { auth: false },
    { oauth: false },
    { auth: "bearer", bearerToken: "header-token" },
    { headers: { Authorization: "Bearer header-token" } },
    { disabled: true },
  ] satisfies ServerEntry[])("does not recover OAuth for excluded mode %j", async (options) => {
    const f = await fixture();
    Object.assign(f.definition, options);
    f.controls.challengeStatus = 403;
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    if (!options.disabled) {
      await f.connect();
    }
    expect((await f.call()).details.error).toBe(
      options.disabled ? "server_disabled" : "call_failed",
    );
    expect(f.request()).toBeUndefined();
    expect(browser.open).not.toHaveBeenCalled();
    expect(f.exchanges).toHaveLength(0);
  });

  it("keeps explicit OAuth with custom headers eligible but ordinary forbidden errors terminal", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.definition.headers = { "X-Test": "yes" };
    f.seed("basic");
    f.signIn();
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    await f.connect();
    f.controls.genericForbidden = true;
    expect((await f.call()).details.error).toBe("call_failed");
    expect(f.request()).toBeUndefined();
    f.controls.genericForbidden = false;
    expect((await f.call()).details.error).toBeUndefined();
    expect(browser.open).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps native M2M step-up and retry exhaustion (implicit=%s)",
    async (implicit) => {
      const f = await fixture("modern");
      if (!implicit) {
        f.definition.auth = "oauth";
      }
      f.definition.oauth = {
        grantType: "client_credentials",
        clientId: "machine",
        clientSecret: "secret",
      };
      f.seed("basic");
      f.settings.autoAuth = true;
      await f.connect();
      expect((await f.call()).details.error).toBeUndefined();
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(implicit ? 3 : 2);
      expect(f.exchanges.map((p) => p.get("grant_type"))).toEqual(["client_credentials"]);
      expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual(["basic", "write"]);
      f.controls.toolStatuses = [403, 403, 403];
      expect((await f.call()).details.error).toBe("call_failed");
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(implicit ? 5 : 4);
      expect(f.exchanges).toHaveLength(2);
      expect(browser.open).not.toHaveBeenCalled();
    },
  );

  it("keeps exhausted native interactive 401 terminal with autoAuth enabled", async () => {
    const f = await fixture("modern");
    f.definition.auth = "oauth";
    f.seed("basic", true);
    f.controls.toolStatuses = [401, 401];
    f.signIn();
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    await f.connect();
    expect((await f.call()).details.error).toBe("call_failed");
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(2);
    expect(f.exchanges).toHaveLength(1);
    expect(requireValue(f.exchanges[0]).get("grant_type")).toBe("refresh_token");
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each([null, "basic"])(
    "keeps a %s issued scope truthful and limits each later invocation",
    async (grant) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.definition.oauth = { scope: "basic" };
      f.seed("basic");
      f.controls.issuedScope = grant;
      f.signIn();
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      for (let invocation = 1; invocation <= 2; invocation++) {
        expect((await f.call()).details.error).toBe("auth_required");
        expect(browser.open).toHaveBeenCalledTimes(invocation);
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(invocation * 2);
        expect(f.exchanges).toHaveLength(invocation);
        expect(f.stored()?.tokens?.scope).toBe(grant ?? undefined);
        expect(f.request()?.challenge?.requiredScope).toBe("write");
      }
    },
  );

  it.each([undefined, "basic"])(
    "bounds a missing/same required scope (%s) without fabricated grants",
    async (required) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.definition.oauth = { scope: "basic" };
      f.seed("basic", true);
      f.controls.requiredScope = required;
      f.controls.toolStatuses = [403, 403];
      f.signIn();
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      expect((await f.call()).details.error).toBe("auth_required");
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(2);
      expect(f.exchanges).toHaveLength(1);
      expect(requireValue(f.exchanges[0]).get("grant_type")).toBe("refresh_token");
      expect(browser.open).not.toHaveBeenCalled();
      expect(f.stored()?.tokens?.scope).toBe("basic");
    },
  );

  for (const era of ["legacy", "modern"] as const) {
    it.each([403, 401, 404, 503, 0])(
      `${era} post-auth %s is terminal without stacking transport/session retries`,
      async (second) => {
        const f = await fixture(era);
        f.definition.auth = "oauth";
        f.definition.retryOnTransportFailure = true;
        f.seed("basic");
        f.controls.toolStatuses = [403, second];
        f.signIn();
        f.settings.autoAuth = true;
        f.state.ui = f.ui;
        await f.connect();
        const errors: Record<number, string> = {
          403: "auth_required",
          401: "call_failed",
          404: "call_failed",
          503: "ambiguous_outcome",
          0: era === "modern" ? "ambiguous_outcome" : "call_failed",
        };
        expect((await f.call()).details.error).toBe(errors[second]);
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(2);
        expect(browser.open).toHaveBeenCalledTimes(1);
        expect(f.exchanges).toHaveLength(1);
      },
    );
    it(`${era} transport/session recovery never replays an unknown write or restarts auth`, async () => {
      const f = await fixture(era);
      f.definition.auth = "oauth";
      f.definition.retryOnTransportFailure = true;
      f.seed("basic");
      f.controls.toolStatuses = [era === "legacy" ? 404 : 503, 403];
      f.signIn();
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      expect((await f.call()).details.error).toBe(
        era === "legacy" ? "auth_required" : "ambiguous_outcome",
      );
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(
        era === "legacy" ? 2 : 1,
      );
      expect(browser.open).not.toHaveBeenCalled();
      const request = f.request();
      expect(request === undefined).toBe(era === "modern");
      expect(request?.challenge?.requiredScope).toBe(era === "legacy" ? "write" : undefined);
    });
  }

  it("forces consent when the stored basic token omits scope without changing it on observation", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.definition.oauth = { scope: "basic" };
    f.seed(undefined, true);
    await f.connect();
    const before = f.stored();
    expect((await f.call()).details.error).toBe("auth_required");
    expect(f.stored()).toEqual(before);
    const url = await f.manual();
    expect(scopes(new URL(url).searchParams.get("scope"))).toEqual(["basic", "write"]);
    expect(requireValue(f.exchanges[0]).get("grant_type")).toBe("authorization_code");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it.each(["runtime", "url", "storage"])(
    "does not share permission intent across a different %s binding",
    async (binding) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.definition.oauth = { scope: "basic" };
      f.seed("basic");
      await f.connect();
      await f.call();
      const other = await fixture();
      const runtime = binding === "runtime" ? other.runtime : f.runtime;
      const url = binding === "url" ? other.definition.url : f.definition.url;
      const authStorageOptions =
        binding === "storage" ? { baseDir: join(tmpdir(), crypto.randomUUID()) } : {};
      expect(
        getOAuthRequest(f.name, url, getAuthBaseDir(authStorageOptions), runtime),
      ).toBeUndefined();
      const { authorizationUrl } = await startAuth(
        f.name,
        url,
        { ...f.definition, url },
        { runtime, authStorageOptions },
      );
      expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic"]);
      expect(f.request()?.challenge?.requiredScope).toBe("write");
    },
  );

  it.each(["pending", "single-flight"] as const)(
    "isolates authorization ownership when delimiter-joined %s keys collide",
    async (kind) => {
      const { a, b, storageA, storageB } = await collidingAuthBindings(kind);
      const optionsA = { runtime: a.runtime, authStorageOptions: storageA };
      const optionsB = { runtime: a.runtime, authStorageOptions: storageB };
      const urls = new Map<string, string>();
      const controller = new AbortController();
      const outcomes: Array<ReturnType<typeof settled>> = [];
      const manualCompletions: string[] = [];
      const callbackStatuses: number[] = [];
      let secondPending: boolean | undefined;
      try {
        if (kind === "pending") {
          urls.set(
            a.name,
            (await startAuth(a.name, a.definition.url, a.definition, optionsA)).authorizationUrl,
          );
          urls.set(
            b.name,
            (await startAuth(b.name, b.definition.url, b.definition, optionsB)).authorizationUrl,
          );
        } else {
          outcomes.push(
            settled(
              authenticate(a.name, a.definition.url, a.definition, {
                ...optionsA,
                signal: controller.signal,
                onAuthorizationUrl: (url) => {
                  urls.set(a.name, url);
                },
              }),
            ),
          );
          outcomes.push(
            settled(
              authenticate(b.name, b.definition.url, b.definition, {
                ...optionsB,
                signal: controller.signal,
                onAuthorizationUrl: (url) => {
                  urls.set(b.name, url);
                },
              }),
            ),
          );
        }
        await expect.poll(() => urls.size).toBe(2);
        const first = new URL(requireValue(urls.get(a.name)));
        const second = new URL(requireValue(urls.get(b.name)));
        expect(second.href).not.toBe(first.href);
        expect(scopes(first.searchParams.get("scope"))).toEqual(["basic", "write"]);
        expect(scopes(second.searchParams.get("scope"))).toEqual(["admin", "basic"]);
        expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"));
        expect(second.searchParams.get("code_challenge")).not.toBe(
          first.searchParams.get("code_challenge"),
        );
        const callbackA = await a.authorize(first.href);
        const callbackB = await a.authorize(second.href);
        if (kind === "pending") {
          manualCompletions.push(await completeAuthFromInput(a.name, callbackA, optionsA));
          secondPending = hasPendingAuth(b.name, storageB, a.runtime);
          manualCompletions.push(await completeAuthFromInput(b.name, callbackB, optionsB));
        } else {
          callbackStatuses.push((await fetch(callbackA)).status);
          callbackStatuses.push((await fetch(callbackB)).status);
        }
        expect(manualCompletions).toEqual(
          kind === "pending" ? ["authenticated", "authenticated"] : [],
        );
        expect(secondPending).toBe(kind === "pending" ? true : undefined);
        expect(callbackStatuses).toEqual(kind === "pending" ? [] : [200, 200]);
        expect(await Promise.all(outcomes)).toEqual(
          kind === "pending"
            ? []
            : [
                { status: "fulfilled", value: "authenticated" },
                { status: "fulfilled", value: "authenticated" },
              ],
        );
        expect(a.stored()?.tokens?.scope).toBe("basic write");
        expect(b.stored()?.tokens?.scope).toBe("basic admin");
        expect(b.stored()?.tokens?.accessToken).not.toBe(a.stored()?.tokens?.accessToken);
        expect(a.exchanges).toHaveLength(2);
        expect(requireValue(a.exchanges[0]).get("code_verifier")).not.toBe(
          requireValue(a.exchanges[1]).get("code_verifier"),
        );
        expect(hasPendingAuth(a.name, storageA, a.runtime)).toBe(false);
        expect(hasPendingAuth(b.name, storageB, a.runtime)).toBe(false);
      } finally {
        controller.abort(new Error("tuple test finished"));
        await Promise.all(outcomes);
      }
    },
  );

  it("retains only scope intent after cancellation and rejects a changed known issuer", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.seed("basic");
    await f.connect();
    await f.call();
    const controller = new AbortController();
    await expect(
      authenticate(f.name, f.definition.url, f.definition, {
        runtime: f.runtime,
        signal: controller.signal,
        onAuthorizationUrl: () => controller.abort(new Error("cancel consent")),
      }),
    ).rejects.toThrow("cancel consent");
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.request()?.issuer).toBe(f.origin);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    f.controls.issuerPath = "/changed";
    await expect(f.start()).rejects.toThrow("issuer changed");
    expect(f.exchanges).toHaveLength(0);
    expect(f.authorizations).toHaveLength(0);
    await removeAuth(f.name, { runtime: f.runtime });
    expect(f.request()).toBeUndefined();
  });

  it("does not poison native M2M recovery with a rejected discovery issuer", async () => {
    const f = await fixture("modern");
    f.definition.oauth = {
      grantType: "client_credentials",
      clientId: "machine",
      clientSecret: "secret",
    };
    f.seed("basic");
    await f.connect();
    expect(f.request()).toBeUndefined();
    const before = f.stored();
    f.controls.issuerPath = "/changed";
    expect((await f.call()).details.error).toBe("call_failed");
    expect(f.authorizations).toHaveLength(0);
    expect(f.exchanges).toHaveLength(0);
    expect(f.stored()).toEqual(before);
    expect(f.requests.filter((request) => request.method === "tools/call")).toHaveLength(2);
    f.controls.issuerPath = "";
    await f.manager.reconnect(f.name, f.definition, requireValue(f.manager.getConnection(f.name)));
    expect((await f.call()).details.error).toBeUndefined();
    expect(f.request()?.issuer).toBe(f.origin);
    expect(f.authorizations).toHaveLength(0);
    expect(browser.open).not.toHaveBeenCalled();
    expect(f.exchanges).toHaveLength(1);
    expect(requireValue(f.exchanges[0]).get("grant_type")).toBe("client_credentials");
    expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual(["basic", "write"]);
    expect(f.requests.filter((request) => request.method === "tools/call")).toHaveLength(4);
  });

  it("does not poison a fresh scope request with a rejected discovery issuer", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.seed("basic");
    await f.connect();
    expect((await f.call()).details.error).toBe("auth_required");
    expect(f.request()?.issuer).toBeUndefined();
    const before = f.stored();
    f.controls.issuerPath = "/changed";
    await expect(f.start()).rejects.toThrow("issuer changed");
    expect(f.authorizations).toHaveLength(0);
    expect(f.exchanges).toHaveLength(0);
    expect(f.stored()).toEqual(before);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    f.controls.issuerPath = "";
    const restarting = f.start();
    await expect(restarting).resolves.toHaveProperty("authorizationUrl", expect.any(String));
    const { authorizationUrl } = await restarting;
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual(["basic", "write"]);
    expect(f.request()?.issuer).toBe(f.origin);
    expect(f.stored()?.tokens).toEqual(before?.tokens);
    expect(f.authorizations).toHaveLength(0);
    expect(f.exchanges).toHaveLength(0);
    await f.manual();
    expect(f.authorizations).toHaveLength(1);
    expect(f.exchanges).toHaveLength(1);
    expect(f.stored()?.tokens?.scope).toBe("basic write");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it("keeps a pending URL and verifier immutable when a wider challenge arrives", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.definition.oauth = { scope: "basic" };
    f.seed("basic");
    await f.connect();
    await f.call();
    const first = await f.start();
    f.controls.requiredScope = "admin";
    await f.call();
    expect(await f.start()).toEqual(first);
    const callback = await f.authorize(first.authorizationUrl);
    expect(await completeAuthFromInput(f.name, callback, { runtime: f.runtime })).toBe(
      "authenticated",
    );
    expect(f.stored()?.tokens?.scope).toBe("basic write");
    expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual(["basic", "write"]);
    expect(scopes(f.request()?.challenge?.requiredScope)).toEqual(["admin", "write"]);
    expect((await f.call()).details.error).toBeUndefined();
    const next = await f.start();
    expect(scopes(new URL(next.authorizationUrl).searchParams.get("scope"))).toEqual([
      "admin",
      "basic",
      "write",
    ]);
    expect(new URL(next.authorizationUrl).searchParams.get("state")).not.toBe(
      new URL(first.authorizationUrl).searchParams.get("state"),
    );
    expect(new URL(next.authorizationUrl).searchParams.get("code_challenge")).not.toBe(
      new URL(first.authorizationUrl).searchParams.get("code_challenge"),
    );
  });

  it("shares one automatic flow and replacement between concurrent challenged callers", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.seed("basic");
    f.signIn();
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    await f.connect();
    const results = await Promise.all([f.call(), f.call()]);
    for (const result of results) {
      expect(result.details.error).toBeUndefined();
    }
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(4);
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(0);
  });

  it("does not give an initial-auth invocation another consent for its later scope challenge", async () => {
    const f = await fixture();
    f.controls.protectedMethod = "initialize";
    f.signIn();
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    expect((await f.connect()).status).toBe("needs-auth");
    expect((await f.call()).details.error).toBe("auth_required");
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
  });

  it.each(["discovery", "callback", "token"] as const)(
    "aborts scope authorization during %s without late token saves or dispatch",
    async (phase) => {
      const f = await fixture("modern");
      f.definition.auth = "oauth";
      f.seed("basic");
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      const before = f.stored();
      const saveTokens = vi.spyOn(McpOAuthProvider.prototype, "saveTokens");
      const controller = new AbortController();
      if (phase === "discovery") {
        f.controls.holdDiscovery = true;
      }
      if (phase === "token") {
        f.controls.holdToken = true;
        f.signIn();
      }
      const call = f.call("write", controller.signal);
      await expect
        .poll(
          () =>
            ({
              discovery: f.controls.discoveryHeld,
              callback: browser.open.mock.calls.length > 0,
              token: f.exchanges.length > 0,
            })[phase],
        )
        .toBe(true);
      controller.abort(new Error("caller cancelled"));
      expect((await call).details.error).toBe("aborted");
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
      f.controls.releaseToken();
      await expect.poll(() => saveTokens.mock.calls.length).toBe(phase === "token" ? 1 : 0);
      const saves = await Promise.allSettled(
        saveTokens.mock.results.map((result) => {
          assert(result.type === "return");
          return result.value;
        }),
      );
      for (const save of saves) {
        expect(save).toHaveProperty("status", "rejected");
        expect(save).toHaveProperty("reason", expect.any(Error));
        expect(save).toHaveProperty("reason.message", expect.stringContaining("no longer active"));
      }
      expect(f.stored()?.tokens).toEqual(before?.tokens);
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
      expect(f.request()?.challenge?.requiredScope).toBe("write");
    },
  );

  it.each(["abort", "deadline"])(
    "keeps auth-driven reconnect shared after one caller's %s",
    async (cancellation) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.seed("basic");
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      await f.connect();
      browser.open.mockImplementation(async (url: string) => {
        f.controls.holdCatalog = true;
        f.definition.requestTimeoutMs = 3000;
        await fetch(await f.authorize(url));
      });
      if (cancellation === "deadline") {
        f.definition.requestTimeoutMs = 300;
      }
      const controller = new AbortController();
      const first = f.call("write", controller.signal);
      await expect.poll(() => f.controls.catalogHeld).toBe(true);
      const second = f.call("effect");
      if (cancellation === "abort") {
        controller.abort(new Error("caller cancelled"));
      }
      expect((await first).details.error).toBe(
        cancellation === "abort" ? "aborted" : "call_failed",
      );
      f.controls.holdCatalog = false;
      f.controls.releaseCatalog();
      expect((await second).details.error).toBeUndefined();
      expect(f.requests.filter((r) => r.name === "write")).toHaveLength(1);
      expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
    },
  );

  it("script timeout cancels native callback waiting and its outstanding tool", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.seed("basic");
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    await f.connect();
    const result = await runMcpScript({
      state: f.state,
      code: `return await tools.call(${JSON.stringify(f.toolName("write"))}, {});`,
      timeoutMs: 300,
    });
    expect(result.details.error).toBe("timeout");
    await expect.poll(() => hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
    expect(f.exchanges).toHaveLength(0);
  });

  it("manual auth-start keeps its five-minute flow after the originating tool ends", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const result = await executeAuthStart(f.state, f.name, controller.signal);
    controller.abort(new Error("tool finished"));
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    const url = result.details.authorizationUrl;
    assert(typeof url === "string");
    const callback = await f.authorize(url);
    expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(true);
    expect(f.exchanges).toHaveLength(1);
  });

  it("completes a captured manual callback only on explicit auth-complete without exposing callback secrets", async () => {
    const f = await fixture();
    const started = await executeAuthStart(f.state, f.name);
    const authorizationUrl = started.details.authorizationUrl;
    assert(typeof authorizationUrl === "string");
    const early = await executeAuthComplete(f.state, f.name);
    expect(early.details.error).toBe("auth_complete_failed");
    expect(resultText(early)).toContain("No OAuth callback received yet");
    expect(resultText(early)).toContain("redirectUrl");
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    expect((await f.start()).authorizationUrl).toBe(authorizationUrl);

    const callback = new URL(await f.authorize(authorizationUrl));
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("auth-complete");
    expect(html).not.toContain(requireValue(callback.searchParams.get("code")));
    expect(f.exchanges).toHaveLength(0);
    expect(f.stored()?.tokens).toBeUndefined();

    const cancelled = new AbortController();
    cancelled.abort(new Error("completion cancelled"));
    await expect(executeAuthComplete(f.state, f.name, undefined, cancelled.signal)).rejects.toThrow(
      "completion cancelled",
    );
    const completed = await executeAuthComplete(f.state, f.name);
    expect(completed.details.authenticated).toBe(true);
    expect(f.exchanges).toHaveLength(1);
    expect(requireValue(f.exchanges[0]).get("code")).toBe(callback.searchParams.get("code"));
    expect(f.stored()?.tokens?.issuer).toBe(f.origin);
    for (const secret of [
      callback.href,
      requireValue(callback.searchParams.get("code")),
      requireValue(callback.searchParams.get("state")),
    ]) {
      expect(JSON.stringify(completed)).not.toContain(secret);
    }
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect((await executeAuthComplete(f.state, f.name)).details.error).toBe("auth_complete_failed");
    expect((await fetch(callback)).status).toBe(400);
    expect(f.exchanges).toHaveLength(1);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each(["state", "issuer", "missing-issuer", "code", "path"])(
    "does not capture a manual callback with invalid %s",
    async (invalid) => {
      const f = await fixture();
      const { authorizationUrl } = await f.start();
      const callback = new URL(await f.authorize(authorizationUrl));
      const bad = new URL(callback);
      if (invalid === "state") {
        bad.searchParams.set("state", "wrong-state");
      }
      if (invalid === "issuer") {
        bad.searchParams.set("iss", "https://wrong.invalid");
      }
      if (invalid === "missing-issuer") {
        bad.searchParams.delete("iss");
      }
      if (invalid === "code") {
        bad.searchParams.delete("code");
      }
      if (invalid === "path") {
        bad.pathname = "/wrong";
      }
      expect((await fetch(bad)).status).toBe(invalid === "path" ? 404 : 400);
      await expect(
        completeAuthFromInput(f.name, undefined, { runtime: f.runtime }),
      ).rejects.toThrow("No OAuth callback received yet");
      expect(f.exchanges).toHaveLength(0);
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
      expect((await fetch(callback)).status).toBe(200);
      expect(await completeAuthFromInput(f.name, undefined, { runtime: f.runtime })).toBe(
        "authenticated",
      );
    },
  );

  it("reports a captured denial without callback payloads and allows consent to be retried", async () => {
    const f = await fixture();
    const { authorizationUrl } = await f.start();
    const callback = new URL(await f.authorize(authorizationUrl));
    const denied = new URL(callback);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("error_description", `denied ${callback.href}`);
    const response = await fetch(denied);
    expect(await response.text()).toContain("Authorization Failed");
    const result = await executeAuthComplete(f.state, f.name);
    expect(result.details.error).toBe("auth_complete_failed");
    expect(result.details.authenticated).toBeUndefined();
    expect(resultText(result)).toContain("denied or failed");
    expect(JSON.stringify(result)).not.toContain(callback.href);
    expect(JSON.stringify(result)).not.toContain(requireValue(callback.searchParams.get("code")));
    expect(f.exchanges).toHaveLength(0);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    expect((await fetch(callback)).status).toBe(200);
    expect((await executeAuthComplete(f.state, f.name)).details.authenticated).toBe(true);
  });

  it("keeps a newer captured flow when an older code exchange settles", async () => {
    const a = await fixture();
    const b = await fixture("legacy", a.name);
    const callbackA = await a.authorize((await a.start()).authorizationUrl);
    expect((await fetch(callbackA)).status).toBe(200);
    a.controls.holdToken = true;
    const older = settled(completeAuthFromInput(a.name, undefined, { runtime: a.runtime }));
    await expect.poll(() => a.exchanges.length).toBe(1);
    const newer = await startAuth(a.name, b.definition.url, b.definition, { runtime: a.runtime });
    expect((await fetch(await b.authorize(newer.authorizationUrl))).status).toBe(200);
    a.controls.releaseToken();
    expect((await older).status).toBe("rejected");
    expect(hasPendingAuth(a.name, undefined, a.runtime)).toBe(true);
    expect(await completeAuthFromInput(a.name, undefined, { runtime: a.runtime })).toBe(
      "authenticated",
    );
    expect(b.exchanges).toHaveLength(1);
  });

  it.each(["logout", "shutdown", "timeout"])(
    "discards captured callbacks on %s without clearing another runtime",
    async (cleanup) => {
      const a = await fixture();
      const b = await fixture();
      const callbackB = await b.authorize((await b.start()).authorizationUrl);
      expect((await fetch(callbackB)).status).toBe(200);
      let callbackA: string;
      // Keep native HTTP progressing while installing the real auth expiry timer.
      // Node 24.20's fetch uses setTimeout for idle-socket validation; freezing it
      // deadlocks startAuth before this test can advance the five-minute clock.
      if (cleanup === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      }
      try {
        callbackA = await a.authorize((await a.start()).authorizationUrl);
        expect((await fetch(callbackA)).status).toBe(200);
        if (cleanup === "logout") {
          await removeAuth(a.name, { runtime: a.runtime });
        }
        if (cleanup === "shutdown") {
          await shutdownOAuth(a.runtime);
        }
        if (cleanup === "timeout") {
          await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        }
      } finally {
        vi.useRealTimers();
      }
      expect(hasPendingAuth(a.name, undefined, a.runtime)).toBe(false);
      expect((await fetch(callbackA)).status).toBe(400);
      expect((await executeAuthComplete(a.state, a.name)).details.authenticated).toBeUndefined();
      expect((await executeAuthComplete(b.state, b.name)).details.authenticated).toBe(true);
      expect(a.exchanges).toHaveLength(0);
      expect(b.exchanges).toHaveLength(1);
    },
  );

  for (const path of ["url", "query", "fragment"] as const) {
    it.each(invalidCallbacks)(
      `${path} validates callback errors before presentation: %s`,
      async (invalid) => {
        const f = await fixture();
        f.controls.issuerRequired = invalid !== "unexpected-issuer";
        const callback = invalidErrorCallback(
          (await f.start()).authorizationUrl,
          f.origin,
          invalid,
        );
        const input = {
          url: callback.href,
          query: callback.search,
          fragment: `${callback.origin}${callback.pathname}#${callback.search.slice(1)}`,
        }[path];
        const result = await settled(completeAuthFromInput(f.name, input, { runtime: f.runtime }));
        expect(result).toHaveProperty("status", "rejected");
        expect(result).toHaveProperty(
          "reason.message",
          expect.not.stringContaining("UNTRUSTED_ERROR_MARKER"),
        );
        assert(result.status === "rejected");
        const reason: unknown = result.reason;
        expect(String(reason)).not.toContain("UNTRUSTED_ISSUER");
        expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(
          invalid.includes("state") || invalid === "missing-issuer",
        );
        expect(f.exchanges).toHaveLength(0);
      },
    );
  }

  it.each(invalidCallbacks)(
    "http validates callback errors before presentation: %s",
    async (invalid) => {
      const f = await fixture();
      f.controls.issuerRequired = invalid !== "unexpected-issuer";
      const callback = invalidErrorCallback((await f.start()).authorizationUrl, f.origin, invalid);
      const response = await fetch(callback);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).not.toContain("UNTRUSTED_ERROR_MARKER");
      expect(html).not.toContain("UNTRUSTED_ISSUER");
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
      expect(f.exchanges).toHaveLength(0);
    },
  );

  it.each(invalidCallbacks)(
    "automatic validates callback errors before presentation: %s",
    async (invalid) => {
      const f = await fixture();
      f.controls.issuerRequired = invalid !== "unexpected-issuer";
      const controller = new AbortController();
      browser.open.mockImplementation(async (url: string) => {
        const response = await fetch(invalidErrorCallback(url, f.origin, invalid));
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).not.toContain("UNTRUSTED_ERROR_MARKER");
        expect(html).not.toContain("UNTRUSTED_ISSUER");
        if (invalid.includes("state")) {
          controller.abort(new Error("wrong state did not settle the waiter"));
        }
      });
      const result = await settled(
        authenticate(f.name, f.definition.url, f.definition, {
          runtime: f.runtime,
          signal: controller.signal,
        }),
      );
      expect(result).toHaveProperty("status", "rejected");
      expect(result).toHaveProperty(
        "reason.message",
        expect.not.stringContaining("UNTRUSTED_ERROR_MARKER"),
      );
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
      expect(f.exchanges).toHaveLength(0);
    },
  );

  it("presents only a verified manual provider denial and preserves the existing retry policy", async () => {
    const f = await fixture();
    const description = "<script>legitimate denial</script>";
    const { authorizationUrl } = await f.start();
    const callback = denialCallback(authorizationUrl, f.origin, description);
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;legitimate denial&lt;/script&gt;");
    expect(html).not.toContain(description);
    await expect(
      completeAuthFromInput(f.name, callback.href, { runtime: f.runtime }),
    ).rejects.toThrow(description);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(true);
    expect(
      await completeAuthFromInput(f.name, await f.authorize(authorizationUrl), {
        runtime: f.runtime,
      }),
    ).toBe("authenticated");
    expect(f.exchanges).toHaveLength(1);
  });

  it("presents only a verified automatic provider denial and preserves the existing retry policy", async () => {
    const f = await fixture();
    const description = "<script>legitimate denial</script>";
    f.definition.auth = "oauth";
    f.seed("basic");
    await f.connect();
    await f.call();
    browser.open.mockImplementation(async (url: string) => {
      const response = await fetch(denialCallback(url, f.origin, description));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("&lt;script&gt;legitimate denial&lt;/script&gt;");
    });
    await expect(
      authenticate(f.name, f.definition.url, f.definition, { runtime: f.runtime }),
    ).rejects.toThrow(description);
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    expect(f.exchanges).toHaveLength(0);
  });

  it("isolates concurrent callback states and issuers and rejects wrong endpoints and late callbacks", async () => {
    const a = await fixture();
    const b = await fixture();
    const first = await a.start();
    const second = await b.start();
    const callbackA = new URL(await a.authorize(first.authorizationUrl));
    const callbackB = new URL(await b.authorize(second.authorizationUrl));
    const wrongEndpoint = new URL(callbackA);
    wrongEndpoint.pathname = "/wrong";
    expect((await fetch(wrongEndpoint)).status).toBe(404);
    const mixed = new URL(callbackA);
    mixed.searchParams.set("iss", b.origin);
    mixed.searchParams.set("error", "MARKER");
    mixed.searchParams.delete("code");
    const rejected = await fetch(mixed);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("MARKER");
    expect(hasPendingAuth(a.name, undefined, a.runtime)).toBe(true);
    expect(hasPendingAuth(b.name, undefined, b.runtime)).toBe(true);
    expect((await fetch(callbackB)).status).toBe(200);
    expect(await completeAuthFromInput(b.name, callbackB.href, { runtime: b.runtime })).toBe(
      "authenticated",
    );
    expect(await completeAuthFromInput(a.name, callbackA.href, { runtime: a.runtime })).toBe(
      "authenticated",
    );
    expect(a.stored()?.tokens?.issuer).toBe(a.origin);
    expect(b.stored()?.tokens?.issuer).toBe(b.origin);
    expect((await fetch(callbackA)).status).toBe(400);
    expect((await fetch(callbackB)).status).toBe(400);
    expect(a.exchanges).toHaveLength(1);
    expect(b.exchanges).toHaveLength(1);
  });

  it("preserves accepted work for automatic auth handoff", async () => {
    const { f, close, effect } = await startAcceptedEffect();
    expect((await f.call()).details.error).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(1);
    f.controls.releaseEffect();
    expect((await effect).details.error).toBeUndefined();
    await expect.poll(() => close.mock.calls.length).toBe(1);
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(0);
    expect(f.controls.effectCount).toBe(1);
    expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
  });

  it("preserves accepted work for panel auth handoff", async () => {
    const { f, close, effect } = await startAcceptedEffect();
    const { host, flow } = await openAuthPanel(f, "\u0001");
    expect(close).not.toHaveBeenCalled();
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(1);
    f.controls.releaseEffect();
    expect((await effect).details.error).toBeUndefined();
    await expect.poll(() => close.mock.calls.length).toBe(1);
    expect(f.manager.getConnection(f.name)?.inFlight).toBe(0);
    expect(f.controls.effectCount).toBe(1);
    expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
    host.input("\u001b");
    await flow;
  });

  it("cancels accepted work for explicit panel reset rather than replaying it", async () => {
    const { f, close, effect } = await startAcceptedEffect();
    const { host, flow } = await openAuthPanel(f, "\u0012");
    expect((await effect).details).toMatchObject({
      error: "ambiguous_outcome",
      recovery: { action: "readback" },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.open).not.toHaveBeenCalled();
    expect(f.controls.effectCount).toBe(1);
    expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
    host.input("\u001b");
    await flow;
  });

  it.each([true, false])(
    "registered /mcp command preserves accepted work only after auth (afterAuth=%s)",
    async (afterAuth) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.seed("basic");
      f.controls.holdEffect = true;
      f.signIn();
      const host = await createLifecycleHost();
      cleanups.push(async () => {
        await host.dispose();
        expect(host.errors).toEqual([]);
      });
      const context = { hasUI: true, mode: "tui", isProjectTrusted: () => true, ui: f.ui } as const;
      const connecting = vi.spyOn(McpServerManager.prototype, "connect");
      createMcpAdapter({
        config: {
          mcpServers: { [f.name]: f.definition },
          settings: { sampling: false, elicitation: false },
        },
      })(host.api);
      await host.handlers.get("session_start")({}, context);
      await host.tool("mcp").execute("connect", { connect: f.name });
      const manager = connecting.mock.contexts.find((candidate) => candidate !== f.manager);
      assert(manager instanceof McpServerManager);
      const old = requireValue(manager.getConnection(f.name));
      const close = vi.spyOn(old.client, "close");
      let received!: () => void;
      const headers = new Promise<void>((resolve) => {
        received = resolve;
      });
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        const response = await nativeFetch(...args);
        if (response.headers.has("x-accepted-effect")) {
          received();
        }
        return response;
      });
      const effect = host.tool("mcp").execute("effect", { tool: f.toolName("effect"), args: {} });
      await headers;
      await host
        .command(afterAuth ? "mcp-auth" : "mcp")
        .handler(afterAuth ? f.name : `reconnect ${f.name}`, context);
      const closedBeforeRelease = close.mock.calls.length;
      if (afterAuth) {
        f.controls.releaseEffect();
      }
      const details = z.record(z.string(), z.unknown()).parse((await effect).details);
      expect(closedBeforeRelease).toBe(afterAuth ? 0 : 1);
      expect(details.error).toBe(afterAuth ? undefined : "ambiguous_outcome");
      const recovery =
        details.recovery === undefined
          ? undefined
          : z.record(z.string(), z.unknown()).parse(details.recovery);
      expect(recovery?.action).toBe(afterAuth ? undefined : "readback");
      await expect.poll(() => close.mock.calls.length).toBe(1);
      expect(browser.open).toHaveBeenCalledTimes(afterAuth ? 1 : 0);
      expect(f.controls.effectCount).toBe(1);
      expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
      expect(manager.getConnection(f.name)).not.toBe(old);
    },
  );

  it("carries native offline_access additions through the frozen step-up code exchange", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.definition.oauth = { scope: "basic" };
    f.controls.offlineAccess = true;
    f.seed("basic");
    await f.connect();
    await f.call();
    const authorizationUrl = await f.manual();
    const requested = scopes(new URL(authorizationUrl).searchParams.get("scope"));
    expect(requested).toEqual(["basic", "offline_access", "write"]);
    expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual(requested);
    expect(scopes(f.request()?.requestedScope)).toEqual(requested);
    expect((await f.call()).details.error).toBeUndefined();
  });

  for (const era of ["legacy", "modern"] as const) {
    it.each(["handshake", "tools/list", "prompts/list", "resources/list"])(
      `${era} activates a fresh runtime's stored token at %s without consent`,
      async (phase) => {
        const f = await fixture(era);
        f.seed("basic write");
        const handshake = era === "legacy" ? "initialize" : "server/discover";
        const method = phase === "handshake" ? handshake : phase;
        f.controls.protectedMethod = method;
        expect((await f.connect()).status).toBe("connected");
        expect(f.requests.filter((r) => r.method === method)).toHaveLength(2);
        expect(f.exchanges).toHaveLength(0);
        expect(browser.open).not.toHaveBeenCalled();
        f.controls.protectedMethod = "";
        await f.manager.reconnect(
          f.name,
          f.definition,
          requireValue(f.manager.getConnection(f.name)),
        );
        expect((await f.call()).details.error).toBeUndefined();
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
      },
    );
    it.each([401, 403])(
      `${era} manual first-tool %s handoff needs no extra sign-in to use the saved token`,
      async (status) => {
        const f = await fixture(era);
        f.controls.challengeStatus = status;
        if (status === 401) {
          f.controls.accessScope = "basic";
        }
        await f.connect();
        expect((await f.call()).details.error).toBe("auth_required");
        const { authorizationUrl } = await f.start();
        const callback = await f.authorize(authorizationUrl);
        expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(
          true,
        );
        expect((await f.call()).details.error).toBeUndefined();
        expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(3);
        expect(f.authorizations).toHaveLength(1);
        expect(f.exchanges).toHaveLength(1);
        expect(browser.open).not.toHaveBeenCalled();
        await f.manager.reconnect(
          f.name,
          f.definition,
          requireValue(f.manager.getConnection(f.name)),
        );
        expect((await f.call()).details.error).toBeUndefined();
        expect(f.authorizations).toHaveLength(1);
        expect(f.exchanges).toHaveLength(1);
      },
    );
  }

  it.each(["tools/list", "prompts/list", "resources/list"])(
    "completes modern implicit manual auth after a protected %s catalog",
    async (method) => {
      const f = await fixture("modern");
      f.controls.protectedMethod = method;
      expect((await f.connect()).status).toBe("needs-auth");
      await f.manual();
      expect((await f.connect()).status).toBe("connected");
      expect(f.exchanges).toHaveLength(1);
      expect(browser.open).not.toHaveBeenCalled();
    },
  );

  for (const status of [404, 405]) {
    it(`does not use SSE fallback for mandatory tools/list catalog HTTP${status}`, async () => {
      const f = await fixture("modern");
      f.controls.catalogFailure = { method: "tools/list", status };
      await expect(f.connect()).rejects.toMatchObject({ status });
      expect(
        f.http.filter((request) => request.method === "GET" && request.path === "/mcp"),
      ).toHaveLength(0);
      expect(f.requests.filter((request) => request.method === "server/discover")).toHaveLength(1);
      expect(f.request()).toBeUndefined();
    });
    it.each(["prompts/list", "resources/list"])(
      `does not use SSE fallback for optional %s catalog HTTP${status}`,
      async (method) => {
        const f = await fixture("modern");
        f.controls.catalogFailure = { method, status };
        expect((await f.connect()).status).toBe("connected");
        expect(
          f.http.filter((request) => request.method === "GET" && request.path === "/mcp"),
        ).toHaveLength(0);
        expect(f.requests.filter((request) => request.method === "server/discover")).toHaveLength(
          1,
        );
        expect(f.request()).toBeUndefined();
      },
    );
  }

  it("allows a retired native operation to retain its late scope challenge until explicit shutdown", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.seed("basic");
    f.controls.holdResource = true;
    const old = await f.connect();
    const close = vi.spyOn(old.client, "close");
    const resource = settled(f.manager.readResource(f.name, "test://document"));
    await expect.poll(() => f.controls.resourceHeld).toBe(true);
    const fresh = await f.manager.reconnect(f.name, f.definition, old);
    expect(close).not.toHaveBeenCalled();
    f.controls.rejectResource();
    const outcome = await resource;
    expect(outcome).toHaveProperty("status", "rejected");
    expect(outcome).toHaveProperty("reason", expect.any(InsufficientScopeError));
    expect(f.request()?.challenge?.requiredScope).toBe("write");
    expect(f.manager.getConnection(f.name)).toBe(fresh);
    expect(fresh.inFlight).toBe(0);
    await expect.poll(() => close.mock.calls.length).toBe(1);
    await shutdownOAuth(f.runtime);
    expect(f.request()).toBeUndefined();
  });

  it("logout clears only the exact server name even when another name contains its delimiter", async () => {
    const a = await fixture("legacy", "a");
    const b = await fixture("legacy", "a|b");
    b.manager.setOAuthRuntime(a.runtime);
    for (const f of [a, b]) {
      f.definition.auth = "oauth";
      f.seed("basic");
      const connection = await f.connect();
      await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(
        InsufficientScopeError,
      );
    }
    expect(
      getOAuthRequest(b.name, b.definition.url, getAuthBaseDir(), a.runtime)?.challenge
        ?.requiredScope,
    ).toBe("write");
    await removeAuth(a.name, { runtime: a.runtime });
    expect(a.request()).toBeUndefined();
    expect(
      getOAuthRequest(b.name, b.definition.url, getAuthBaseDir(), a.runtime)?.challenge
        ?.requiredScope,
    ).toBe("write");
  });

  it("keeps legal server-name/storage tuples separate even when delimiter joining collides", async () => {
    const a = await fixture("legacy", "a");
    const b = await fixture("legacy", "a|/b");
    a.manager.setAuthStorageOptions({ baseDir: "/b|/c" });
    b.manager.setAuthStorageOptions({ baseDir: "/c" });
    b.manager.setOAuthRuntime(a.runtime);
    b.definition.url = a.definition.url;
    for (const f of [a, b]) {
      f.definition.auth = "oauth";
      updateTokens(
        f.name,
        { accessToken: "basic-token", scope: "basic", issuer: a.origin },
        a.definition.url,
      );
      const connection = await f.connect();
      await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(
        InsufficientScopeError,
      );
      a.controls.requiredScope = "admin";
    }
    expect(
      getOAuthRequest(a.name, a.definition.url, "/b|/c", a.runtime)?.challenge?.requiredScope,
    ).toBe("write");
    expect(
      getOAuthRequest(b.name, a.definition.url, "/c", a.runtime)?.challenge?.requiredScope,
    ).toBe("admin");
    await removeAuth(a.name, { runtime: a.runtime });
    expect(
      getOAuthRequest(b.name, a.definition.url, "/c", a.runtime)?.challenge?.requiredScope,
    ).toBe("admin");
  });

  it("does not mask a mandatory catalog failure with an optional catalog auth challenge", async () => {
    const f = await fixture("modern");
    f.controls.catalogFailure = { method: "tools/list", status: 405 };
    f.controls.protectedMethod = "prompts/list";
    await expect(f.connect()).rejects.toMatchObject({ status: 405 });
    expect(f.requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
    expect(f.requests.filter((request) => request.method === "server/discover")).toHaveLength(1);
    expect(browser.open).not.toHaveBeenCalled();
    expect(f.exchanges).toHaveLength(0);
  });

  it("joins auth after another caller activates the provider before a late anonymous rejection", async () => {
    const f = await fixture();
    f.controls.accessScope = "basic";
    f.controls.holdAnonymous = true;
    f.settings.autoAuth = true;
    f.state.ui = f.ui;
    let releaseBrowser!: () => void;
    const browserGate = new Promise<void>((resolve) => {
      releaseBrowser = resolve;
    });
    browser.open.mockImplementation(async (url: string) => {
      await browserGate;
      await fetch(await f.authorize(url));
    });
    await f.connect();
    const late = f.call();
    await expect.poll(() => f.controls.anonymousHeld).toBe(true);
    const first = f.call();
    await expect.poll(() => browser.open.mock.calls.length).toBe(1);
    f.controls.releaseAnonymous();
    await expect
      .poll(() => f.requests.filter((request) => request.method === "tools/call").length)
      .toBe(4);
    releaseBrowser();
    expect((await late).details.error).toBeUndefined();
    expect((await first).details.error).toBeUndefined();
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(f.exchanges).toHaveLength(1);
    expect(f.requests.filter((request) => request.method === "tools/call")).toHaveLength(6);
  });

  it.each([{ oauth: false }, { auth: false }, { disabled: true }] satisfies ServerEntry[])(
    "does not retain a live challenge after OAuth is disabled: %j",
    async (options) => {
      const f = await fixture();
      f.definition.auth = "oauth";
      f.seed("basic");
      const connection = await f.connect();
      Object.assign(f.definition, options);
      await expect(connection.client.callTool({ name: "write" })).rejects.toBeInstanceOf(
        InsufficientScopeError,
      );
      expect(f.request()).toBeUndefined();
      expect(browser.open).not.toHaveBeenCalled();
    },
  );

  it("unions explicit configured, granted, and challenged scopes without adding unrelated advertised permissions", async () => {
    const f = await fixture();
    f.definition.auth = "oauth";
    f.definition.oauth = { scope: "configured" };
    f.seed("basic");
    f.controls.advertisedScopes.push("unrelated");
    await f.connect();
    await f.call();
    const authorizationUrl = await f.manual();
    expect(scopes(new URL(authorizationUrl).searchParams.get("scope"))).toEqual([
      "basic",
      "configured",
      "write",
    ]);
    expect(scopes(requireValue(f.exchanges[0]).get("scope"))).toEqual([
      "basic",
      "configured",
      "write",
    ]);
    expect(f.definition.oauth.scope).toBe("configured");
    expect((await f.call()).details.error).toBeUndefined();
  });

  it.each(["proxy", "direct", "script"] as const)(
    "%s stops a denied automatic permission flow without dispatching again",
    async (host) => {
      const f = await fixture("modern");
      f.definition.auth = "oauth";
      f.seed("basic");
      f.settings.autoAuth = true;
      f.state.ui = f.ui;
      browser.open.mockImplementation(async (authorizationUrl: string) => {
        const authorization = new URL(authorizationUrl);
        const callback = new URL(requireValue(authorization.searchParams.get("redirect_uri")));
        callback.search = new URLSearchParams({
          state: requireValue(authorization.searchParams.get("state")),
          iss: f.origin,
          error: "access_denied",
          error_description: "user declined",
        }).toString();
        expect((await fetch(callback)).status).toBe(200);
      });
      await f.connect();
      expect(await f.callHost(host)).toMatchObject({ ok: false, error: { code: "auth_required" } });
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(f.exchanges).toHaveLength(0);
      expect(f.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
      expect(f.request()?.challenge?.requiredScope).toBe("write");
      expect(hasPendingAuth(f.name, undefined, f.runtime)).toBe(false);
      expect(f.stored()?.tokens?.scope).toBe("basic");
    },
  );

  it("removes the HTTP waiter's issuer context at its callback timeout", async () => {
    await fixture(); // Own callback-server cleanup without replacing the production listener.
    await ensureCallbackServer({
      reserveState: true,
      oauthState: "timeout-state",
      validate: ({ iss }) =>
        validateAuthorizationResponseIssuer({
          iss,
          expectedIssuer: "https://auth.example.com",
          issParameterSupported: true,
        }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = settled(waitForCallback("timeout-state"));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      const result = await outcome;
      expect(result).toHaveProperty("status", "rejected");
      expect(result).toHaveProperty("reason.message", expect.stringContaining("callback timeout"));
    } finally {
      vi.useRealTimers();
    }
    const response = await fetch(
      `http://localhost:${getOAuthCallbackPort()}/callback?state=timeout-state&iss=https%3A%2F%2Fauth.example.com&error=access_denied&error_description=LATE_MARKER`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("LATE_MARKER");
  });

  it("manual completion retires only after an accepted effect body completes", async () => {
    const f = await fixture();
    f.controls.holdEffect = true;
    let accepted!: () => void;
    const headers = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await nativeFetch(...args);
      if (response.headers.has("x-accepted-effect")) {
        accepted();
      }
      return response;
    });
    const old = await f.connect();
    const close = vi.spyOn(old.client, "close");
    const effect = f.call("effect");
    await headers;
    const { authorizationUrl } = await f.start();
    const callback = await f.authorize(authorizationUrl);
    const requestsBeforeCompletion = f.requests.length;
    expect((await executeAuthComplete(f.state, f.name, callback)).details.authenticated).toBe(true);
    expect(f.requests).toHaveLength(requestsBeforeCompletion);
    expect(f.manager.getConnection(f.name)).toBe(old);
    expect(old.status).toBe("closed");
    expect(close).not.toHaveBeenCalled();
    f.controls.releaseEffect();
    expect((await effect).details.error).toBeUndefined();
    expect(f.controls.effectCount).toBe(1);
    expect(f.requests.filter((r) => r.name === "effect")).toHaveLength(1);
    await expect.poll(() => close.mock.calls.length).toBe(1);
  });
});
