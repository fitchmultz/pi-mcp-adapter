import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { executeCall, runToolCall } from "../../proxy-modes.ts";
import { createMcpRuntimeOwner, type McpRuntimeOwner } from "../../runtime-owner.ts";
import { McpServerManager } from "../../server-manager.ts";
import { createTestState } from "../test-state.ts";

const fixture = fileURLToPath(new URL("../fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
type Cancellation = "caller" | "owner";

function createFixture() {
  const owner = createMcpRuntimeOwner();
  const controller = new AbortController();
  const manager = new McpServerManager();
  manager.setRuntimeSignal(owner.signal);
  const cleanup = async () => {
    await manager.closeAll();
    await owner.stop("test cleanup");
    vi.restoreAllMocks();
  };
  return { owner, controller, manager, cleanup };
}

async function connectReady(manager: McpServerManager) {
  const connection = await manager.connect("fixture", definition);
  // The fixture and SDK are real: establish a successful wire call before
  // observing that the cancelled operation never reaches native callTool.
  const ready = await connection.client.callTool({
    name: "echo",
    arguments: { value: "ready" },
  });
  expect(ready.content).toEqual([{ type: "text", text: "ready" }]);
  return connection;
}

async function cancelOperation(
  cancel: Cancellation,
  { controller, owner }: { controller: AbortController; owner: McpRuntimeOwner },
  reason: string,
): Promise<void> {
  if (cancel === "caller") {
    controller.abort(new Error(reason));
  } else {
    await owner.stop(reason);
  }
}

describe("cancellation while operation-only modules load", () => {
  it.each(["caller", "owner"] as const)(
    "does not start beforeDispatch after immediate %s cancellation",
    async (cancel) => {
      const { owner, controller, manager, cleanup } = createFixture();
      try {
        const connection = await connectReady(manager);
        const nativeCall = vi.spyOn(connection.client, "callTool");
        const increment = vi.spyOn(manager, "incrementInFlight");
        const decrement = vi.spyOn(manager, "decrementInFlight");
        const beforeDispatch = vi.fn<() => Promise<void>>().mockResolvedValue();
        const capture = vi.fn<() => Promise<void>>().mockResolvedValue();
        const state = createTestState({
          owner,
          manager,
          config: { settings: {}, mcpServers: { fixture: definition } },
          onToolCall: capture,
        });
        const ownedSignal = AbortSignal.any([controller.signal, owner.signal]);
        const reason = `${cancel} cancelled during lazy import`;
        const pending = runToolCall({
          state,
          serverName: "fixture",
          target: { originalName: "echo" },
          args: { value: "must not run" },
          options: {
            detailsBase: { mode: "call", server: "fixture", tool: "echo" },
            ownedSignal,
            signal: controller.signal,
            beforeDispatch,
            recoverAuthConnection: () => Promise.reject(new Error("Unexpected OAuth request")),
            authRequiredMessage: () => "Unexpected OAuth request",
            autoAuthAttempted: () => false,
          },
        });
        // No timer or mocked loader: the function has reached its first await
        // import, which yields even when its native module is already cached.
        await cancelOperation(cancel, { controller, owner }, reason);

        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({ mode: "call", error: "aborted", message: reason });
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(nativeCall).not.toHaveBeenCalled();
        expect(increment).toHaveBeenCalledExactlyOnceWith("fixture");
        expect(decrement).toHaveBeenCalledExactlyOnceWith("fixture");
        expect(connection.inFlight).toBe(0);
      } finally {
        await cleanup();
      }
    },
  );

  it.each(["caller", "owner"] as const)(
    "rejects a call before connection preparation after immediate %s cancellation",
    async (cancel) => {
      const { owner, controller, manager, cleanup } = createFixture();
      try {
        const connection = await connectReady(manager);
        const nativeCall = vi.spyOn(connection.client, "callTool");
        const increment = vi.spyOn(manager, "incrementInFlight");
        const beforeDispatch = vi.fn<() => Promise<void>>().mockResolvedValue();
        const capture = vi.fn<() => Promise<void>>().mockResolvedValue();
        const state = createTestState({
          owner,
          manager,
          config: { settings: {}, mcpServers: { fixture: definition } },
          onToolCall: capture,
        });
        const reason = `${cancel} cancelled during connection import`;
        const outcome = executeCall(state, {
          toolName: "echo",
          args: { value: "must not run" },
          serverOverride: "fixture",
          signal: controller.signal,
          beforeDispatch,
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        // Connection preparation is suspended at its recovery-module import.
        await cancelOperation(cancel, { controller, owner }, reason);

        expect(await outcome).toEqual({ error: new Error(reason) });
        expect(state.toolMetadata.has("fixture")).toBe(false);
        expect(increment).not.toHaveBeenCalled();
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(nativeCall).not.toHaveBeenCalled();
        expect(connection.inFlight).toBe(0);
      } finally {
        await cleanup();
      }
    },
  );
});
