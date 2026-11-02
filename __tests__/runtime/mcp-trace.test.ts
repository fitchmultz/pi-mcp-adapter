import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createMcpTraceEvent,
  isMcpTraceEnabled,
  McpTraceWriter,
  type McpTraceWriterOptions,
  type McpTraceObserver,
  wrapTransportWithMcpTrace,
} from "../../mcp-trace.ts";
import type { ServerDefinition } from "../../types.ts";

async function tracePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-trace-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "trace.jsonl");
}

async function observedClient(observer: McpTraceObserver) {
  const server = new McpServer({ name: "traced-server", version: "1" });
  const received: string[] = [];
  server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, ({ text }) => {
    received.push(text);
    return { content: [{ type: "text", text }] };
  });
  const client = new Client({ name: "traced-client", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(wrapTransportWithMcpTrace(clientTransport, "demo", "unknown", observer));
  return { client, received };
}

describe("MCP protocol tracing", () => {
  it("is disabled unless global or per-server tracing is explicitly enabled", () => {
    const debugDefinition: ServerDefinition = { command: "node", debug: true };
    expect(isMcpTraceEnabled({})).toBe(false);
    expect(isMcpTraceEnabled(debugDefinition)).toBe(false);
    expect(isMcpTraceEnabled({ trace: false }, { enabled: true })).toBe(false);
    expect(isMcpTraceEnabled({}, { enabled: true })).toBe(true);
    expect(isMcpTraceEnabled({ trace: true })).toBe(true);
  });

  it("writes a metadata-only event with redacted identifiers and no payload", () => {
    const event = createMcpTraceEvent({
      direction: "outbound",
      server: "server https://user:secret@example.test/mcp",
      transport: "streamable-http",
      message: {
        jsonrpc: "2.0",
        id: "request-secret-token",
        method: "tools/call",
        params: { name: "private", arguments: { token: "do-not-write" } },
      },
      status: "sent",
    });

    expect(event).toMatchObject({
      version: 1,
      direction: "outbound",
      transport: "streamable-http",
      kind: "request",
      method: "tools/call",
      status: "sent",
    });
    expect(JSON.stringify(event)).not.toContain("do-not-write");
    expect(JSON.stringify(event)).not.toContain("example.test");
    expect(JSON.stringify(event)).not.toContain("request-secret-token");
    expect(event).not.toHaveProperty("params");

    const sensitiveMetadata = createMcpTraceEvent({
      direction: "inbound",
      server: "server ftp://example.test/mcp file:///private/path",
      transport: "streamable-http",
      message: { jsonrpc: "2.0", id: "opaque-sensitive-id", result: {} },
      status: "received",
      relatedRequestId: "request-without-a-keyword",
    });
    expect(sensitiveMetadata.id).toBe("[REDACTED_ID]");
    expect(sensitiveMetadata.relatedRequestId).toBe("[REDACTED_ID]");
    expect(JSON.stringify(sensitiveMetadata)).not.toContain("example.test");
    expect(JSON.stringify(sensitiveMetadata)).not.toContain("private/path");
  });

  it("resets a reused destination before appending new events", async () => {
    const filePath = await tracePath();
    await writeFile(filePath, "previous session\n", "utf8");
    const writer = new McpTraceWriter({ filePath });
    const event = createMcpTraceEvent({
      direction: "inbound",
      server: "s",
      transport: "stdio",
      message: { jsonrpc: "2.0", method: "notifications/ping", params: {} },
      status: "received",
    });
    writer.write(event);
    await writer.flush(true);
    expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify(event)}\n`);
  });

  it("bounds metadata strings and rejects events over the file limit", async () => {
    const filePath = await tracePath();
    const append = vi.fn<NonNullable<McpTraceWriterOptions["appendFile"]>>().mockResolvedValue();
    const writer = new McpTraceWriter({ filePath, maxBytes: 20, maxEvents: 2, appendFile: append });
    writer.write(
      createMcpTraceEvent({
        direction: "inbound",
        server: "s",
        transport: "stdio",
        message: { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} },
        status: "received",
      }),
    );
    await writer.flush(true);
    expect(append).not.toHaveBeenCalled();
    expect(await readFile(filePath, "utf8")).toBe("");
    expect(writer.stats.events).toBe(0);
    expect(writer.isDisabled).toBe(true);
  });

  it("isolates writer failures, preserves callbacks and rethrows the original strict-flush error", async () => {
    const failure = new Error("disk full");
    const append = vi
      .fn<NonNullable<McpTraceWriterOptions["appendFile"]>>()
      .mockRejectedValue(failure);
    const writer = new McpTraceWriter({ filePath: await tracePath(), appendFile: append });
    const { client, received } = await observedClient({
      record: (event) => writer.write(event),
    });
    const result = await client.callTool({ name: "echo", arguments: { text: "still connected" } });
    await writer.flush();

    expect(received).toEqual(["still connected"]);
    expect(result.content).toEqual([{ type: "text", text: "still connected" }]);
    expect(writer.isDisabled).toBe(true);
    await expect(writer.flush(true)).rejects.toBe(failure);
  });

  it("does not let a throwing observer break transport callbacks", async () => {
    const { client, received } = await observedClient({
      record: () => {
        throw new Error("trace failure");
      },
    });
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "observer survived" },
    });
    expect(received).toEqual(["observer survived"]);
    expect(result.content).toEqual([{ type: "text", text: "observer survived" }]);
  });
});
