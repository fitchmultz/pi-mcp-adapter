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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Keep the expected failure out of test output.
    });
    const unhandled = vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
    process.on("unhandledRejection", unhandled);

    try {
      lifecycle.startHealthChecks(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith("MCP: Health check failed: idle close failed");
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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Keep the expected failure out of test output.
    });
    const failure = new Error("server exited \u001b]52;c;clipboard-secret\u0007safely");
    vi.spyOn(manager, "connect").mockRejectedValueOnce(failure);

    lifecycle.startHealthChecks(100);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith("srv", failure));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith("srv"), { timeout: 5000 });
    expect(consoleError).toHaveBeenCalledWith(
      "MCP: Failed to reconnect to srv: server exited safely",
    );
    const failureOrder = onFailure.mock.invocationCallOrder[0];
    const successOrder = onSuccess.mock.invocationCallOrder[0];
    assert.ok(failureOrder !== undefined && successOrder !== undefined);
    expect(failureOrder).toBeLessThan(successOrder);
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
