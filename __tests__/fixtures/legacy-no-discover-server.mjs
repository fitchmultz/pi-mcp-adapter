import readline from "node:readline";
import { appendFileSync } from "node:fs";
import { JSONRPCNotificationSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/core";

const pidsPath = process.env.MCP_HANDSHAKE_PIDS;
if (pidsPath !== undefined && pidsPath !== "") {
  appendFileSync(pidsPath, `${process.pid}\n`);
}

const lines = readline.createInterface({ input: process.stdin });

/** @param {number | string} id @param {unknown} result */
function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/** @param {number | string} id @param {string} message */
function reject(id, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message },
    })}\n`,
  );
}

lines.on("line", (line) => {
  /** @type {unknown} */
  const message = JSON.parse(line);
  const parsed = JSONRPCRequestSchema.loose().safeParse(message);
  if (!parsed.success) {
    JSONRPCNotificationSchema.loose().parse(message);
    return;
  }
  const request = parsed.data;
  if (request.method === "server/discover") {
    if (process.env.MCP_EXIT_ON_DISCOVER === "1") {
      process.exit(0);
    }
    reject(request.id, "server/discover is not supported");
    return;
  }
  if (request.method === "initialize") {
    const requestPath = process.env.MCP_HANDSHAKE_REQUEST;
    if (requestPath !== undefined && requestPath !== "") {
      appendFileSync(requestPath, JSON.stringify(request));
    }
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-no-discover", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "classic_initialize_reached",
          description: "Classic initialize completed",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  reject(request.id, "Method not found");
});
