import { CallToolRequestSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** One committed-write counter per real stdio or Unix-socket connection. */
export function createOutcomeResponder(
  send: (message: unknown) => void,
): (line: string) => Promise<void> {
  let committed = 0;
  return async (line) => {
    const input: unknown = JSON.parse(line);
    const request = JSONRPCMessageSchema.parse(input);
    if (!("id" in request) || !("method" in request)) {
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
      const call = CallToolRequestSchema.parse(request);
      if (call.params.name === "write") {
        committed++;
        await delay(160);
      }
      result = { content: [{ type: "text", text: String(committed) }] };
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const handle = createOutcomeResponder((message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  createInterface({ input: process.stdin }).on("line", (line) => {
    handle(line).catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  });
}
