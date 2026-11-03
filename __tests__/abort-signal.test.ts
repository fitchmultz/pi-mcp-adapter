import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abortable } from "../abort.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeConnect } from "../proxy-modes.ts";
import { lazyConnect } from "../init.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createTestState } from "./test-state.ts";
import { firstText, proxyRuntimeState } from "./fixtures/proxy-runtime.ts";

let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

async function connectedState() {
  const { state, connection } = await proxyRuntimeState({ name: "slow", description: "Slow tool" });
  const ready = await connection.client.callTool({ name: "slow", arguments: {} });
  expect(ready.content).toEqual([{ type: "text", text: "called" }]);
  return {
    state,
    callTool: vi.spyOn(connection.client, "callTool"),
    decrement: vi.spyOn(state.manager, "decrementInFlight"),
  };
}

describe("AbortSignal propagation", () => {
  it("abortable rejects promptly when the host signal aborts", async () => {
    const controller = new AbortController();
    const inFlight = abortable(
      new Promise<never>(() => {
        /* Deliberately hold the SDK result until caller cancellation. */
      }),
      controller.signal,
    );
    controller.abort(new Error("user cancelled"));
    await expect(inFlight).rejects.toThrow("user cancelled");
  });

  it("direct tools pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const { state, callTool, decrement } = await connectedState();
    callTool.mockImplementation(
      () =>
        new Promise<never>(() => {
          /* Deliberately hold the SDK result until caller cancellation. */
        }),
    );
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
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    expect(firstText(result)).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("aborted");
    const anySignal: unknown = expect.any(AbortSignal);
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      { signal: anySignal },
    );
    expect(decrement).toHaveBeenCalledWith("demo");
  });

  it("proxy tool calls pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const { state, callTool, decrement } = await connectedState();
    callTool.mockImplementation(
      () =>
        new Promise<never>(() => {
          /* Deliberately hold the SDK result until caller cancellation. */
        }),
    );
    const inFlight = executeCall(state, "demo_slow", {}, undefined, undefined, controller.signal);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    controller.abort(new Error("user cancelled"));
    const result = await inFlight;
    expect(firstText(result)).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("aborted");
    const anySignal: unknown = expect.any(AbortSignal);
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      { signal: anySignal },
    );
    expect(decrement).toHaveBeenCalledWith("demo");
  });

  it("proxy cancellation during call capture prevents dispatch", async () => {
    const controller = new AbortController();
    const { state, callTool, decrement } = await connectedState();
    const captured = Promise.withResolvers<null>();
    const capture = vi.fn<() => Promise<void>>(async () => {
      await captured.promise;
    });
    state.onToolCall = capture;
    try {
      const inFlight = executeCall(state, "demo_slow", {}, undefined, undefined, controller.signal);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ phase: "before" }));
      controller.abort(new Error("user cancelled"));
      const result = await inFlight;
      expect(result.details.error).toBe("aborted");
      expect(callTool).not.toHaveBeenCalled();
      expect(decrement).toHaveBeenCalledWith("demo");
    } finally {
      captured.resolve(null);
    }
  });

  it("proxy connect passes AbortSignal to manager.connect and does not record aborts as server failures", async () => {
    const controller = new AbortController();
    const definition = { command: "node", args: ["server.js"] };
    const state = createTestState({ config: { mcpServers: { demo: definition } } });
    const reason = new Error("user cancelled");
    const connect = vi
      .spyOn(state.manager, "connect")
      .mockImplementation((_name, _definition, signal) => {
        controller.abort(reason);
        const failure: unknown = signal?.reason;
        return Promise.reject(failure);
      });
    try {
      const result = await executeConnect(state, "demo", controller.signal);
      expect(result.details.error).toBe("aborted");
      expect(connect).toHaveBeenCalledWith("demo", definition, expect.any(AbortSignal));
      const signal = connect.mock.calls[0]?.[2];
      assert.ok(signal);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(controller.signal.reason);
      expect(state.failureTracker.size).toBe(0);
    } finally {
      connect.mockRestore();
      await state.owner.stop();
    }
  });

  it("lazyConnect rethrows host aborts without updating the failure backoff", async () => {
    const controller = new AbortController();
    const state = createTestState({
      config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
    });
    controller.abort(new Error("user cancelled"));
    await expect(lazyConnect(state, "demo", controller.signal)).rejects.toThrow("user cancelled");
    expect(state.failureTracker.size).toBe(0);
    await state.owner.stop();
  });

  it("server-manager resource discovery does not swallow host aborts", async () => {
    const controller = new AbortController();
    const listResources = vi.fn<() => { resources: [] }>(() => {
      controller.abort(new Error("user cancelled"));
      return { resources: [] };
    });
    await expect(proxyRuntimeState({ listResources, signal: controller.signal })).rejects.toThrow(
      "user cancelled",
    );
    expect(listResources).toHaveBeenCalledOnce();
  });

  it("server-manager readResource passes AbortSignal through the MCP SDK request options", async () => {
    const controller = new AbortController();
    const { state, connection } = await proxyRuntimeState({
      readResource: () => ({ contents: [] }),
    });
    const readResource = vi.spyOn(connection.client, "readResource");
    await state.manager.readResource("demo", "resource://demo", controller.signal);
    expect(readResource).toHaveBeenCalledWith(
      { uri: "resource://demo" },
      { signal: controller.signal },
    );
  });
});
