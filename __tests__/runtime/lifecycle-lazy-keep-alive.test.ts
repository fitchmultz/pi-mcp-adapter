import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyConnect } from "../../init.ts";
import { McpLifecycleManager } from "../../lifecycle.ts";
import { logger } from "../../logger.ts";
import { executeCall } from "../../proxy-modes.ts";
import { reconnectServers } from "../../commands.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import type { ServerDefinition } from "../../types.ts";

const serverFixture = fileURLToPath(new URL("../fixtures/tools-only-server.mjs", import.meta.url));

function makeDefinition(lifecycle: NonNullable<ServerDefinition["lifecycle"]>): ServerDefinition {
  return { command: process.execPath, args: [serverFixture], lifecycle };
}

async function waitForConnection(manager: McpServerManager): Promise<ServerConnection> {
  await vi.waitFor(() => expect(manager.getConnection("srv")?.status).toBe("connected"), {
    timeout: 5000,
  });
  const connection = manager.getConnection("srv");
  assert.ok(connection, "expected connected server");
  return connection;
}

async function reconnectAfterClose(
  manager: McpServerManager,
  lifecycle: McpLifecycleManager,
): Promise<void> {
  const first = manager.getConnection("srv");
  assert.ok(first, "expected initial connection");
  assert.ok(first.transport instanceof StdioClientTransport, "expected a stdio server");
  const pid = first.transport.pid;
  assert.ok(pid !== null, "expected a spawned server process");
  process.kill(pid, "SIGTERM");
  await vi.waitFor(() => expect(first.status).toBe("closed"), { timeout: 5000 });
  lifecycle.startHealthChecks(25);
  expect(await waitForConnection(manager)).not.toBe(first);
}

describe("lazy-keep-alive lifecycle", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  let manager: McpServerManager;
  let lifecycle: McpLifecycleManager;

  beforeAll(async () => {
    initTheme();
    host = await createTestExtensionContext();
  });

  afterAll(async () => {
    await host.dispose();
  });

  beforeEach(() => {
    manager = new McpServerManager();
    lifecycle = new McpLifecycleManager(manager, () => false);
  });

  afterEach(async () => {
    await lifecycle.gracefulShutdown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not install a health interval for an already-aborted signal", async () => {
    vi.useFakeTimers();
    const connect = vi.spyOn(manager, "connect");
    lifecycle.markKeepAlive("srv", makeDefinition("keep-alive"));
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    lifecycle.startHealthChecks(controller.signal, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes health-check rejections without an unhandled rejection", async () => {
    vi.useFakeTimers();
    lifecycle.registerServer("srv", makeDefinition("lazy"), { idleTimeout: 1 });
    vi.spyOn(manager, "isIdle").mockReturnValue(true);
    vi.spyOn(manager, "close").mockRejectedValueOnce(
      new Error("idle close failed \u001b]52;c;secret\u0007"),
    );
    const debugLog = vi.spyOn(logger, "debug").mockImplementation(() => {
      // Keep expected failure diagnostics out of test output.
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Verify raw console.error is never used by health checks.
    });
    const unhandled = vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
    process.on("unhandledRejection", unhandled);

    try {
      lifecycle.startHealthChecks(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(unhandled).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith("MCP: Health check failed: idle close failed");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it("reconnects after first spawn when the process dies", async () => {
    const definition = makeDefinition("lazy-keep-alive");
    const connect = vi.spyOn(manager, "connect");
    lifecycle.registerServer("srv", definition, { idleTimeout: 0 });
    lifecycle.startHealthChecks(25);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 75);
    });
    expect(connect).not.toHaveBeenCalled();

    await manager.connect("srv", definition);
    lifecycle.markKeepAlive("srv", definition);
    await reconnectAfterClose(manager, lifecycle);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("records reconnect failures and clears them after a later success", async () => {
    const definition = makeDefinition("keep-alive");
    lifecycle.markKeepAlive("srv", definition);
    const onFailure = vi.fn<(name: string, error: unknown) => void>();
    const onSuccess = vi.fn<(name: string) => void>();
    lifecycle.setReconnectFailureCallback(onFailure);
    lifecycle.setReconnectCallback(onSuccess);
    const debugLog = vi.spyOn(logger, "debug").mockImplementation(() => {
      // Capture sanitized reconnect failure diagnostics without writing to stdout/stderr.
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Verify raw console.error is never called.
    });
    const failure = new Error("server exited \u001b]52;c;clipboard-secret\u0007safely");
    vi.spyOn(manager, "connect").mockRejectedValueOnce(failure);

    lifecycle.startHealthChecks(100);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith("srv", failure));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith("srv"), { timeout: 5000 });
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("MCP: Failed to reconnect to srv: server exited safely"),
    );
    expect(consoleError).not.toHaveBeenCalled();
    const failureOrder = onFailure.mock.invocationCallOrder[0];
    const successOrder = onSuccess.mock.invocationCallOrder[0];
    assert.ok(failureOrder !== undefined && successOrder !== undefined);
    expect(failureOrder).toBeLessThan(successOrder);
  });

  it("skips needs-auth keep-alive servers and never fires onReconnect for needs-auth connections", async () => {
    vi.useFakeTimers();
    const definition: ServerDefinition = {
      url: "https://example.invalid/mcp",
      lifecycle: "keep-alive",
    };
    const needsAuthConnection: ServerConnection = {
      client: new Client({ name: "auth-skip-test", version: "1" }),
      transport: InMemoryTransport.createLinkedPair()[0],
      definition,
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status: "needs-auth",
    };
    let current: ServerConnection | undefined;
    vi.spyOn(manager, "getConnection").mockImplementation(() => current);
    const connect = vi.spyOn(manager, "connect").mockImplementation(async () => {
      current = needsAuthConnection;
      return needsAuthConnection;
    });
    const onReconnect = vi.fn<(name: string) => void>();
    lifecycle.setReconnectCallback(onReconnect);
    lifecycle.registerServer("oauth-srv", definition, { idleTimeout: 0 });
    lifecycle.markKeepAlive("oauth-srv", definition);

    lifecycle.startHealthChecks(30_000);
    // First tick connects and receives a needs-auth connection.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();

    // Subsequent ticks must not hammer the needs-auth server.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("runs keep-alive reconnects concurrently without stalling sibling reconnects or idle shutdowns", async () => {
    vi.useFakeTimers();
    const hungDef = makeDefinition("keep-alive");
    const fastDef = makeDefinition("keep-alive");
    const lazyDef = makeDefinition("lazy");
    const hungGate = Promise.withResolvers<ServerConnection>();
    const fastConnection: ServerConnection = {
      client: new Client({ name: "fast-test", version: "1" }),
      transport: InMemoryTransport.createLinkedPair()[0],
      definition: fastDef,
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status: "connected",
    };
    let fastConnected = false;
    let lazyIdle = true;
    vi.spyOn(manager, "getConnection").mockImplementation((name) =>
      name === "fast" && fastConnected ? fastConnection : undefined,
    );
    const connect = vi.spyOn(manager, "connect").mockImplementation(async (name) => {
      if (name === "hung") {
        return hungGate.promise;
      }
      fastConnected = true;
      return fastConnection;
    });
    vi.spyOn(manager, "isIdle").mockImplementation((name) => name === "lazy" && lazyIdle);
    const close = vi.spyOn(manager, "close").mockImplementation(async () => {
      lazyIdle = false;
    });
    const onReconnect = vi.fn<(name: string) => void>();
    const onIdleShutdown = vi.fn<(name: string) => void>();
    lifecycle.setReconnectCallback(onReconnect);
    lifecycle.setIdleShutdownCallback(onIdleShutdown);

    lifecycle.registerServer("hung", hungDef, { idleTimeout: 0 });
    lifecycle.markKeepAlive("hung", hungDef);
    lifecycle.registerServer("fast", fastDef, { idleTimeout: 0 });
    lifecycle.markKeepAlive("fast", fastDef);
    lifecycle.registerServer("lazy", lazyDef, { idleTimeout: 1 });

    lifecycle.startHealthChecks(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // While "hung" is still pending, "fast" reconnected and "lazy" shut down.
    expect(connect).toHaveBeenCalledWith("hung", hungDef, expect.any(AbortSignal));
    expect(connect).toHaveBeenCalledWith("fast", fastDef, expect.any(AbortSignal));
    expect(onReconnect).toHaveBeenCalledWith("fast");
    expect(close).toHaveBeenCalledWith("lazy");
    expect(onIdleShutdown).toHaveBeenCalledWith("lazy");

    // On a later tick while "hung" is STILL pending, "hung" is not duplicated and "lazy" can idle-close again.
    lazyIdle = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect.mock.calls.filter(([name]) => name === "hung")).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(2);

    hungGate.reject(new Error("aborted"));
  });

  it("applies bounded exponential backoff to failing keep-alive reconnects and resets on resetReconnectBackoff", async () => {
    vi.useFakeTimers();
    const definition = makeDefinition("keep-alive");
    const connect = vi.spyOn(manager, "connect").mockRejectedValue(new Error("server down"));
    lifecycle.registerServer("flaky", definition, { idleTimeout: 0 });
    lifecycle.markKeepAlive("flaky", definition);

    lifecycle.startHealthChecks(30_000);
    // t=30s -> attempt #1 fails (backoff 30s -> nextRetryAt=60s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(1);

    // t=60s -> attempt #2 fails (backoff 60s -> nextRetryAt=120s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(2);

    // t=90s -> skipped due to 60s backoff
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(2);

    // t=120s -> attempt #3 fails (backoff 120s -> nextRetryAt=240s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(3);

    // t=150s, 180s, 210s -> skipped
    await vi.advanceTimersByTimeAsync(90_000);
    expect(connect).toHaveBeenCalledTimes(3);

    // t=240s -> attempt #4 fails (backoff 240s -> nextRetryAt=480s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(4);

    // t=480s -> attempt #5 fails (capped at 300s -> nextRetryAt=780s)
    await vi.advanceTimersByTimeAsync(240_000);
    expect(connect).toHaveBeenCalledTimes(5);

    // t=750s -> still skipped (270s elapsed < 300s cap)
    await vi.advanceTimersByTimeAsync(270_000);
    expect(connect).toHaveBeenCalledTimes(5);

    // t=780s -> attempt #6 runs at 300s cap
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(6);

    // Explicit backoff reset lets the very next 30s tick retry immediately.
    lifecycle.resetReconnectBackoff("flaky");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connect).toHaveBeenCalledTimes(7);
  });

  it("does not reconnect keep-alive servers while OAuth authorization is pending", async () => {
    vi.useFakeTimers();
    const definition = makeDefinition("keep-alive");
    const connection: ServerConnection = {
      client: new Client({ name: "auth-test", version: "1" }),
      transport: InMemoryTransport.createLinkedPair()[0],
      definition,
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status: "needs-auth",
    };
    vi.spyOn(manager, "getConnection").mockReturnValue(connection);
    const connect = vi.spyOn(manager, "connect");
    lifecycle = new McpLifecycleManager(manager, (name) => name === "srv");
    lifecycle.registerServer("srv", definition, { idleTimeout: 0 });
    lifecycle.markKeepAlive("srv", definition);
    lifecycle.startHealthChecks(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).not.toHaveBeenCalled();
  });

  it("never idle-shuts a server registered with idleTimeout 0", async () => {
    const definition = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", definition, { idleTimeout: 0 });
    const connection = await manager.connect("srv", definition);
    connection.lastUsedAt = Date.now() - 120_000;
    lifecycle.startHealthChecks(25);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 75);
    });
    expect(manager.getConnection("srv")).toBe(connection);
  });

  it("idle-shuts a plain lazy server past its timeout", async () => {
    const definition = makeDefinition("lazy");
    lifecycle.registerServer("srv", definition, { idleTimeout: 1 });
    const connection = await manager.connect("srv", definition);
    connection.lastUsedAt = Date.now() - 120_000;
    lifecycle.startHealthChecks(25);
    await vi.waitFor(() => expect(manager.getConnection("srv")).toBeUndefined(), { timeout: 5000 });
  });

  it("marks lazyConnect first spawns for health-check reconnects", async () => {
    const definition = makeDefinition("lazy-keep-alive");
    const setStatus = vi.spyOn(host.context.ui, "setStatus");
    const state = createTestState({
      config: { settings: { showStatusIcon: false }, mcpServers: { srv: definition } },
      manager,
      lifecycle,
      ui: host.context.ui,
    });

    expect(await lazyConnect(state, "srv")).toBe(true);
    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: connecting to srv...");
    await reconnectAfterClose(manager, lifecycle);
  });

  it("marks cached proxy first-use connects for health-check reconnects", async () => {
    const definition = makeDefinition("lazy-keep-alive");
    const state = createTestState({
      config: { settings: { toolPrefix: "server" }, mcpServers: { srv: definition } },
      manager,
      lifecycle,
      toolMetadata: new Map([
        ["srv", [{ name: "srv_noop", originalName: "noop", description: "No-op" }]],
      ]),
    });

    const result = await executeCall(state, {
      toolName: "srv_noop",
      args: {},
      serverOverride: "srv",
    });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    await reconnectAfterClose(manager, lifecycle);
  });

  it("marks manual reconnects for lazy-keep-alive servers", async () => {
    const definition = makeDefinition("lazy-keep-alive");
    const state = createTestState({
      config: { settings: {}, mcpServers: { srv: definition } },
      manager,
      lifecycle,
    });

    await reconnectServers(state, host.context, "srv");
    await reconnectAfterClose(manager, lifecycle);
    expect(manager.getConnection("srv")?.status).toBe("connected");
  });
});
