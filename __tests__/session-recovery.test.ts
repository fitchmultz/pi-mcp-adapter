import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  SdkError,
  SdkHttpError,
  SdkErrorCode,
  ProtocolError,
} from "@modelcontextprotocol/client";
import {
  SessionRecoveryAuthRequiredError,
  isTerminatedSession,
  withSessionRecovery,
} from "../session-recovery.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import type { McpConfig } from "../types.ts";

type RecoveryCall = (connection: ServerConnection) => Promise<string>;

function makeConnection(sessionId?: string): ServerConnection {
  return {
    client: new Client({ name: "recovery-policy", version: "1" }),
    transport: new StreamableHTTPClientTransport(
      new URL("https://example.test/mcp"),
      sessionId === undefined ? {} : { sessionId },
    ),
    definition: { url: "https://example.test/mcp" },
    tools: [],
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  };
}

describe("isTerminatedSession", () => {
  it("is true for a 404 SdkHttpError carrying a session id", () => {
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
      status: 404,
    });
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is false for a 404 with no session id (never initialized / wrong URL)", () => {
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Not found", {
      status: 404,
    });
    expect(isTerminatedSession(err, false)).toBe(false);
  });

  it("is true for a server-not-initialized MCP error carrying a session id", () => {
    const err = new ProtocolError(-32000, "Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is true for the SDK's bad-request server-not-initialized MCP error", () => {
    const err = new ProtocolError(-32000, "Bad Request: Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is true for the SDK's bad-request server-not-initialized HTTP error body", () => {
    const err = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}',
      { status: 400 },
    );
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is false for other -32000 HTTP 400 error bodies", () => {
    const err = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"},"id":null}',
      { status: 400 },
    );
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for server-not-initialized without a session id", () => {
    const err = new ProtocolError(-32000, "Server not initialized");
    expect(isTerminatedSession(err, false)).toBe(false);
  });

  it("is false for other -32000 MCP errors, even with a session id", () => {
    const err = new ProtocolError(-32000, "Connection closed");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for plain errors with the same message", () => {
    const err = new Error("MCP error -32000: Bad Request: Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for the right message with the wrong MCP error code", () => {
    const err = new ProtocolError(-32603, "Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for 400, even with a session id — ambiguous, never treated as expiry", () => {
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Bad request", {
      status: 400,
    });
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for a plain Error, even with matching message text", () => {
    const err = new Error("Streamable HTTP error: 404 session not found");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for an AbortError / cancellation", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for a non-Error thrown value", () => {
    expect(isTerminatedSession("boom", true)).toBe(false);
    expect(isTerminatedSession(undefined, true)).toBe(false);
  });
});

describe("withSessionRecovery", () => {
  function makeManager(overrides: {
    getConnection: McpServerManager["getConnection"];
    reconnect: McpServerManager["reconnect"];
  }) {
    const manager = new McpServerManager();
    vi.spyOn(manager, "getConnection").mockImplementation(overrides.getConnection);
    const reconnect = vi.spyOn(manager, "reconnect").mockImplementation(overrides.reconnect);
    return { manager, reconnect };
  }

  const config: McpConfig = {
    mcpServers: { demo: { url: "https://example.test/mcp" } },
  };

  it("transparently recovers: fn is retried exactly once against the fresh connection", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const fn = vi.fn<RecoveryCall>(async (conn) => {
      if (conn === stale) {
        throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
          status: 404,
        });
      }
      return "ok";
    });

    const result = await withSessionRecovery({ manager, config }, "demo", fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, stale);
    expect(fn).toHaveBeenNthCalledWith(2, fresh);
    expect(reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("transparently recovers server-not-initialized MCP errors", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const fn = vi.fn<RecoveryCall>(async (conn) => {
      if (conn === stale) {
        throw new ProtocolError(-32000, "Server not initialized");
      }
      return "ok";
    });

    const result = await withSessionRecovery({ manager, config }, "demo", fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, stale);
    expect(fn).toHaveBeenNthCalledWith(2, fresh);
    expect(reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not recover unrelated -32000 MCP errors", async () => {
    const connection = makeConnection("session-1");
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const err = new ProtocolError(-32000, "Connection closed");
    const fn = vi.fn<RecoveryCall>().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not replay SDK2 ConnectionClosed while a sibling is recovering", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const replacement = Promise.withResolvers<ServerConnection>();
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: () => replacement.promise,
    });
    const siblingFailure = Promise.withResolvers<string>();
    const siblingFn = vi
      .fn<RecoveryCall>()
      .mockImplementationOnce(() => siblingFailure.promise)
      .mockResolvedValue("unsafe replay");
    const sibling = withSessionRecovery({ manager, config }, "demo", siblingFn);
    const closed = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    const siblingResult = Promise.allSettled([sibling]);
    const rejectedFn = vi
      .fn<RecoveryCall>()
      .mockRejectedValueOnce(
        new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
          status: 404,
        }),
      )
      .mockResolvedValueOnce("recovered");
    const rejected = withSessionRecovery({ manager, config }, "demo", rejectedFn);
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    siblingFailure.reject(closed);
    replacement.resolve(fresh);
    const [siblingOutcome] = await siblingResult;
    assert(siblingOutcome.status === "rejected");
    expect(siblingOutcome.reason).toBe(closed);
    expect(await rejected).toBe("recovered");
    expect(siblingFn).toHaveBeenCalledTimes(1);
    expect(rejectedFn).toHaveBeenCalledTimes(2);
  });

  it("lets an auth callback replace a needs-auth reconnect before retrying", async () => {
    const stale = makeConnection("session-1");
    const needsAuth: ServerConnection = { ...makeConnection("session-2"), status: "needs-auth" };
    const authed = makeConnection("session-3");
    const { manager } = makeManager({
      getConnection: () => stale,
      reconnect: async () => needsAuth,
    });
    const onNeedsAuth = vi.fn<() => Promise<ServerConnection>>(async () => authed);

    const fn = vi.fn<RecoveryCall>(async (conn) => {
      if (conn === stale) {
        throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
          status: 404,
        });
      }
      return conn === authed ? "ok" : "wrong-connection";
    });

    const result = await withSessionRecovery({ manager, config, onNeedsAuth }, "demo", fn);

    expect(result).toBe("ok");
    expect(onNeedsAuth).toHaveBeenCalledWith("demo", undefined);
    expect(fn).toHaveBeenNthCalledWith(2, authed);
  });

  it("reports auth required when reconnect cannot produce a connected session", async () => {
    const stale = makeConnection("session-1");
    const needsAuth: ServerConnection = { ...makeConnection("session-2"), status: "needs-auth" };
    const { manager } = makeManager({
      getConnection: () => stale,
      reconnect: async () => needsAuth,
    });
    const fn = vi.fn<RecoveryCall>(async () => {
      throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
        status: 404,
      });
    });

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBeInstanceOf(
      SessionRecoveryAuthRequiredError,
    );
  });

  it("passes the abort signal into reconnect", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const signal = new AbortController().signal;
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });
    const fn = vi.fn<RecoveryCall>(async (conn) => {
      if (conn === stale) {
        throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
          status: 404,
        });
      }
      return "ok";
    });

    await expect(withSessionRecovery({ manager, config, signal }, "demo", fn)).resolves.toBe("ok");

    expect(reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale, signal);
  });

  it("does not reconnect after the caller aborts", async () => {
    const stale = makeConnection("session-1");
    const reason = new Error("stop");
    const controller = new AbortController();
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => makeConnection("session-2"),
    });
    const fn = vi.fn<RecoveryCall>(async () => {
      controller.abort(reason);
      throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
        status: 404,
      });
    });

    await expect(
      withSessionRecovery({ manager, config, signal: controller.signal }, "demo", fn),
    ).rejects.toBe(reason);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("retries exactly once: a second server-not-initialized MCP error propagates unchanged", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const err1 = new ProtocolError(-32000, "Server not initialized");
    const err2 = new ProtocolError(-32000, "Server not initialized");
    const fn = vi.fn<RecoveryCall>().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once: a second 404 propagates unchanged", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const { manager, reconnect } = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const err1 = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
      status: 404,
    });
    const err2 = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
      status: 404,
    });
    const fn = vi.fn<RecoveryCall>().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not recover a resolved tool-result error (isError content is not a thrown error)", async () => {
    const connection = makeConnection("session-1");
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const fn = vi.fn<() => Promise<{ isError: boolean; content: unknown[] }>>(async () => ({
      isError: true,
      content: [],
    }));

    const result = await withSessionRecovery({ manager, config }, "demo", fn);

    expect(result).toEqual({ isError: true, content: [] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not recover a 404 without a session id (never initialized / wrong URL)", async () => {
    const connection = makeConnection();
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Not found", {
      status: 404,
    });
    const fn = vi.fn<RecoveryCall>().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not recover an AbortError", async () => {
    const connection = makeConnection("session-1");
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const err = new DOMException("aborted", "AbortError");
    const fn = vi.fn<RecoveryCall>().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not recover a 400 (ambiguous status, never matched)", async () => {
    const connection = makeConnection("session-1");
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Bad request", {
      status: 400,
    });
    const fn = vi.fn<RecoveryCall>().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("rethrows the original error when the server was removed from config before reconnecting", async () => {
    const connection = makeConnection("session-1");
    const { manager, reconnect } = makeManager({
      getConnection: () => connection,
      reconnect: async () => connection,
    });
    const err = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", {
      status: 404,
    });
    const fn = vi.fn<RecoveryCall>().mockRejectedValue(err);
    const emptyConfig: McpConfig = { mcpServers: {} };

    await expect(withSessionRecovery({ manager, config: emptyConfig }, "demo", fn)).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
