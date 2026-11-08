import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { executeCall } from "../proxy-modes.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { createTestState } from "./test-state.ts";
import { fileURLToPath } from "node:url";
import { createOutcomeResponder } from "./fixtures/outcome-server.ts";

const outcomeFixture = fileURLToPath(new URL("./fixtures/outcome-server.ts", import.meta.url));
const closingWriteFixture = fileURLToPath(
  new URL("./fixtures/closing-write-server.ts", import.meta.url),
);

it.each(["stdio", "unix"])(
  "reports a committed %s tool's expired deadline without replay",
  async (transport) => {
    const manager = new McpServerManager();
    const directory = await mkdtemp(join(tmpdir(), "mcp-outcome-"));
    const socketPath = join(directory, "server.sock");
    const server =
      transport === "unix"
        ? createServer((socket) => {
            const handle = createOutcomeResponder((message) => {
              socket.write(JSON.stringify(message) + "\n");
            });
            createInterface({ input: socket }).on("line", (line) => {
              handle(line).catch((error: unknown) => {
                socket.destroy(error instanceof Error ? error : new Error(String(error)));
              });
            });
          })
        : undefined;
    try {
      if (server) {
        await new Promise<void>((resolve) => {
          server.listen(socketPath, resolve);
        });
      }
      const definition = {
        ...(server
          ? { socket: socketPath }
          : {
              command: process.execPath,
              args: [outcomeFixture],
            }),
        requestTimeoutMs: 2000,
        retryOnTransportFailure: true,
      };
      const connection = await manager.connect("local", definition);
      definition.requestTimeoutMs = 80;
      const state = createTestState({
        manager,
        config: { mcpServers: { local: definition }, settings: {} },
        toolMetadata: new Map([
          [
            "local",
            buildToolMetadata({
              tools: connection.tools,
              resources: [],
              definition,
              serverName: "local",
              prefix: "server",
            }).metadata,
          ],
        ]),
        failureTracker: new Map(),
        serverInstructions: new Map(),
        completedUiSessions: [],
      });
      const output = await executeCall(state, { toolName: "local_write", args: {} });
      expect(output.details).toMatchObject({
        error: "ambiguous_outcome",
        recovery: { action: "readback" },
      });
      const readback = await executeCall(state, { toolName: "local_readback", args: {} });
      expect(readback.content).toEqual([{ type: "text", text: "1" }]);
    } finally {
      await manager.closeAll();
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "reports a committed write followed by ConnectionClosed without replay (idempotent=%s)",
  async (idempotent) => {
    const manager = new McpServerManager();
    const directory = await mkdtemp(join(tmpdir(), "mcp-closed-outcome-"));
    const marker = join(directory, "committed");
    try {
      const definition = {
        command: process.execPath,
        args: [closingWriteFixture, marker, String(idempotent)],
        requestTimeoutMs: 2000,
        retryOnTransportFailure: true,
      };
      const connection = await manager.connect("local", definition);
      const state = createTestState({
        manager,
        config: { mcpServers: { local: definition }, settings: {} },
        toolMetadata: new Map([
          [
            "local",
            buildToolMetadata({
              tools: connection.tools,
              resources: [],
              definition,
              serverName: "local",
              prefix: "server",
            }).metadata,
          ],
        ]),
        failureTracker: new Map(),
        serverInstructions: new Map(),
        completedUiSessions: [],
      });
      const output = await executeCall(state, { toolName: "local_write", args: {} });
      expect(await readFile(marker, "utf8")).toBe("committed\n");
      expect(output.details).toMatchObject({
        error: "ambiguous_outcome",
        recovery: { action: "readback" },
      });
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
