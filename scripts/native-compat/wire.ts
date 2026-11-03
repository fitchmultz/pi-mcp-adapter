import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { CallToolRequestSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { z } from "zod";

const argumentsSchema = z.object({ value: z.string() });
const schema = z.toJSONSchema(argumentsSchema);
export const instructions = "Complete native namespace instructions. ".repeat(100);

export class WireFixture {
  readonly effects: unknown[] = [];
  private held: ServerResponse | undefined;
  private readonly hold: PromiseWithResolvers<void> = Promise.withResolvers();
  readonly started = this.hold.promise;
  private readonly server = createServer((request, response) => {
    this.serve(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert.ok(address !== null && typeof address === "object", "compat server must report a port");
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  private call(message: unknown, response: ServerResponse): unknown {
    const call = CallToolRequestSchema.parse(message);
    const { value } = argumentsSchema.parse(call.params.arguments);
    this.effects.push(value);
    if (value === "hold") {
      this.held = response;
      this.hold.resolve();
      return undefined;
    }
    return {
      resultType: "complete",
      content: [{ type: "text", text: `Human ${value}` }],
      structuredContent: { value },
      _meta: { private: "SYNTHETIC-SECRET" },
      ...(value === "fail" ? { isError: true } : {}),
    };
  }

  private result(method: string): unknown {
    switch (method) {
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          instructions,
        };
      case "initialize":
        return {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
          instructions,
        };
      case "tools/list":
        return {
          resultType: "complete",
          ttlMs: 1000,
          cacheScope: "private",
          tools: [
            {
              name: "echo",
              description: "Fixture echo",
              inputSchema: schema,
              outputSchema: schema,
              annotations: { readOnlyHint: true },
            },
            {
              name: "app_only",
              description: "Not model-callable",
              inputSchema: schema,
              _meta: { ui: { visibility: ["app"] } },
            },
          ],
        };
      case "resources/list":
        return { resultType: "complete", resources: [] };
      default:
        return { resultType: "complete" };
    }
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const message = JSONRPCMessageSchema.parse(JSON.parse(await text(request)));
    assert.ok("method" in message, "native client sends requests or notifications");
    if (message.method.startsWith("notifications/")) {
      response.writeHead(202).end();
      return;
    }
    assert.ok("id" in message, "native request must have an id");
    const result =
      message.method === "tools/call" ? this.call(message, response) : this.result(message.method);
    if (result === undefined) {
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }

  finishHeld(): void {
    this.held?.end();
  }

  async close(): Promise<void> {
    this.finishHeld();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}
