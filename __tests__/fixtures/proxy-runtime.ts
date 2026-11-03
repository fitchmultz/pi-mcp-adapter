import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { onTestFinished } from "vitest";
import type { ServerConnection } from "../../server-manager.ts";
import type { ServerDefinition } from "../../types.ts";
import { asObjectRecord } from "../../mcp-output-values.ts";

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
