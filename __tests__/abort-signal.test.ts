import assert from "node:assert/strict";
import type * as Native from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable } from "../abort.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeConnect } from "../proxy-modes.ts";
import { lazyConnect } from "../init.ts";
import { McpServerManager } from "../server-manager.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createAbortHttp } from "./fixtures/abort-http.ts";

const caches = vi.hoisted(() => new Map<Native.Client, Native.ResponseCacheStore>());
vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const sdk = await importOriginal<typeof Native>();
  class ObservedClient extends sdk.Client {
    constructor(...args: ConstructorParameters<typeof sdk.Client>) {
      const store = new sdk.InMemoryResponseCacheStore();
      super(args[0], { ...args[1], responseCacheStore: store });
      caches.set(this, store);
    }
  }
  return { ...sdk, Client: ObservedClient };
});

const cleanups: Array<() => Promise<void>> = [];
function holdCacheRead(client: Native.Client) {
  const store = caches.get(client);
  assert(store !== undefined);
  const entered = Promise.withResolvers<null>();
  const released = Promise.withResolvers<null>();
  vi.spyOn(store, "get").mockImplementationOnce(async (key) => {
    entered.resolve(null);
    await released.promise;
    return store.get(key);
  });
  cleanups.push(async () => {
    released.resolve(null);
  });
  return { entered: entered.promise, release: () => released.resolve(null) };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  caches.clear();
});

async function createState(hold?: string, connected = true) {
  const http = await createAbortHttp(hold);
  cleanups.push(() => http.close());
  const manager = new McpServerManager();
  cleanups.push(async () => {
    http.release();
    await manager.closeAll();
  });
  const state = createTestState({
    manager,
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: http.definition } },
    toolMetadata: new Map([
      ["demo", [{ name: "demo_slow", originalName: "slow", description: "Slow tool" }]],
    ]),
  });
  if (connected) {
    await manager.connect("demo", http.definition);
  }
  return { state, manager, http };
}

describe("AbortSignal propagation", () => {
  it("abortable rejects promptly when the host signal aborts", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<never>();
    const inFlight = abortable(pending.promise, controller.signal);
    controller.abort(new Error("user cancelled"));
    await expect(inFlight).rejects.toThrow("user cancelled");
  });

  it("direct tools pass AbortSignal to MCP callTool and settle while the native SDK cache read is held", async () => {
    const controller = new AbortController();
    const { state, manager, http } = await createState();
    const connection = manager.getConnection("demo");
    assert(connection !== undefined);
    const callTool = vi.spyOn(connection.client, "callTool");
    const decrement = vi.spyOn(manager, "decrementInFlight");
    const cache = holdCacheRead(connection.client);
    const host = await createTestExtensionContext();
    cleanups.push(host.dispose);
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "slow",
        prefixedName: "demo_slow",
        description: "Slow tool",
      },
    );
    const inFlight = execute(
      "call-1",
      {},
      controller.signal,
      undefined,
      host.runner.createToolContext("call-1", controller.signal),
    );
    await cache.entered;
    expect(callTool).toHaveBeenCalledTimes(1);
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    const first = result.content[0];
    assert(first?.type === "text");
    expect(first.text).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("aborted");
    const passedSignal = callTool.mock.calls[0]?.[1]?.signal;
    assert(passedSignal instanceof AbortSignal);
    expect(passedSignal.aborted).toBe(true);
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      { signal: passedSignal },
    );
    expect(decrement).toHaveBeenCalledWith(connection);
    expect(manager.inFlightCount(connection)).toBe(0);
    cache.release();
    await manager.closeAll();
    expect(http.messages.filter((message) => message.method === "tools/call")).toHaveLength(0);
  });

  it("proxy tool calls pass AbortSignal to MCP callTool and settle while the native SDK cache read is held", async () => {
    const controller = new AbortController();
    const { state, manager, http } = await createState();
    const connection = manager.getConnection("demo");
    assert(connection !== undefined);
    const callTool = vi.spyOn(connection.client, "callTool");
    const decrement = vi.spyOn(manager, "decrementInFlight");
    const cache = holdCacheRead(connection.client);
    const inFlight = executeCall(state, {
      toolName: "demo_slow",
      args: {},
      signal: controller.signal,
    });
    await cache.entered;
    expect(callTool).toHaveBeenCalledTimes(1);
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    const first = result.content[0];
    assert(first?.type === "text");
    expect(first.text).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("aborted");
    const passedSignal = callTool.mock.calls[0]?.[1]?.signal;
    assert(passedSignal instanceof AbortSignal);
    expect(passedSignal.aborted).toBe(true);
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      { signal: passedSignal },
    );
    expect(decrement).toHaveBeenCalledWith(connection);
    expect(manager.inFlightCount(connection)).toBe(0);
    cache.release();
    await manager.closeAll();
    expect(http.messages.filter((message) => message.method === "tools/call")).toHaveLength(0);
  });

  it("proxy cancellation during call capture prevents dispatch", async () => {
    const controller = new AbortController();
    const { state, manager, http } = await createState();
    const connection = manager.getConnection("demo");
    assert(connection !== undefined);
    const callTool = vi.spyOn(connection.client, "callTool");
    const decrement = vi.spyOn(manager, "decrementInFlight");
    const captured = Promise.withResolvers<null>();
    const capture = vi.fn<NonNullable<typeof state.onToolCall>>(async () => {
      await captured.promise;
    });
    state.onToolCall = capture;
    const inFlight = executeCall(state, {
      toolName: "demo_slow",
      args: {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ phase: "before" }));
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    expect(result.details.error).toBe("aborted");
    expect(callTool).not.toHaveBeenCalled();
    expect(decrement).toHaveBeenCalledWith(connection);
    expect(manager.inFlightCount(connection)).toBe(0);
    expect(http.messages.filter((message) => message.method === "tools/call")).toHaveLength(0);
    captured.resolve(null);
  });

  it("proxy connect passes AbortSignal to manager.connect and does not record aborts as server failures", async () => {
    const controller = new AbortController();
    const { state, manager, http } = await createState("initialize", false);
    const connect = vi.spyOn(manager, "connect");
    const inFlight = executeConnect(state, { serverName: "demo", signal: controller.signal });
    await http.entered;
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    expect(result.details.error).toBe("aborted");
    expect(connect).toHaveBeenCalledWith("demo", http.definition, expect.any(AbortSignal));
    expect(connect.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(connect.mock.calls[0]?.[2]?.reason).toBe(controller.signal.reason);
    expect(state.failureTracker.size).toBe(0);
    http.release();
    await manager.close("demo");
    expect(manager.getConnection("demo")).toBeUndefined();
  });

  it("lazyConnect rethrows host aborts without updating the failure backoff", async () => {
    const controller = new AbortController();
    const { state, manager, http } = await createState(undefined, false);
    controller.abort(new Error("user cancelled"));
    await expect(lazyConnect(state, "demo", controller.signal)).rejects.toThrow("user cancelled");
    expect(state.failureTracker.size).toBe(0);
    expect(http.messages).toHaveLength(0);
    expect(manager.getConnection("demo")).toBeUndefined();
  });

  it("server-manager resource discovery does not swallow host aborts or publish late connections", async () => {
    const controller = new AbortController();
    const { manager, http } = await createState("resources/list", false);
    const inFlight = manager.connect("demo", http.definition, controller.signal);
    await http.entered;
    controller.abort(new Error("user cancelled"));
    await expect(inFlight).rejects.toThrow("user cancelled");
    http.release();
    await manager.close("demo");
    expect(manager.getConnection("demo")).toBeUndefined();
    expect(http.messages.filter((message) => message.method === "resources/list")).toHaveLength(1);
  });

  it("server-manager readResource passes AbortSignal through the MCP SDK request options", async () => {
    const controller = new AbortController();
    const { manager } = await createState();
    const connection = manager.getConnection("demo");
    assert(connection !== undefined);
    const readResource = vi.spyOn(connection.client, "readResource");
    const result = await manager.readResource("demo", "resource://demo", controller.signal);
    expect(result.contents).toEqual([{ uri: "resource://demo", text: "resource bytes" }]);
    expect(readResource).toHaveBeenCalledWith(
      { uri: "resource://demo" },
      { signal: controller.signal },
    );
  });
});
