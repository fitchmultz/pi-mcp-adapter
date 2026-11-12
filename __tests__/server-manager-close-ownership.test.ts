import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { McpServerManager } from "../server-manager.ts";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type Socket } from "node:net";
import { ManagedClient } from "../connection-runtime.ts";
import { clientOperations } from "../client-operations.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";
import type * as StdioModule from "@modelcontextprotocol/client/stdio";
import { getDefaultHighWaterMark } from "node:stream";

const exitWindow = vi.hoisted<{
  enabled: boolean;
  exits: Promise<void>[];
  children: ChildProcess[];
}>(() => ({
  enabled: false,
  exits: [],
  children: [],
}));

function observeChild(message: unknown): void {
  assert(message !== null && typeof message === "object" && "process" in message);
  assert(message.process instanceof ChildProcess);
  const child = message.process;
  exitWindow.children.push(child);
  exitWindow.exits.push(
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
  );
}

vi.mock("@modelcontextprotocol/client/stdio", async () => {
  const native = await vi.importActual<typeof StdioModule>("@modelcontextprotocol/client/stdio");
  class ExitWindowTransport extends native.StdioClientTransport {
    override async start(): Promise<void> {
      await super.start();
      if (exitWindow.enabled) {
        // Hold native Client initialization until the actual child exit, while
        // inherited stdout/stderr pipes still delay its native close callback.
        await requireValue(exitWindow.exits[0]);
      }
    }
  }
  return { ...native, StdioClientTransport: ExitWindowTransport };
});

const fixture = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };

describe("McpServerManager connection close ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    exitWindow.enabled = false;
    exitWindow.exits.length = 0;
    exitWindow.children.length = 0;
  });

  const __dirname = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
  it("closes a connected stdio transport exactly once via client.close", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const connection = await manager.connect("demo", definition);
    const clientCloseSpy = vi.spyOn(connection.client, "close");
    const transportCloseSpy = vi.spyOn(connection.transport, "close");

    await manager.close("demo");

    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpy).toHaveBeenCalledTimes(1);
    const clientOrder = clientCloseSpy.mock.invocationCallOrder[0];
    const transportOrder = transportCloseSpy.mock.invocationCallOrder[0];
    assert(clientOrder !== undefined && transportOrder !== undefined);
    expect(clientOrder).toBeLessThan(transportOrder);
  });

  it("keeps in-flight accounting on the connection a call started on", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const first = await manager.connect("demo", definition);
    manager.incrementInFlight(first);
    await manager.close("demo");
    manager.decrementInFlight(first);

    const second = await manager.connect("demo", definition);
    expect(manager.inFlightCount(second)).toBe(0);

    manager.incrementInFlight(second);
    manager.decrementInFlight(first);
    expect(manager.inFlightCount(second)).toBe(1);

    await manager.close("demo");
  });

  it("drains a failed stdio send only after native process and pipe closure", async () => {
    const peer = Promise.withResolvers<Socket>();
    const server = createServer((socket) => peer.resolve(socket));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    subscribe("child_process", observeChild);
    const sends = vi.spyOn(ManagedClient.prototype, "ownSend");
    exitWindow.enabled = true;
    const manager = new McpServerManager();
    let socket: Socket | undefined;
    try {
      const connecting = Promise.allSettled([
        manager.connect("exited", {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./fixtures/stdio-exit-pipes.ts", import.meta.url)),
            "exit",
            String(address.port),
          ],
          protocolVersion: "legacy",
        }),
      ]);
      socket = await peer.promise;
      await expect.poll(() => sends.mock.calls.length).toBe(1);
      const client: unknown = sends.mock.contexts[0];
      assert(client instanceof ManagedClient);
      const operations = requireValue(clientOperations.get(client));
      expect([...operations.values()]).toEqual(["request/refresh"]);
      let closed = false;
      const closing = manager.closeAll().then(() => {
        closed = true;
        return null;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closed).toBe(false);
      expect(operations.size).toBe(1);
      socket.end("release pipes");
      expect(await connecting).toHaveProperty("0.status", "rejected");
      await closing;
      expect(operations.size).toBe(0);
      expect(manager.getAllConnections().size).toBe(0);
    } finally {
      socket?.destroy();
      unsubscribe("child_process", observeChild);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("retains a live stdio writer under real backpressure until actual closure", async () => {
    const peer = Promise.withResolvers<Socket>();
    const server = createServer((socket) => peer.resolve(socket));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    subscribe("child_process", observeChild);
    const manager = new McpServerManager();
    let socket: Socket | undefined;
    try {
      const connection = await manager.connect("blocked", {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/stdio-exit-pipes.ts", import.meta.url)),
          "no-read",
          String(address.port),
        ],
        protocolVersion: "legacy",
      });
      socket = await peer.promise;
      await connection.client.callTool({ name: "pause" });
      const child = requireValue(exitWindow.children[0]);
      const pending = Promise.allSettled([
        connection.client.callTool({
          name: "blocked",
          arguments: { text: "x".repeat(getDefaultHighWaterMark(false) * 32) },
        }),
      ]);
      await expect.poll(() => child.stdin?.writableNeedDrain).toBe(true);
      expect(child.exitCode).toBeNull();
      const operations = requireValue(clientOperations.get(connection.client));
      expect(operations.size).toBe(2);
      let closed = false;
      const closing = manager.closeAll().then(() => {
        closed = true;
        return null;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closed).toBe(false);
      expect(operations.size).toBeGreaterThan(0);
      socket.end("release process");
      expect(await pending).toHaveProperty("0.status", "rejected");
      await closing;
      expect(operations.size).toBe(0);
    } finally {
      socket?.destroy();
      unsubscribe("child_process", observeChild);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
