import assert from "node:assert/strict";
import { McpServerManager } from "../../server-manager.ts";
import { createOAuthRuntime, shutdownOAuth } from "../../mcp-auth-flow.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  readMachineBody,
} from "./oauth-machine-wire.ts";

let uncaught = 0;
process.on("uncaughtException", () => {
  uncaught += 1;
});
let entered!: () => void;
const started = new Promise<void>((resolve) => {
  entered = resolve;
});
const server = new MachineHttpServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
  if (message.method === "tools/call") {
    entered();
    return;
  }
  if (message.method.startsWith("notifications/")) {
    response.writeHead(202).end();
    return;
  }
  assert("id" in message);
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy", version: "1" },
        }
      : { tools: [{ name: "hold", inputSchema: { type: "object" } }] };
  machineJson(response, { jsonrpc: "2.0", id: message.id, result });
});
const url = `${await server.listen()}/mcp`;
const runtime = createOAuthRuntime();
const manager = new McpServerManager();
manager.setOAuthRuntime(runtime);
const connection = await manager.connect("legacy", {
  url,
  auth: "oauth",
  protocolVersion: "legacy",
  oauth: {
    clientId: "mcp",
    crossAppAccess: { idpUrl: url, clientId: "idp", idToken: "unused" },
  },
});
const controller = new AbortController();
const pending = connection.client
  .callTool({ name: "hold" }, { signal: controller.signal })
  .catch((error: unknown) => error);
await started;
await shutdownOAuth(runtime);
controller.abort();
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
await manager.closeAll();
assert((await pending) instanceof Error, "Expected the cancelled native call to reject");
await server.close();
console.log(JSON.stringify({ uncaught }));
process.exitCode = uncaught === 0 ? 0 : 1;
