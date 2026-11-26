import { CallToolRequestSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(line: string): Promise<void> {
  const input: unknown = JSON.parse(line);
  const request = JSONRPCMessageSchema.parse(input);
  if (!("id" in request) || !("method" in request)) {
    return;
  }
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-progress", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          { name: "slow_stdio", description: "Slow stdio tool", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const call = CallToolRequestSchema.parse(request);
    const token = call.params._meta?.progressToken;
    for (let step = 1; step <= 4; step += 1) {
      await delay(70);
      if (token !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: step,
            total: 4,
            message: `Stdio step ${step}/4`,
          },
        });
      }
    }
    await delay(30);
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "stdio progress ok" }] },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  handle(line).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});
