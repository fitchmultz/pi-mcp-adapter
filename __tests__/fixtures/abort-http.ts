import assert from "node:assert/strict";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { ServerDefinition } from "../../types.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  readMachineBody,
  type MachineMessage,
} from "./oauth-machine-wire.ts";

/** Real legacy HTTP requests can remain unanswered until cancellation or release. */
export async function createAbortHttp(hold?: string): Promise<{
  definition: ServerDefinition;
  messages: MachineMessage[];
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
  entered: Promise<null>;
  release: () => void;
  close: () => Promise<void>;
}> {
  let held = hold;
  const entered = Promise.withResolvers<null>();
  const messages: MachineMessage[] = [];
  const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const pending: Array<() => void> = [];
  const http = new MachineHttpServer(async (request, response) => {
    requests.push({ url: `${http.origin}${request.url ?? ""}`, headers: { ...request.headers } });
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    messages.push(message);
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    const result = responseResult(message.method);
    const finish = () => reply(response, message.id, result);
    if (message.method === held) {
      pending.push(finish);
      entered.resolve(null);
    } else {
      finish();
    }
  });
  const origin = await http.listen();
  return {
    definition: { url: `${origin}/mcp`, auth: false, protocolVersion: "legacy" },
    messages,
    requests,
    entered: entered.promise,
    release: () => {
      held = undefined;
      for (const finish of pending.splice(0)) {
        finish();
      }
    },
    close: () => http.close(),
  };
}

function reply(response: ServerResponse, id: string | number, result: unknown): void {
  machineJson(response, { jsonrpc: "2.0", id, result });
}

function responseResult(method: string): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, logging: {} },
        serverInfo: { name: "abort-boundary", version: "1" },
      };
    case "tools/list":
      return {
        tools: [{ name: "slow", description: "Slow tool", inputSchema: { type: "object" } }],
      };
    case "resources/list":
      return { resources: [{ uri: "resource://demo", name: "demo" }] };
    case "resources/read":
      return { contents: [{ uri: "resource://demo", text: "resource bytes" }] };
    case "tools/call":
      return { content: [{ type: "text", text: "released" }] };
    case "logging/setLevel":
      return {};
    default:
      assert.fail(`Unexpected abort fixture method: ${method}`);
  }
}
