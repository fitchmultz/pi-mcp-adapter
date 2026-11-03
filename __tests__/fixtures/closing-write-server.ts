/** Stdio MCP server that commits one write, then closes its connection instead of replying. */
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [marker, idempotent] = process.argv.slice(2);
if (marker === undefined || (idempotent !== "true" && idempotent !== "false")) {
  throw new Error("Usage: closing-write-server.ts <marker-file> <true|false>");
}

createInterface({ input: process.stdin }).on("line", (line) => {
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
      serverInfo: { name: "close", version: "1" },
    };
  } else if (request.method === "tools/list") {
    result = {
      tools: [
        {
          name: "write",
          inputSchema: { type: "object" },
          annotations: { idempotentHint: idempotent === "true" },
        },
      ],
    };
  } else if (request.method === "tools/call") {
    appendFileSync(marker, "committed\n");
    process.exit(0);
  } else {
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
