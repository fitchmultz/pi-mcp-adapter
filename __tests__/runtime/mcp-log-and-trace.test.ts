import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, InMemoryTransport, type MessageExtraInfo } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { MAX_MCP_LOG_BYTES, McpServerLog, getDefaultMcpLogPath } from "../../mcp-log.ts";
import {
  McpTraceWriter,
  createMcpTraceWriter,
  type McpTraceEvent,
  wrapTransportWithMcpTrace,
} from "../../mcp-trace.ts";
import { createTestState } from "../test-state.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

describe("MCP server logging (mcp.log) and trace telemetry (mcp-trace)", () => {
  it("writes server notifications/message entries to <agentDir>/mcp.log via real SDK transport", async () => {
    const agentDir = await makeTempDir("pi-mcp-log-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const server = new McpServer(
      { name: "log-demo", version: "1" },
      { capabilities: { logging: {} } },
    );
    server.registerTool("ping", { inputSchema: z.object({}) }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const state = createTestState({
      config: { mcpServers: { demo: { url: "https://unused.invalid/mcp", auth: false } } },
    });
    onTestFinished(async () => {
      await state.owner.stop();
      await state.manager.closeAll();
      await server.close();
    });

    const connectSpy = vi.spyOn(Client.prototype, "connect").mockImplementation(function (
      this: Client,
      _transport,
      options,
    ) {
      connectSpy.mockRestore();
      return this.connect(clientTransport, options);
    });
    await state.manager.connect("demo", { url: "https://unused.invalid/mcp", auth: false });
    connectSpy.mockRestore();

    await server.server.notification({
      method: "notifications/message",
      params: {
        level: "warning",
        logger: "db",
        data: "slow query\nline two",
      },
    });
    await server.server.notification({
      method: "notifications/message",
      params: {
        level: "error",
        data: { code: 42 },
      },
    });

    const expectedPath = join(agentDir, "mcp.log");
    expect(getDefaultMcpLogPath()).toBe(expectedPath);
    await vi.waitFor(() => {
      expect(existsSync(expectedPath)).toBe(true);
      const contents = readFileSync(expectedPath, "utf8");
      expect(contents).toContain("[demo] warning db: slow query\n    line two");
      expect(contents).toContain('[demo] error {"code":42}');
    });
  });

  it("rotates mcp.log to mcp.log.1 once it reaches MAX_MCP_LOG_BYTES", async () => {
    const agentDir = await makeTempDir("pi-mcp-log-rotate-");
    const logPath = join(agentDir, "mcp.log");
    writeFileSync(logPath, Buffer.alloc(MAX_MCP_LOG_BYTES + 16, 0x78));

    const writer = new McpServerLog(logPath);
    writer.write("alpha", { level: "info", data: "after-rotation" });

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(MAX_MCP_LOG_BYTES + 16);
    expect(readFileSync(logPath, "utf8")).toContain("[alpha] info after-rotation");
  });

  it("measures real RPC round-trip durationMs, propagates relatedRequestId, and keeps string IDs", async () => {
    const server = new McpServer(
      { name: "trace-timing", version: "1" },
      { capabilities: { prompts: {} } },
    );
    server.registerTool("slow", { inputSchema: z.object({}) }, async () => {
      await delay(30);
      return { content: [{ type: "text", text: "done" }] };
    });
    server.server.setRequestHandler("prompts/get", async () => {
      await delay(30);
      throw new Error("boom");
    });

    const events: McpTraceEvent[] = [];
    const client = new Client({ name: "trace-client", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const wrapped = wrapTransportWithMcpTrace(clientTransport, "timed", "stdio", {
      record: (event) => events.push(event),
    });
    await client.connect(wrapped);

    const result = await client.callTool({ name: "slow", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);

    const callReq = events.find(
      (e) => e.direction === "outbound" && e.kind === "request" && e.method === "tools/call",
    );
    const callRes = events.find(
      (e) => e.direction === "inbound" && e.kind === "response" && e.id === callReq?.id,
    );
    expect(callReq).toBeDefined();
    expect(callReq?.durationMs).toBeUndefined();
    expect(callRes).toBeDefined();
    expect(callRes?.durationMs).toBeGreaterThanOrEqual(20);

    await expect(client.getPrompt({ name: "missing" })).rejects.toThrow("boom");
    const errRes = events.find(
      (e) => e.direction === "inbound" && e.kind === "response" && e.status === "error",
    );
    expect(errRes?.durationMs).toBeGreaterThanOrEqual(20);

    // String JSON-RPC ID and explicit relatedRequestId propagation across send and onmessage.
    const pair = InMemoryTransport.createLinkedPair();
    const standaloneEvents: McpTraceEvent[] = [];
    const standalone = wrapTransportWithMcpTrace(pair[0], "standalone", "stdio", {
      record: (event) => standaloneEvents.push(event),
    });
    Reflect.set(standalone, "onmessage", () => {
      // No-op test handler to verify trace observation without Protocol auto-reply.
    });
    const inboundExtra: MessageExtraInfo = Object.assign(
      { request: new Request("https://unused.invalid/mcp") } satisfies MessageExtraInfo,
      { relatedRequestId: "parent-req-1" },
    );
    standalone.onmessage?.(
      { jsonrpc: "2.0", id: "srv-req-77", method: "sampling/createMessage", params: {} },
      inboundExtra,
    );
    const serverInbound = standaloneEvents.find(
      (e) => e.direction === "inbound" && e.id === "srv-req-77",
    );
    expect(serverInbound?.relatedRequestId).toBe("parent-req-1");
    expect(JSON.stringify(serverInbound)).not.toContain("[REDACTED_ID]");

    await delay(20);
    await standalone.send(
      { jsonrpc: "2.0", id: "srv-req-77", result: {} },
      { relatedRequestId: "srv-req-77" },
    );
    const serverOutbound = standaloneEvents.find(
      (e) => e.direction === "outbound" && e.id === "srv-req-77",
    );
    expect(serverOutbound?.relatedRequestId).toBe("srv-req-77");
    expect(serverOutbound?.durationMs).toBeGreaterThanOrEqual(15);
    await pair[0].close();
    await pair[1].close();
  });

  it("appends without truncating existing events when concurrent sessions share explicit trace.file", async () => {
    const dir = await makeTempDir("pi-mcp-trace-shared-");
    const explicitFile = join(dir, "shared-trace.jsonl");
    await writeFile(explicitFile, "", "utf8");

    const writerOne = createMcpTraceWriter(dir, { enabled: true, file: explicitFile });
    writerOne.write({
      version: 1,
      timestamp: new Date().toISOString(),
      direction: "outbound",
      server: "s1",
      transport: "stdio",
      kind: "notification",
      status: "sent",
      method: "notifications/initialized",
    });
    await writerOne.flush(true);

    const writerTwo = createMcpTraceWriter(dir, { enabled: true, file: explicitFile });
    writerTwo.write({
      version: 1,
      timestamp: new Date().toISOString(),
      direction: "inbound",
      server: "s2",
      transport: "stdio",
      kind: "notification",
      status: "received",
      method: "notifications/tools/list_changed",
    });
    await writerTwo.flush(true);

    const lines = (await readFile(explicitFile, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ server: "s1" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ server: "s2" });

    // Direct McpTraceWriter default also avoids truncation unless explicitly requested.
    const defaultNoTruncate = new McpTraceWriter({ filePath: explicitFile });
    await defaultNoTruncate.flush(true);
    expect((await readFile(explicitFile, "utf8")).trim().split("\n")).toHaveLength(2);

    // Pre-existing over-budget explicit trace file rotates to .1 instead of going permanently dark.
    const cappedFile = join(dir, "capped-trace.jsonl");
    const priorContent = `${"x".repeat(400)}\n`;
    await writeFile(cappedFile, priorContent, "utf8");
    const rotatedWriter = createMcpTraceWriter(dir, {
      enabled: true,
      file: cappedFile,
      maxBytes: 256,
    });
    rotatedWriter.write({
      version: 1,
      timestamp: new Date().toISOString(),
      direction: "outbound",
      server: "fresh",
      transport: "stdio",
      kind: "notification",
      status: "sent",
      method: "notifications/initialized",
    });
    await rotatedWriter.flush(true);
    expect(rotatedWriter.isDisabled).toBe(false);
    expect(rotatedWriter.stats.events).toBe(1);
    expect(await readFile(`${cappedFile}.1`, "utf8")).toBe(priorContent);
    const rotatedLines = (await readFile(cappedFile, "utf8")).trim().split("\n");
    expect(rotatedLines).toHaveLength(1);
    expect(JSON.parse(rotatedLines[0] ?? "{}")).toMatchObject({ server: "fresh" });
  });
});
