import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadMcpConfig } from "../../config.ts";
import { McpServerManager } from "../../server-manager.ts";

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];
const handlerErrors: unknown[] = [];
const requestSchema = z.object({
  method: z.string(),
  id: z.union([z.string(), z.number()]).optional(),
});
const traceSchema = z.object({
  direction: z.string(),
  method: z.string().optional(),
  transport: z.string(),
});

async function readRequest(req: http.IncomingMessage): Promise<z.infer<typeof requestSchema>> {
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    if (typeof chunk !== "string") {
      throw new TypeError("Expected a UTF-8 request body");
    }
    body += chunk;
  }
  return requestSchema.parse(JSON.parse(body));
}

function handler(
  run: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): http.RequestListener {
  return (req, res) => {
    run(req, res).catch((error: unknown) => {
      handlerErrors.push(error);
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
}

async function withAuthStore(value: string, run: () => Promise<void>): Promise<void> {
  const previousStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = value;
  try {
    await run();
  } finally {
    if (previousStore === undefined) {
      delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    } else {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousStore;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  servers.length = 0;
  temporaryDirectories.length = 0;
  const errors = handlerErrors.splice(0);
  if (errors.length > 0) {
    throw new AggregateError(errors, "HTTP fixture handlers failed");
  }
});

describe("McpServerManager StreamableHTTP transport", () => {
  it.each([
    ["omitted", undefined],
    ["null", null],
  ])("connects an unauthenticated URL-only server with OAuth %s", async (_name, oauth) => {
    await withAuthStore("unavailable", async () => {
      const server = http.createServer(
        handler(async (req, res) => {
          if (req.method === "GET") {
            res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
            return;
          }

          const message = await readRequest(req);
          if (message.method === "server/discover") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
            return;
          }
          let result;
          if (message.method === "initialize") {
            result = {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "unauthenticated", version: "1.0.0" },
            };
          } else if (message.method === "tools/list") {
            result = { tools: [] };
          } else if (message.method === "resources/list") {
            result = { resources: [] };
          }

          if (result !== undefined) {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result,
              }),
            );
            return;
          }
          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          res.writeHead(500).end(`unexpected method: ${message.method}`);
        }),
      );
      servers.push(server);

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }

      const directory = await mkdtemp(join(tmpdir(), "pi-mcp-unauthenticated-"));
      temporaryDirectories.push(directory);
      const configPath = join(directory, "mcp.json");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            unauthenticated: { url: `http://127.0.0.1:${address.port}/mcp`, oauth },
          },
        }),
      );
      const definition = loadMcpConfig(configPath, directory).mcpServers.unauthenticated;
      expect(definition).toBeDefined();
      if (definition === undefined) {
        throw new Error("configured server not loaded");
      }
      const manager = new McpServerManager();
      const connection = await manager.connect("unauthenticated", definition);

      expect(connection.status).toBe("connected");
      await manager.close("unauthenticated");
    });
  });

  it("fails closed for explicit OAuth when secure storage is unavailable", async () => {
    await withAuthStore("unavailable", async () => {
      const server = http.createServer((_req, res) => {
        res
          .writeHead(401, {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
          })
          .end("Unauthorized");
      });
      servers.push(server);

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }

      const manager = new McpServerManager();
      await expect(
        manager.connect("oauth", {
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: "oauth",
        }),
      ).rejects.toThrow(/Failed to read OAuth credentials.*OS secure credential store/);
    });
  });

  it.each(["configured-path", "null-file", "null-command", "null-socket"])(
    "resolves command-backed HTTP secrets without falling back to SSE on GET 405 with %s tracing config",
    async (variant) => {
      const requests: string[] = [];
      const server = http.createServer(
        handler(async (req, res) => {
          requests.push(`${String(req.method)} ${String(req.url)}`);

          if (
            req.headers.authorization !== "Bearer command-token" ||
            req.headers["x-command-secret"] !== "command-header"
          ) {
            res.writeHead(401).end("Unauthorized");
            return;
          }

          if (req.method === "GET") {
            res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
            return;
          }

          if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
            return;
          }

          const message = await readRequest(req);
          if (message.method === "server/discover") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
            return;
          }

          if (message.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {}, resources: {} },
                  serverInfo: { name: "post-only", version: "1.0.0" },
                },
              }),
            );
            return;
          }

          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }

          if (message.method === "tools/list") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { tools: [] },
              }),
            );
            return;
          }

          if (message.method === "resources/list") {
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { resources: [] },
              }),
            );
            return;
          }

          res.writeHead(500).end(`unexpected method: ${message.method}`);
        }),
      );
      servers.push(server);

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }

      const traceDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-trace-"));
      temporaryDirectories.push(traceDirectory);
      const traces = join(traceDirectory, ".pi/fitch-mcp-adapter/traces");
      const configPath = join(traceDirectory, "mcp.json");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            "post-only": {
              url: `http://127.0.0.1:${address.port}/mcp`,
              auth: "bearer",
              bearerToken: `!node -e "process.stdout.write('command-token')"`,
              headers: {
                "X-Command-Secret": `!node -e "process.stdout.write('command-header')"`,
              },
              ...(variant === "null-command" ? { command: null } : {}),
              ...(variant === "null-socket" ? { socket: null } : {}),
            },
          },
          settings: {
            trace: {
              enabled: true,
              file: variant === "null-file" ? null : join(traces, "mcp.jsonl"),
            },
          },
        }),
      );
      const config = loadMcpConfig(configPath, traceDirectory);
      const definition = config.mcpServers["post-only"];
      assert.ok(definition);
      const manager = new McpServerManager(traceDirectory);
      manager.setTraceConfig(config.settings?.trace);
      try {
        const connection = await manager.connect("post-only", definition);

        for (let attempt = 0; attempt < 20 && !requests.includes("GET /mcp"); attempt++) {
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
        }

        expect(connection.status).toBe("connected");
        expect(connection.tools).toEqual([]);
        expect(connection.resources).toEqual([]);
        expect(requests).toContain("GET /mcp");
        // The SDK probes the optional GET stream once, then keeps the successful
        // POST-based session without an SSE fallback or retry storm.
        expect(requests.filter((request) => request === "GET /mcp")).toHaveLength(1);

        await manager.close("post-only");
        const files = await readdir(traces);
        expect(files).toHaveLength(1);
        const file = files[0];
        assert.ok(file !== undefined);
        const traceLines = (await readFile(join(traces, file), "utf8"))
          .trim()
          .split("\n")
          .map((line) => traceSchema.parse(JSON.parse(line)));
        expect(
          traceLines.filter(
            (event) => event.direction === "outbound" && event.method === "initialize",
          ),
        ).toHaveLength(1);
        expect(new Set(traceLines.map((event) => event.transport))).toEqual(
          new Set(["streamable-http"]),
        );
      } finally {
        await manager.close("post-only");
      }
    },
  );
});
