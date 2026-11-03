import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type ListResourcesResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { onTestFinished, vi } from "vitest";
import type { ServerConnection } from "../../server-manager.ts";
import type { ServerDefinition } from "../../types.ts";
import { asObjectRecord } from "../../mcp-output-values.ts";
import { createTestState } from "../test-state.ts";
import { buildToolMetadata } from "../../tool-metadata.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  machineResult,
  readMachineBody,
} from "./oauth-machine-wire.ts";

export function firstText(result: Pick<AgentToolResult<unknown>, "content">): string {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text;
}
export function parsedRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  const record = asObjectRecord(value);
  assert.ok(record);
  return record;
}
export async function proxyRuntimeConnection(
  definition: ServerDefinition,
  name = "search",
): Promise<ServerConnection> {
  const server = new McpServer({ name: "proxy-runtime-fixture", version: "1" });
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler("tools/list", () => ({
    tools: [{ name, inputSchema: { type: "object" } }],
  }));
  server.server.setRequestHandler("tools/call", (): CallToolResult => ({
    content: [{ type: "text", text: "demo result" }],
  }));
  const client = new Client({ name: "proxy-runtime-test", version: "1" });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(transport);
  return {
    client,
    transport,
    definition,
    tools: (await client.listTools()).tools,
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  };
}

export async function proxyRuntimeState({
  name = "tool",
  description = name,
  result: initialResult = { content: [{ type: "text", text: "called" }] },
  listResources,
  readResource,
  uiResourceUri,
  signal,
}: {
  name?: string;
  description?: string;
  result?: CallToolResult;
  listResources?: () => ListResourcesResult | Promise<ListResourcesResult>;
  readResource?: () => ReadResourceResult | Promise<ReadResourceResult>;
  signal?: AbortSignal;
  uiResourceUri?: string;
} = {}): Promise<{
  state: ReturnType<typeof createTestState>;
  connection: ServerConnection;
  setResult: (result: CallToolResult) => void;
}> {
  let result = initialResult;
  const server = new MachineHttpServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    let payload: unknown;
    switch (message.method) {
      case "initialize":
        response.setHeader("Mcp-Session-Id", "proxy-fixture");
        payload = {
          ...machineResult(message.method, "proxy-runtime-state", ""),
          capabilities: { tools: {}, ...(listResources || readResource ? { resources: {} } : {}) },
        };
        break;
      case "tools/list":
        payload = {
          tools: [
            {
              name,
              description,
              inputSchema: { type: "object" },
              ...((uiResourceUri ?? "").length > 0
                ? { _meta: { ui: { resourceUri: uiResourceUri } } }
                : {}),
            },
          ],
        };
        break;
      case "resources/list":
        payload = listResources ? await listResources() : { resources: [] };
        break;
      case "resources/read":
        payload = readResource ? await readResource() : { contents: [] };
        break;
      case "tools/call":
        payload = result;
        break;
      default:
        throw new Error(`Unexpected fixture method: ${message.method}`);
    }
    machineJson(response, { jsonrpc: "2.0", id: message.id, result: payload });
  });
  const origin = await server.listen();
  const definition = {
    url: `${origin}/mcp`,
    auth: false as const,
    protocolVersion: "legacy" as const,
  };
  const state = createTestState({
    config: { mcpServers: { demo: definition }, settings: {} },
  });
  onTestFinished(async () => {
    await state.owner.stop();
    await state.manager.closeAll();
    await server.close();
    vi.restoreAllMocks();
  });
  await state.manager.connect("demo", definition, signal);
  const connection = state.manager.getConnection("demo");
  assert.ok(connection);
  state.toolMetadata.set(
    "demo",
    buildToolMetadata({
      tools: connection.tools,
      resources: [],
      definition,
      serverName: "demo",
      prefix: "server",
    }).metadata,
  );
  return {
    state,
    connection,
    setResult: (next) => {
      result = next;
    },
  };
}
