import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { ServerDefinition } from "../../types.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  readMachineBody,
} from "./oauth-machine-wire.ts";

/** Legacy HTTP handshake/discovery with explicit wire holds for manager races. */
export async function createManagerBoundaryHttp(
  options: {
    holdInitialize?: boolean;
  } = {},
): Promise<{
  definition: ServerDefinition;
  requests: readonly { method: string | undefined; url: string | undefined }[];
  initializes: () => number;
  initializeStarted: Promise<null>;
  release: () => void;
  close: () => Promise<void>;
}> {
  const initializeStarted = Promise.withResolvers<null>();
  const pending: Array<() => void> = [];
  let initializes = 0;
  let hold = options.holdInitialize === true;
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  function reply(response: ServerResponse, id: string | number, result: unknown): void {
    machineJson(response, { jsonrpc: "2.0", id, result });
  }
  const http = new MachineHttpServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    switch (message.method) {
      case "initialize": {
        initializes++;
        initializeStarted.resolve(null);
        const finish = () => {
          reply(response, message.id, {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "manager-boundary", version: "1" },
          });
        };
        if (hold) {
          pending.push(finish);
        } else {
          finish();
        }
        return;
      }
      case "tools/list":
        reply(response, message.id, { tools: [] });
        return;
      case "resources/list":
        reply(response, message.id, { resources: [] });
        return;
      default:
        assert.fail(`Unexpected manager fixture request: ${message.method}`);
    }
  });
  const origin = await http.listen();
  return {
    definition: { url: `${origin}/mcp`, auth: false, protocolVersion: "legacy" },
    requests,
    initializes: () => initializes,
    initializeStarted: initializeStarted.promise,
    release: () => {
      hold = false;
      for (const finish of pending.splice(0)) {
        finish();
      }
    },
    close: () => http.close(),
  };
}
