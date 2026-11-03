import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { executeCall } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { createTestState } from "./test-state.ts";

// Self-contained so the same wire fixture runs in a real stdio child or on a Unix socket.
function responder(send: (message: unknown) => void) {
  let committed = 0;
  function isWrite(value: unknown): value is { name: "write" } {
    return typeof value === "object" && value !== null && "name" in value && value.name === "write";
  }
  function writeDelay(params: object): number {
    const args = "arguments" in params ? params.arguments : undefined;
    return typeof args === "object" &&
      args !== null &&
      "delayMs" in args &&
      typeof args.delayMs === "number"
      ? args.delayMs
      : 160;
  }
  return async (request: unknown): Promise<void> => {
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      request.id === undefined ||
      !("method" in request)
    ) {
      return;
    }
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "outcome", version: "1" },
      };
    } else if (request.method === "tools/list") {
      result = {
        tools: ["write", "readback"].map((name) => ({
          name,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: name === "readback", idempotentHint: false },
        })),
      };
    } else if (request.method === "tools/call") {
      const params = "params" in request ? request.params : undefined;
      if (isWrite(params)) {
        committed++;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, writeDelay(params));
        });
      }
      result = { content: [{ type: "text", text: String(committed) }] };
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  };
}

function assertNoScriptError(output: Awaited<ReturnType<typeof runMcpScript>>): void {
  expect(output.details).not.toHaveProperty("error");
}
function assertScriptError(output: Awaited<ReturnType<typeof runMcpScript>>, error: unknown): void {
  expect(output.details.error).toBe(error);
}

async function cancelAfterWrite(
  state: Parameters<typeof executeCall>[0],
  controller: AbortController,
): Promise<void> {
  await expect
    .poll(async () => (await executeCall(state, "local_readback", {})).content)
    .toEqual([{ type: "text", text: "1" }]);
  controller.abort(new Error("caller cancelled"));
}

it.each(["stdio", "unix"])(
  "reports a committed %s tool's expired deadline without replay",
  async (transport) => {
    const manager = new McpServerManager();
    const directory = await mkdtemp(join(tmpdir(), "mcp-outcome-"));
    const socketPath = join(directory, "server.sock");
    const server =
      transport === "unix"
        ? createServer((socket) => {
            const handle = responder((message) => socket.write(JSON.stringify(message) + "\n"));
            createInterface({ input: socket }).on("line", (line) => {
              const request: unknown = JSON.parse(line);
              handle(request).catch((error: unknown) => {
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
              args: [
                "--input-type=module",
                "--eval",
                `
          import { createInterface } from "node:readline";
          const handle = (${responder.toString()})(message => process.stdout.write(JSON.stringify(message) + "\\n"));
          createInterface({ input: process.stdin }).on("line", line => { void handle(JSON.parse(line)); });
        `,
              ],
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
            buildToolMetadata(connection.tools, [], definition, "local", "server").metadata,
          ],
        ]),
        failureTracker: new Map(),
        serverInstructions: new Map(),
        completedUiSessions: [],
      });
      const output = await executeCall(state, "local_write", {});
      expect(output.details).toMatchObject({
        error: "ambiguous_outcome",
        recovery: { action: "readback" },
      });
      const readback = await executeCall(state, "local_readback", {});
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

it.each([
  ["timeout", false],
  ["abort", false],
  ["early return", false],
  ["timeout", true],
] as const)(
  "reports committed writes when a script ends by %s (capture=%s)",
  async (ending, capture) => {
    const manager = new McpServerManager();
    const controller = new AbortController();
    try {
      const definition = {
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          `
        import { createInterface } from "node:readline";
        const handle = (${responder.toString()})(message => process.stdout.write(JSON.stringify(message) + "\\n"));
        createInterface({ input: process.stdin }).on("line", line => { void handle(JSON.parse(line)); });
      `,
        ],
        requestTimeoutMs: 10_000,
        retryOnTransportFailure: true,
      };
      const connection = await manager.connect("local", definition);
      const state = createTestState({
        manager,
        config: { mcpServers: { local: definition }, settings: {} },
        toolMetadata: new Map([
          [
            "local",
            buildToolMetadata(connection.tools, [], definition, "local", "server").metadata,
          ],
        ]),
        failureTracker: new Map(),
        serverInstructions: new Map(),
        completedUiSessions: [],
      });
      if (capture) {
        state.onToolCall = async () => {
          /* A successful capture callback owns the cancellation receipt. */
        };
      }
      const pending = runMcpScript(
        state,
        `
      await tools.local_readback({});
      const write = tools.local_write({ delayMs: 5000 });
      tools.local_write({ blocked: true });
      ${ending === "early return" ? 'await tools.local_readback({}); return "early";' : "await write;"}
    `,
        ending === "timeout" ? 500 : 10_000,
        undefined,
        controller.signal,
        "script-write",
        async (_signal, operation) => {
          if (operation.args.blocked === true) {
            await new Promise(() => {
              /* Hold this pre-dispatch gate until script cancellation. */
            });
          }
        },
      );
      if (ending === "abort") {
        await cancelAfterWrite(state, controller);
      }
      const output = await pending;
      const errors = { "early return": undefined, timeout: "timeout", abort: "aborted" };
      const assertEnding = ending === "early return" ? assertNoScriptError : assertScriptError;
      assertEnding(output, errors[ending]);
      const capturedError: unknown = expect.any(Error);
      const recovery: unknown = expect.objectContaining({
        server: "local",
        tool: "write",
        toolCallId: "script-write",
        innerCallId: 2,
        ...(capture
          ? { phase: "after", args: { delayMs: 5000 }, error: capturedError }
          : { action: "readback" }),
      });
      expect(output.details.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "local_readback", ok: true }),
          expect.objectContaining({
            path: "local_write",
            error: capture ? "aborted" : "ambiguous_outcome",
            recovery,
          }),
          expect.objectContaining({ path: "local_write", error: "aborted" }),
        ]),
      );
      const recoveryNotice: unknown = expect.stringContaining(
        capture ? "do not repeat a completed call or rerun the script" : "Do not blindly repeat",
      );
      expect(output.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: recoveryNotice,
          }),
        ]),
      );
      expect((await executeCall(state, "local_readback", {})).content).toEqual([
        { type: "text", text: "1" },
      ]);
      expect(connection.inFlight).toBe(0);
    } finally {
      await manager.closeAll();
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
        args: [
          "--input-type=module",
          "--eval",
          `
        import { createInterface } from "node:readline";
        import { appendFileSync } from "node:fs";
        createInterface({ input: process.stdin }).on("line", line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          let result;
          if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "close", version: "1" } };
          else if (request.method === "tools/list") result = { tools: [{ name: "write", inputSchema: { type: "object" }, annotations: { idempotentHint: ${idempotent} } }] };
          else if (request.method === "tools/call") { appendFileSync(${JSON.stringify(marker)}, "committed\\n"); process.exit(0); }
          else return;
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        });
      `,
        ],
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
            buildToolMetadata(connection.tools, [], definition, "local", "server").metadata,
          ],
        ]),
        failureTracker: new Map(),
        serverInstructions: new Map(),
        completedUiSessions: [],
      });
      const output = await executeCall(state, "local_write", {});
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
