import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { vi } from "vitest";
import { McpServerManager } from "../../server-manager.ts";
import type {
  McpTool,
  ServerDefinition,
  ServerStreamResultPatchNotification,
} from "../../types.ts";

/** Stateful HTTP peer for native session recovery and server notification delivery. */
export class UiBoundaryWire {
  origin = "";
  session = 0;
  expired = false;
  toolError = false;
  resultText = "tool result";
  tools: McpTool[] = [{ name: "some_tool", inputSchema: { type: "object" } }];
  resourceResult: unknown = {
    contents: [{ uri: "ui://test/widget", mimeType: "text/html", text: "<h1>Recovered</h1>" }],
  };
  readonly calls: Array<{ method: string; session: string | undefined }> = [];
  private stream: ServerResponse | undefined;
  private readonly errors: unknown[] = [];
  private readonly server = createServer((req, res) => {
    this.receive(req, res).catch((error: unknown) => {
      this.errors.push(error);
      res.destroy();
    });
  });

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert(address !== null && typeof address !== "string");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  definition(): ServerDefinition {
    return {
      url: `${this.origin}/mcp`,
      protocolVersion: "legacy",
      auth: "bearer",
      bearerToken: "fixture-token",
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    assert.deepEqual(this.errors, [], "UI peer failed to handle a request");
  }

  async notify(notification: ServerStreamResultPatchNotification): Promise<void> {
    await vi.waitFor(() => assert(this.stream !== undefined));
    assert(this.stream !== undefined);
    this.stream.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...notification })}\n\n`,
    );
  }

  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      this.stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    const message = JSONRPCMessageSchema.parse(JSON.parse(await text(req)));
    assert("method" in message);
    if (!("id" in message)) {
      res.writeHead(202).end();
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    assert(sessionHeader === undefined || typeof sessionHeader === "string");
    this.calls.push({ method: message.method, session: sessionHeader });
    if (message.method === "initialize") {
      this.session += 1;
      this.expired = false;
      this.reply(
        res,
        message.id,
        {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "ui-boundary-peer", version: "1" },
        },
        { "mcp-session-id": `session-${this.session}` },
      );
      return;
    }
    if (this.expired && (message.method === "tools/call" || message.method === "resources/read")) {
      res.writeHead(404).end("Session not found");
      return;
    }
    switch (message.method) {
      case "tools/list":
        this.reply(res, message.id, { tools: this.tools });
        return;
      case "resources/list":
        this.reply(res, message.id, { resources: [] });
        return;
      case "resources/read":
        this.reply(res, message.id, this.resourceResult);
        return;
      case "tools/call":
        if (this.toolError) {
          res.writeHead(500).end("MCP server error");
        } else {
          this.reply(res, message.id, { content: [{ type: "text", text: this.resultText }] });
        }
        return;
      default:
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
    }
  }

  private reply(
    res: ServerResponse,
    id: string | number,
    result: unknown,
    headers: Record<string, string> = {},
  ): void {
    res
      .writeHead(200, { "content-type": "application/json", ...headers })
      .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
}

export async function connectUiBoundaryWire(
  wire: UiBoundaryWire,
  name = "test-server",
): Promise<McpServerManager> {
  await wire.listen();
  const manager = new McpServerManager();
  const connection = await manager.connect(name, wire.definition());
  assert.equal(connection.status, "connected");
  return manager;
}
