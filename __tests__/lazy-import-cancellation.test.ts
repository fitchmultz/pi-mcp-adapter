import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runToolCall } from "../proxy-modes.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };

describe("cancellation while operation-only modules load", () => {
  it.each(["caller", "owner"] as const)("does not start beforeDispatch after immediate %s cancellation", async cancel => {
    const owner = createMcpRuntimeOwner();
    const controller = new AbortController();
    const manager = new McpServerManager();
    manager.setRuntimeSignal(owner.signal);
    try {
      const connection = await manager.connect("fixture", definition);
      // The fixture and SDK are real: establish a successful wire call before
      // observing that the cancelled operation never reaches native callTool.
      const ready = await connection.client.callTool({ name: "echo", arguments: { value: "ready" } });
      expect(ready.content).toEqual([{ type: "text", text: "ready" }]);
      const nativeCall = vi.spyOn(connection.client, "callTool");
      const increment = vi.spyOn(manager, "incrementInFlight");
      const decrement = vi.spyOn(manager, "decrementInFlight");
      const beforeDispatch = vi.fn(async () => undefined);
      const capture = vi.fn(async () => undefined);
      const state = {
        owner,
        manager,
        config: { settings: {}, mcpServers: { fixture: definition } },
        onToolCall: capture,
      } as unknown as McpExtensionState;
      const ownedSignal = AbortSignal.any([controller.signal, owner.signal]);
      const reason = `${cancel} cancelled during lazy import`;
      const pending = runToolCall(state, "fixture", { originalName: "echo" }, { value: "must not run" }, {
        detailsBase: { mode: "call", server: "fixture", tool: "echo" },
        ownedSignal,
        signal: controller.signal,
        beforeDispatch,
        recoverAuthConnection: async () => undefined,
        authRequiredMessage: () => "Unexpected OAuth request",
        autoAuthAttempted: () => false,
      });
      // No timer or mocked loader: the function has reached its first await
      // import, which yields even when its native module is already cached.
      if (cancel === "caller") controller.abort(new Error(reason));
      else await owner.stop(reason);

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
      await manager.closeAll();
      await owner.stop("test cleanup");
      vi.restoreAllMocks();
    }
  });
});
