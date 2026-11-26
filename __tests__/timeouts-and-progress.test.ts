import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { McpServerManager } from "../server-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeGateway } from "../host-gateway.ts";
import { executeCall } from "../proxy-modes.ts";
import { executeResourceRead } from "../resource-tools.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import type * as Auth from "../mcp-auth-flow.ts";

const authMocks = vi.hoisted(() => ({ authenticate: vi.fn<typeof Auth.authenticate>() }));
vi.mock("../mcp-auth-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Auth>()),
  authenticate: authMocks.authenticate,
}));

const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  initTheme();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

const wireBodySchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z
    .object({
      name: z.string().optional(),
      uri: z.string().optional(),
      _meta: z
        .object({
          progressToken: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
      inputResponses: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

type WireRequest = z.infer<typeof wireBodySchema>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const value: unknown = chunk;
    assert(Buffer.isBuffer(value));
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function writeSseEvent(res: ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function updateTexts(updates: Array<AgentToolResult<Record<string, unknown>>>): string[] {
  return updates.map((entry) => {
    const first = entry.content[0];
    assert(first?.type === "text");
    return first.text;
  });
}

async function startModernServer(
  onRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    body: WireRequest,
  ) => Promise<boolean> | boolean,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(req.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const raw = await readBody(req);
      const body = wireBodySchema.parse(raw.length === 0 ? {} : JSON.parse(raw));
      if (await onRequest(req, res, body)) {
        return;
      }
      if (body.method === "server/discover") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {}, resources: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "timeout-progress-fixture",
                version: "1.0.0",
              },
            },
          },
        });
        return;
      }
      if (body.method === "tools/list") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            tools: [
              {
                name: "slow_work",
                description: "Long tool with progress",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
              {
                name: "mutate_and_hang",
                description: "Mutating tool that stalls",
                inputSchema: { type: "object" },
              },
            ],
          },
        });
        return;
      }
      if (body.method === "resources/list") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            resources: [{ uri: "report://slow", name: "slow_report", description: "Slow report" }],
          },
        });
        return;
      }
      if (body.method === "prompts/list") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            prompts: [],
          },
        });
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  cleanups.push(close);
  return { url: `http://127.0.0.1:${address.port}/mcp`, close };
}

describe("MCP request timeouts and progress streaming (MCP-205)", () => {
  it.each(["direct", "proxy"] as const)(
    "resets SDK timeout across the timer boundary on notifications/progress and streams sanitized %s updates",
    async (entry) => {
      const server = await startModernServer(async (_req, res, body) => {
        if (body.method !== "tools/call") {
          return false;
        }
        const token = body.params?._meta?.progressToken;
        assert(token !== undefined, "expected SDK progressToken on request _meta");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const steps = [
          { progress: 1, total: 4, message: "Step 1\n\x1b[31mstyled\x1b[0m\r\nline" },
          { progress: 2, total: 4 },
          { progress: 3, total: 4, message: "   \n\t  " },
          { progress: 4, total: 4, message: "Finalizing" },
        ];
        for (const step of steps) {
          await delay(70);
          writeSseEvent(res, {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: token, ...step },
          });
        }
        await delay(40);
        writeSseEvent(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "finished after progress" }],
          },
        });
        res.end();
        return true;
      });

      const manager = new McpServerManager();
      cleanups.push(() => manager.closeAll());
      const definition = {
        url: server.url,
        auth: false as const,
        requestTimeoutMs: 130,
      };
      const state = createTestState({
        manager,
        config: { mcpServers: { worker: definition }, settings: { toolPrefix: "server" } },
        toolMetadata: new Map([
          [
            "worker",
            [
              {
                name: "worker_slow_work",
                originalName: "slow_work",
                description: "Long tool with progress",
                inputSchema: { type: "object" },
              },
            ],
          ],
        ]),
      });

      const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
      const onUpdate = (partial: AgentToolResult<Record<string, unknown>>) => {
        updates.push(partial);
      };
      const startedAt = performance.now();

      let output: AgentToolResult<Record<string, unknown>>;
      if (entry === "direct") {
        const host = await createTestExtensionContext();
        cleanups.push(host.dispose);
        const execute = createDirectToolExecutor(
          () => state,
          () => null,
          {
            serverName: "worker",
            originalName: "slow_work",
            prefixedName: "worker_slow_work",
            description: "Long tool with progress",
          },
        );
        output = await execute(
          "call-progress",
          {},
          undefined,
          onUpdate,
          host.runner.createToolContext("call-progress", state.owner.signal),
        );
      } else {
        output = await executeCall(state, {
          toolName: "worker_slow_work",
          args: {},
          onUpdate,
        });
      }

      const elapsedMs = performance.now() - startedAt;
      // Cross the 130ms requestTimeoutMs boundary (~320ms total across 4 progress ticks).
      expect(elapsedMs).toBeGreaterThanOrEqual(260);
      expect(output.details.error).toBeUndefined();
      const first = output.content[0];
      assert(first?.type === "text");
      expect(first.text).toBe("finished after progress");
      expect(updateTexts(updates)).toEqual([
        "Connecting to worker…",
        "Step 1 styled line",
        "Progress 2/4",
        "Progress 3/4",
        "Finalizing",
      ]);
      expect(updates[0]?.details).toEqual({ server: "worker" });
      for (const progressUpdate of updates.slice(1)) {
        expect(progressUpdate.details).toEqual({ server: "worker", tool: "slow_work" });
      }
    },
  );

  it("streams notifications/progress and resets timeout for resource reads across the timer boundary", async () => {
    const server = await startModernServer(async (_req, res, body) => {
      if (body.method !== "resources/read") {
        return false;
      }
      const token = body.params?._meta?.progressToken;
      assert(token !== undefined);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let step = 1; step <= 3; step += 1) {
        await delay(70);
        writeSseEvent(res, {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: step, total: 3, message: `Reading ${step}/3` },
        });
      }
      await delay(30);
      writeSseEvent(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          ttlMs: 60_000,
          cacheScope: "private",
          contents: [{ uri: "report://slow", text: "complete report body" }],
        },
      });
      res.end();
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = { url: server.url, auth: false as const, requestTimeoutMs: 120 };
    const connection = await manager.connect("reports", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { reports: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "reports",
          buildToolMetadata({
            tools: connection.tools,
            resources: connection.resources,
            definition,
            serverName: "reports",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const startedAt = performance.now();
    const output = await executeResourceRead(state, {
      server: "reports",
      uri: "report://slow",
      onUpdate: (partial) => updates.push(partial),
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toContain("complete report body");
    expect(updateTexts(updates)).toEqual(["Reading 1/3", "Reading 2/3", "Reading 3/3"]);
  });

  it("does not abort post-expiry auto-auth when auth exceeds a short requestTimeoutMs and emits auth/connect updates", async () => {
    let sessions = 0;
    let authorized = false;
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST") {
          res.writeHead(req.method === "DELETE" ? 200 : 405).end();
          return;
        }
        const raw = await readBody(req);
        const body = wireBodySchema.parse(raw.length === 0 ? {} : JSON.parse(raw));
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        if (body.method === "initialize") {
          if (!authorized && sessions > 0) {
            res
              .writeHead(401, {
                "www-authenticate": 'Bearer realm="mcp"',
              })
              .end();
            return;
          }
          res.setHeader("Mcp-Session-Id", `session-${++sessions}`);
          sendJson(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "auth-fixture", version: "1.0.0" },
            },
          });
          return;
        }
        if (body.method === "tools/list") {
          sendJson(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
            },
          });
          return;
        }
        if (body.method === "tools/call") {
          if (!authorized) {
            sendJson(res, { error: "expired" }, 404);
            return;
          }
          sendJson(res, {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "authenticated ok" }] },
          });
          return;
        }
        sendJson(res, { jsonrpc: "2.0", id: body.id, result: { resources: [], prompts: [] } });
      })().catch(() => {
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    const host = await createTestExtensionContext();
    cleanups.push(host.dispose);
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const initialDef = {
      url,
      protocolVersion: "legacy" as const,
      auth: false as const,
      requestTimeoutMs: 100,
    };
    const connected = await manager.connect("secure", initialDef);
    const oauthDef = {
      url,
      protocolVersion: "legacy" as const,
      auth: "oauth" as const,
      oauth: { grantType: "client_credentials" as const },
      requestTimeoutMs: 100,
    };
    const needsAuth = { ...connected, status: "needs-auth" as const };
    let currentConnection = connected;
    let reconnectCalls = 0;
    const originalGetConnection = manager.getConnection.bind(manager);
    const originalReconnect = manager.reconnect.bind(manager);
    vi.spyOn(manager, "getConnection").mockImplementation((name) =>
      name === "secure" ? currentConnection : originalGetConnection(name),
    );
    vi.spyOn(manager, "reconnect").mockImplementation(async (name, def, stale, signal) => {
      reconnectCalls += 1;
      if (reconnectCalls === 1) {
        currentConnection = needsAuth;
        return needsAuth;
      }
      const fresh = await originalReconnect(name, { ...def, auth: false }, connected, signal);
      currentConnection = fresh;
      return fresh;
    });
    authMocks.authenticate.mockImplementation(async (_name, _url, _def, options) => {
      // Exceed the 100ms requestTimeoutMs cleanly to prove auto-auth is not killed by it.
      await delay(220);
      expect(options.signal?.aborted).toBe(false);
      authorized = true;
      return "authenticated";
    });

    const state = createTestState({
      manager,
      ui: host.context.ui,
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: { secure: oauthDef },
      },
      toolMetadata: new Map([
        ["secure", [{ name: "secure_echo", originalName: "echo", description: "Echo" }]],
      ]),
    });

    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const startedAt = performance.now();
    const output = await executeCall(state, {
      toolName: "secure_echo",
      args: {},
      onUpdate: (partial) => updates.push(partial),
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toBe("authenticated ok");
    expect(updateTexts(updates)).toEqual(["Authenticating with secure…", "Connecting to secure…"]);
  });

  it("does not abort modern input_required elicitation when user input exceeds requestTimeoutMs", async () => {
    let calls = 0;
    let receivedAnswer: unknown;
    const server = await startModernServer((_req, res, body) => {
      if (body.method !== "tools/call") {
        return false;
      }
      calls += 1;
      if (calls === 1) {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "input_required",
            requestState: "elicit-state-1",
            inputRequests: {
              confirm: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Confirm deployment target",
                  requestedSchema: {
                    type: "object",
                    properties: {
                      env: { type: "string", title: "Environment" },
                    },
                    required: ["env"],
                  },
                },
              },
            },
          },
        });
        return true;
      }
      receivedAnswer = body.params?.inputResponses;
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "elicitation accepted" }],
        },
      });
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    let selectCount = 0;
    manager.setElicitationConfig({
      allowUrl: false,
      ui: {
        select: async () => {
          selectCount += 1;
          if (selectCount === 1) {
            // Exceed the 100ms requestTimeoutMs while the user reads the elicitation prompt.
            await delay(220);
            return "Continue";
          }
          return "Submit";
        },
        input: async () => "staging",
        notify: vi.fn<() => void>(),
      },
    });
    const definition = { url: server.url, auth: false as const, requestTimeoutMs: 100 };
    const connection = await manager.connect("deploy", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { deploy: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "deploy",
          buildToolMetadata({
            tools: connection.tools,
            resources: [],
            definition,
            serverName: "deploy",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const startedAt = performance.now();
    const output = await executeCall(state, {
      toolName: "deploy_slow_work",
      args: {},
      onUpdate: (partial) => updates.push(partial),
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toBe("elicitation accepted");
    expect(calls).toBe(2);
    expect(receivedAnswer).toEqual({
      confirm: { action: "accept", content: { env: "staging" } },
    });
    expect(updateTexts(updates)).toContain("Fulfilling input required by 'tools/call' (round 1)");
  });

  it("preserves ambiguous_outcome without replay and reports clear timeout diagnostics when a dispatched tool stalls", async () => {
    let mutations = 0;
    const server = await startModernServer((_req, res, body) => {
      if (body.method !== "tools/call") {
        return false;
      }
      mutations += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": accepted\n\n");
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = {
      url: server.url,
      auth: false as const,
      requestTimeoutMs: 90,
      retryOnTransportFailure: true,
    };
    const connection = await manager.connect("billing", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { billing: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "billing",
          buildToolMetadata({
            tools: connection.tools,
            resources: [],
            definition,
            serverName: "billing",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const output = await executeCall(state, {
      toolName: "billing_mutate_and_hang",
      args: { amount: 42 },
    });

    expect(mutations).toBe(1);
    expect(output.isError).toBe(true);
    expect(output.details).toMatchObject({
      error: "ambiguous_outcome",
      server: "billing",
      tool: "mutate_and_hang",
      recovery: { server: "billing", tool: "mutate_and_hang", action: "readback" },
    });
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toContain('"mutate_and_hang"');
    expect(first.text).toContain('"billing"');
    expect(first.text).toContain("90ms");
    expect(first.text).toContain("requestTimeoutMs");
    expect(first.text).toContain("Read back the original operation");
    expect(first.text).toContain("Do not blindly repeat the call");
  });

  it("reports clear server, resource, timeout duration, and requestTimeoutMs diagnostics when a resource read times out", async () => {
    const server = await startModernServer((_req, res, body) => {
      if (body.method !== "resources/read") {
        return false;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": stalled\n\n");
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = { url: server.url, auth: false as const, requestTimeoutMs: 85 };
    const connection = await manager.connect("docs", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { docs: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "docs",
          buildToolMetadata({
            tools: connection.tools,
            resources: connection.resources,
            definition,
            serverName: "docs",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const output = await executeResourceRead(state, {
      server: "docs",
      uri: "report://slow",
    });

    expect(output.isError).toBe(true);
    expect(output.details.error).toBe("call_failed");
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toContain('"report://slow"');
    expect(first.text).toContain('"docs"');
    expect(first.text).toContain("85ms");
    expect(first.text).toContain("requestTimeoutMs");
  });

  it("forwards onUpdate through executeGateway for connect, call, and read-resource actions", async () => {
    const server = await startModernServer(async (_req, res, body) => {
      if (body.method !== "tools/call" && body.method !== "resources/read") {
        return false;
      }
      const token = body.params?._meta?.progressToken;
      assert(token !== undefined);
      res.writeHead(200, { "content-type": "text/event-stream" });
      writeSseEvent(res, {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: 1,
          total: 1,
          message: body.method === "tools/call" ? "Gateway tool step" : "Gateway resource step",
        },
      });
      await delay(20);
      writeSseEvent(res, {
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/call"
            ? { resultType: "complete", content: [{ type: "text", text: "gateway ok" }] }
            : {
                resultType: "complete",
                ttlMs: 60_000,
                cacheScope: "private",
                contents: [{ uri: "report://slow", text: "gateway resource" }],
              },
      });
      res.end();
      return true;
    });

    const host = await createTestExtensionContext();
    cleanups.push(host.dispose);
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = { url: server.url, auth: false as const, requestTimeoutMs: 500 };
    const state = createTestState({
      manager,
      config: { mcpServers: { gw: definition }, settings: { toolPrefix: "server" } },
    });
    const adapterHost = {
      state,
      owner: state.owner,
      initPromise: null,
      config: state.config,
      configPath: undefined,
      programmaticConfig: true,
      directToolsFrozen: false,
      syncToolSurface: vi.fn<() => void>(),
      applyDirectToolConfigChanges: vi.fn<() => void>(),
      ensureCommandState: vi.fn<() => Promise<typeof state>>(async () => state),
      getToolState: vi.fn<() => Promise<typeof state>>(async () => state),
    };
    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const onUpdate = (partial: AgentToolResult<Record<string, unknown>>) => {
      updates.push(partial);
    };
    const ctx = host.runner.createToolContext("gw-call", state.owner.signal);

    await executeGateway(host.api, adapterHost, {}, [
      "gw-connect",
      { action: "connect", server: "gw" },
      undefined,
      onUpdate,
      ctx,
    ]);
    await executeGateway(host.api, adapterHost, {}, [
      "gw-call",
      { action: "call", server: "gw", tool: "slow_work", args: {} },
      undefined,
      onUpdate,
      ctx,
    ]);
    const readRes = await executeGateway(host.api, adapterHost, {}, [
      "gw-read",
      { action: "read-resource", server: "gw", uri: "report://slow" },
      undefined,
      onUpdate,
      ctx,
    ]);
    expect(readRes.details.error, String(readRes.details.message)).toBeUndefined();

    expect(updateTexts(updates)).toEqual([
      "Connecting to gw…",
      "Gateway tool step",
      "Gateway resource step",
    ]);
  });

  it("resets SDK timeout across the timer boundary over a real stdio server and streams progress updates", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/progress-stdio-server.ts", import.meta.url),
    );
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = {
      command: process.execPath,
      args: [fixturePath],
      requestTimeoutMs: 2000,
    };
    const connection = await manager.connect("stdio_worker", definition);
    definition.requestTimeoutMs = 130;
    const state = createTestState({
      manager,
      config: { mcpServers: { stdio_worker: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "stdio_worker",
          buildToolMetadata({
            tools: connection.tools,
            resources: [],
            definition,
            serverName: "stdio_worker",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const startedAt = performance.now();
    const output = await executeCall(state, {
      toolName: "stdio_worker_slow_stdio",
      args: {},
      onUpdate: (partial) => updates.push(partial),
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(260);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toBe("stdio progress ok");
    expect(updateTexts(updates)).toEqual([
      "Stdio step 1/4",
      "Stdio step 2/4",
      "Stdio step 3/4",
      "Stdio step 4/4",
    ]);
    for (const progressUpdate of updates) {
      expect(progressUpdate.details).toEqual({ server: "stdio_worker", tool: "slow_stdio" });
    }
  });

  it("restores the full requestTimeoutMs on progress after a same-connection modern transport retry", async () => {
    let attempts = 0;
    const server = await startModernServer(async (_req, res, body) => {
      if (body.method !== "tools/call") {
        return false;
      }
      attempts += 1;
      const token = body.params?._meta?.progressToken;
      assert(token !== undefined);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (attempts === 1) {
        res.write(": open\n\n");
        await delay(160);
        res.destroy();
        return true;
      }
      await delay(30);
      writeSseEvent(res, {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 1, total: 2, message: "Retried step 1" },
      });
      // Exceeds the ~100ms leftover from attempt 1 while staying below the full 260ms timeout.
      await delay(170);
      writeSseEvent(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "retried after progress" }],
        },
      });
      res.end();
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = {
      url: server.url,
      auth: false as const,
      requestTimeoutMs: 260,
      retryOnTransportFailure: true,
    };
    const connection = await manager.connect("retryable", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { retryable: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "retryable",
          buildToolMetadata({
            tools: connection.tools,
            resources: [],
            definition,
            serverName: "retryable",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const updates: Array<AgentToolResult<Record<string, unknown>>> = [];
    const output = await executeCall(state, {
      toolName: "retryable_slow_work",
      args: {},
      onUpdate: (partial) => updates.push(partial),
    });

    expect(attempts).toBe(2);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toBe("retried after progress");
    expect(updateTexts(updates)).toEqual(["Retried step 1"]);
  });

  it("gives a full requestTimeoutMs window to a same-connection retry after slow input_required fulfillment", async () => {
    let calls = 0;
    const server = await startModernServer(async (_req, res, body) => {
      if (body.method !== "tools/call") {
        return false;
      }
      calls += 1;
      if (calls === 1) {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "input_required",
            requestState: "elicit-retry-1",
            inputRequests: {
              confirm: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Confirm retry target",
                  requestedSchema: {
                    type: "object",
                    properties: { env: { type: "string", title: "Environment" } },
                    required: ["env"],
                  },
                },
              },
            },
          },
        });
        return true;
      }
      if (calls === 2) {
        // Drop the post-elicitation SSE stream to trigger a same-connection transport retry.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": open\n\n");
        await delay(10);
        res.destroy();
        return true;
      }
      // Replay runs comfortably within the full 150ms requestTimeoutMs (would fail at 1ms leftover).
      await delay(60);
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "replayed after elicitation" }],
        },
      });
      return true;
    });

    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    let selectCount = 0;
    manager.setElicitationConfig({
      allowUrl: false,
      ui: {
        select: async () => {
          selectCount += 1;
          if (selectCount === 1) {
            await delay(240);
            return "Continue";
          }
          return "Submit";
        },
        input: async () => "prod",
        notify: vi.fn<() => void>(),
      },
    });
    const definition = {
      url: server.url,
      auth: false as const,
      requestTimeoutMs: 150,
      retryOnTransportFailure: true,
    };
    const connection = await manager.connect("elicit_retry", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { elicit_retry: definition }, settings: { toolPrefix: "server" } },
      toolMetadata: new Map([
        [
          "elicit_retry",
          buildToolMetadata({
            tools: connection.tools,
            resources: [],
            definition,
            serverName: "elicit_retry",
            prefix: "server",
          }).metadata,
        ],
      ]),
    });

    const output = await executeCall(state, {
      toolName: "elicit_retry_slow_work",
      args: {},
    });

    expect(calls).toBe(3);
    expect(output.details.error, String(output.details.message)).toBeUndefined();
    const first = output.content[0];
    assert(first?.type === "text");
    expect(first.text).toBe("replayed after elicitation");
  });
});
