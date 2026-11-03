import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { text as readStreamText } from "node:stream/consumers";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkErrorCode } from "@modelcontextprotocol/client";
import {
  CallToolRequestParamsSchema,
  JSONObjectSchema,
  JSONRPCRequestSchema,
  TextContentSchema,
  ToolAnnotationsSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createMcpAdapter } from "../index.ts";
import { McpServerManager } from "../server-manager.ts";
import { executeCall, executeDescribe } from "../proxy-modes.ts";
import { computeServerHash, reconstructToolMetadata, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { resolvePinnedTools } from "./fixtures/pinned-tools.ts";
import { runMcpScript } from "../mcp-code.ts";
import { formatMcpResultReference } from "../mcp-output-guard.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpOperationContext, McpToolCallEvent, ServerEntry } from "../types.ts";
import { SERVER_STREAM_RESULT_PATCH_METHOD } from "../ui-stream-types.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";

const cleanups: Array<() => Promise<void>> = [];

function requireValue<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, "Expected the fixture to produce this value");
  return value;
}

function textBlock(block: unknown) {
  return TextContentSchema.parse(block).text;
}

function toolResults(messages: readonly AgentSession["messages"][number][]) {
  return messages.filter((message) => message.role === "toolResult");
}

function entryCall(
  entry: string,
  name: string,
  args: ToolCall["arguments"],
): Pick<ToolCall, "name" | "arguments"> {
  switch (entry) {
    case "direct":
      return { name: `local_${name}`, arguments: args };
    case "proxy":
      return { name: "mcp", arguments: { tool: `local_${name}`, args } };
    case "script":
      return {
        name: "mcp_script",
        arguments: { code: `return await tools.local_${name}(${JSON.stringify(args)});` },
      };
    default:
      throw new Error(`Unknown fixture entry: ${entry}`);
  }
}

function streamMessage(message: AssistantMessage, toolCall?: ToolCall) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (toolCall !== undefined) {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "toolcall_end", partial: message, toolCall, contentIndex: 0 });
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      assert.ok(message.stopReason !== "pending");
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
});

const wireRequestSchema = JSONRPCRequestSchema.partial().extend({
  params: CallToolRequestParamsSchema.partial()
    .extend({
      arguments: JSONObjectSchema.default({}),
      requestState: z.string().optional(),
      cursor: z.string().optional(),
    })
    .default({ arguments: {} }),
});
type WireRequest = z.infer<typeof wireRequestSchema>;
type Exchange = { req: IncomingMessage; res: ServerResponse; body: WireRequest };
type HttpExchange = { req: IncomingMessage; res: ServerResponse; body: unknown };
const operationSchema = z.object({
  toolCallId: z.string().exactOptional(),
  innerCallId: z.number().exactOptional(),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  annotations: ToolAnnotationsSchema.optional(),
  resourceUri: z.string().exactOptional(),
  annotationsTrusted: z.boolean(),
}) satisfies z.ZodType<McpOperationContext>;
const captureEventSchema = operationSchema.omit({ annotationsTrusted: true }).extend({
  phase: z.enum(["before", "after"]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}) satisfies z.ZodType<Omit<McpToolCallEvent, "signal">>;
const captureSchema = z.object({ event: captureEventSchema, bytes: z.string() });
const checkpointSchema = z.object({
  toolCallId: z.string(),
  operation: operationSchema.optional(),
  bytes: z.string(),
  workspace: z.string().nullable(),
  artifacts: z.array(z.string()),
});
const tool = {
  name: "echo",
  annotations: { readOnlyHint: true },
  inputSchema: { type: "object", properties: {} },
};
const modern = {
  resultType: "complete",
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  instructions: "Local fixture instructions",
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "local-wire", version: "1" } },
};
function result({ res, body }: Exchange, payload: unknown, headers: OutgoingHttpHeaders = {}) {
  const response =
    body.method?.endsWith("/list") === true
      ? {
          ttlMs: 60_000,
          cacheScope: "private",
          ...z.record(z.string(), z.unknown()).parse(payload),
        }
      : payload;
  res
    .writeHead(200, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: response }));
}
function rpcError(
  { res, body }: Exchange,
  code: number,
  status = 200,
  id: WireRequest["id"] | null = body.id,
) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "fixture rejection" } }));
}
async function fixture(
  handler: (exchange: Exchange) => boolean | undefined | Promise<boolean | undefined> = () => false,
  routes: Record<string, (exchange: HttpExchange) => void> = {},
) {
  const requests: Exchange[] = [];
  const failures: unknown[] = [];
  let sessions = 0;
  const receive = async (req: IncomingMessage, res: ServerResponse) => {
    const data = await readStreamText(req);
    const body: unknown = data === "" ? {} : JSON.parse(data);
    const route = routes[req.url ?? ""];
    if (route !== undefined) {
      route({ req, res, body });
      return;
    }
    const exchange = { req, res, body: wireRequestSchema.parse(body) };
    requests.push(exchange);
    if ((await handler(exchange)) === true) {
      return;
    }
    serveDefault(exchange);
  };
  const serveDefault = (exchange: Exchange) => {
    const { req, res, body } = exchange;
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (body.method === "server/discover") {
      result(exchange, modern);
      return;
    }
    if (body.method === "initialize") {
      result(
        exchange,
        {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy", version: "1" },
        },
        { "mcp-session-id": `session-${++sessions}` },
      );
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      result(exchange, { resultType: "complete", tools: [tool] });
      return;
    }
    if (body.method === "tools/call") {
      result(exchange, {
        resultType: "complete",
        content: [{ type: "text", text: "ok" }],
        structuredContent: body.params.arguments,
      });
      return;
    }
    rpcError(exchange, -32601);
  };
  const server = createServer((req, res) => {
    receive(req, res).catch((error: unknown) => {
      failures.push(error);
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture did not bind");
  }
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    expect(failures).toEqual([]);
  });
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const calls = () => requests.filter((r) => r.body.method === "tools/call");
  const connect = async (options: ServerEntry = {}) => {
    const definition = { url, auth: false as const, requestTimeoutMs: 500, ...options };
    const connection = await manager.connect("local", definition);
    const state = createTestState({
      manager,
      config: { mcpServers: { local: definition }, settings: {} },
      toolMetadata: new Map([
        ["local", buildToolMetadata(connection.tools, [], definition, "local", "server").metadata],
      ]),
      failureTracker: new Map(),
      serverInstructions: new Map(),
      completedUiSessions: [],
    });
    return { connection, state };
  };
  return { manager, url, requests, calls, connect };
}

async function call(state: McpExtensionState, entry: string, signal?: AbortSignal) {
  if (entry === "script") {
    const output = await runMcpScript(
      state,
      'return await tools.local_echo({ value: "test" });',
      2000,
      undefined,
      signal,
    );
    const text = output.content.findLast(
      (c) => c.type === "text" && !c.text.startsWith("[MCP result saved:"),
    );
    assert.ok(text?.type === "text");
    const decoded = z
      .object({
        ok: z.boolean(),
        error: z
          .object({ code: z.string(), message: z.string(), recovery: z.unknown().optional() })
          .optional(),
        data: z.unknown().optional(),
      })
      .parse(JSON.parse(text.text));
    const details: Record<string, unknown> = output.details;
    return { ...decoded, content: output.content, details };
  }
  const context = entry === "direct" ? await createTestExtensionContext() : undefined;
  if (context !== undefined) {
    cleanups.push(context.dispose);
  }
  const output =
    entry === "direct"
      ? await createDirectToolExecutor(
          () => state,
          () => null,
          {
            serverName: "local",
            originalName: "echo",
            prefixedName: "local_echo",
            description: "Echo",
          },
        )(
          "call-id",
          { value: "test" },
          signal,
          undefined,
          requireValue(context).runner.createToolContext("call-id", signal),
        )
      : await executeCall(state, { toolName: "local_echo", args: { value: "test" }, signal });
  return {
    ok: output.details.error === undefined,
    error: undefined,
    data: undefined,
    ...output,
  };
}

describe("published SDK v2 over real local HTTP", () => {
  it.each([
    { protocolVersion: "future" },
    { retryOnTransportFailure: "true" },
    { oauth: { skipIssuerMetadataValidation: "true" } },
  ])(
    "rejects invalid in-memory protocol options before connecting: %j",
    async function rejectsInvalidProtocolOptions(invalid) {
      const f = await fixture();
      await expect(
        f.connect(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-011: negative runtime inputs must reach the manager's own validation.
          invalid as unknown as ServerEntry,
        ),
      ).rejects.toThrow(/must be/);
      expect(f.requests).toHaveLength(0);
    },
  );

  it("uses native discovery, wire metadata and nested dynamic parameter headers without legacy traffic", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      result(e, {
        resultType: "complete",
        tools: [
          {
            ...tool,
            inputSchema: {
              type: "object",
              properties: {
                nested: {
                  type: "object",
                  properties: {
                    region: { type: "string", "x-mcp-header": "Region" },
                  },
                },
              },
            },
          },
        ],
      });
      return true;
    });
    const { connection } = await f.connect();
    await connection.client.callTool({
      name: "echo",
      arguments: { nested: { region: "Hello, 世界" } },
    });
    expect(connection.client.getProtocolEra()).toBe("modern");
    expect(connection.instructions).toBe("Local fixture instructions");
    expect(f.requests.map((r) => r.body.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
    for (const { req, body } of f.requests) {
      expect(req.method).toBe("POST");
      expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(req.headers["mcp-method"]).toBe(body.method);
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      expect(requireValue(body.params._meta)["io.modelcontextprotocol/protocolVersion"]).toBe(
        "2026-07-28",
      );
    }
    expect(requireValue(f.calls()[0]).req.headers["mcp-name"]).toBe("echo");
    expect(requireValue(f.calls()[0]).req.headers["mcp-param-region"]).toBe(
      "=?base64?SGVsbG8sIOS4lueVjA==?=",
    );
  });

  it("leaves HEADER_MISMATCH refresh and fresh request IDs to the SDK", async () => {
    let lists = 0;
    const f = await fixture((e) => {
      if (e.body.method === "tools/list") {
        result(e, {
          resultType: "complete",
          tools: [
            {
              ...tool,
              inputSchema: {
                type: "object",
                properties: {
                  region: { type: "string", "x-mcp-header": ++lists === 1 ? "Old" : "Region" },
                },
              },
            },
          ],
        });
        return true;
      }
      if (e.body.method === "tools/call" && e.req.headers["mcp-param-region"] === undefined) {
        rpcError(e, -32020, 400);
        return true;
      }
      return;
    });
    const { connection } = await f.connect({ retryOnTransportFailure: true });
    await connection.client.callTool({ name: "echo", arguments: { region: "west" } });
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(2);
    expect(requireValue(f.calls()[0]).body.id).not.toBe(requireValue(f.calls()[1]).body.id);
    expect(requireValue(f.calls()[1]).req.headers["mcp-param-region"]).toBe("west");
  });

  it.each([307, 308])(
    "preserves authenticated POST bodies across same-origin HTTP%s redirects",
    async (status) => {
      const f = await fixture((e) => {
        if (e.req.url !== "/mcp") {
          return;
        }
        e.res.writeHead(status, { location: "/final" }).end();
        return true;
      });
      const { state } = await f.connect({ auth: "bearer", bearerToken: "redirect-fixture-token" });
      expect((await call(state, "proxy")).ok).toBe(true);
      const final = f.requests.filter((e) => e.req.url === "/final");
      expect(final.map((e) => e.body.method)).toEqual([
        "server/discover",
        "tools/list",
        "tools/call",
      ]);
      expect(
        final.every(
          (e) =>
            e.req.method === "POST" &&
            e.req.headers.authorization === "Bearer redirect-fixture-token",
        ),
      ).toBe(true);
      expect(requireValue(final.at(-1)).body.params.arguments).toEqual({ value: "test" });
    },
  );

  it.each([301, 302, 303])(
    "refuses HTTP%s redirects that change an MCP POST method",
    async (status) => {
      const f = await fixture((e) => {
        e.res.writeHead(status, { location: "/final" }).end();
        return true;
      });
      await expect(f.connect()).rejects.toThrow(/Redirect.*not followed/i);
      expect(f.requests.length).toBeGreaterThan(0);
      expect(f.requests.every((e) => e.req.method === "POST" && e.req.url === "/mcp")).toBe(true);
      expect(f.manager.getConnection("local")).toBeUndefined();
    },
  );

  it("does not forward credentials across origins; the explicit final endpoint remains usable", async () => {
    const target = await fixture();
    const f = await fixture((e) => {
      e.res.writeHead(307, { location: target.url }).end();
      return true;
    });
    const credentials = { auth: "bearer" as const, bearerToken: "cross-origin-fixture-token" };
    await expect(f.connect(credentials)).rejects.toThrow(/Redirect.*not followed/i);
    expect(target.requests).toHaveLength(0);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((e) => e.req.method === "POST" && e.req.url === "/mcp")).toBe(true);
    const { state } = await f.connect({ ...credentials, url: target.url });
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(target.requests.map((e) => e.body.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
    ]);
    expect(
      target.requests.every(
        (e) => e.req.headers.authorization === "Bearer cross-origin-fixture-token",
      ),
    ).toBe(true);
  });

  it.each([-32601, -32700, -32000, -32020, -32021])(
    "keeps native matched error %s fallback",
    async (code) => {
      const f = await fixture((e) => {
        if (e.body.method !== "server/discover") {
          return;
        }
        rpcError(e, code);
        return true;
      });
      const { connection } = await f.connect();
      expect(connection.client.getProtocolEra()).toBe("legacy");
      const initializations = f.requests.filter((r) => r.body.method === "initialize");
      expect(initializations).toHaveLength(1);
      expect(requireValue(initializations[0]).req.headers["mcp-method"]).toBeUndefined();
      expect(requireValue(initializations[0]).body.params._meta).toBeUndefined();
    },
  );

  it.each(["malformed", "http400"])("keeps native %s discovery fallback", async (mode) => {
    const f = await fixture((e) => {
      if (e.body.method !== "server/discover") {
        return;
      }
      if (mode === "malformed") {
        result(e, {});
      } else {
        e.res.writeHead(400).end("legacy endpoint");
      }
      return true;
    });
    expect((await f.connect()).connection.client.getProtocolEra()).toBe("legacy");
  });

  it("reports the native HTTP200 null-ID limitation honestly; explicit legacy works", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "server/discover") {
        return;
      }
      rpcError(e, -32700, 200, null);
      return true;
    });
    await expect(f.connect()).rejects.toMatchObject({ code: SdkErrorCode.EraNegotiationFailed });
    expect(f.requests.map((r) => r.body.method)).toEqual(["server/discover"]);
    expect((await f.connect({ protocolVersion: "legacy" })).connection.status).toBe("connected");
    expect(f.requests.filter((r) => r.body.method === "initialize")).toHaveLength(1);
  });

  it.each([401, 403, 500, "network"] as const)(
    "never chooses SSE or legacy for discovery %s",
    async (failure) => {
      const f = await fixture((e) => {
        if (e.body.method !== "server/discover") {
          return;
        }
        if (failure === "network") {
          e.req.socket.destroy();
        } else {
          e.res.writeHead(failure).end("unavailable");
        }
        return true;
      });
      const codes = new Map([
        [401, SdkErrorCode.ClientHttpAuthentication],
        [403, SdkErrorCode.ClientHttpForbidden],
      ]);
      const code = codes.get(Number(failure)) ?? SdkErrorCode.EraNegotiationFailed;
      await expect(f.connect()).rejects.toMatchObject({ code });
      expect(f.manager.getConnection("local")).toBeUndefined();
      expect(f.requests.map((r) => r.body.method)).toEqual(["server/discover"]);
    },
  );

  it("never chooses SSE or legacy for discovery timeout", async () => {
    let received: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const f = await fixture((e) => {
      if (e.body.method !== "server/discover") {
        return;
      }
      received();
      return true;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = Promise.allSettled([f.connect({ requestTimeoutMs: 35 })]);
      await arrived;
      await vi.advanceTimersByTimeAsync(35);
      expect(await outcome).toMatchObject([
        { status: "rejected", reason: { code: SdkErrorCode.RequestTimeout } },
      ]);
      expect(f.manager.getConnection("local")).toBeUndefined();
      expect(f.requests.map((r) => r.body.method)).toEqual(["server/discover"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["direct", "proxy", "script"])(
    "uses one same-client fresh transport retry through %s",
    async (entry) => {
      const f = await fixture((e) => {
        if (e.body.method === "tools/call" && f.calls().length === 1) {
          e.req.socket.destroy();
          return true;
        }
        return;
      });
      const { state, connection } = await f.connect({ retryOnTransportFailure: true });
      const output = await call(state, entry);
      expect(output.ok).toBe(true);
      expect(f.manager.getConnection("local")?.client).toBe(connection.client);
      expect(f.calls()).toHaveLength(2);
      expect(requireValue(f.calls()[0]).body.id).not.toBe(requireValue(f.calls()[1]).body.id);
      expect(f.requests.filter((r) => r.body.method === "server/discover")).toHaveLength(1);
      expect(connection.inFlight).toBe(0);
    },
  );

  it.each(["direct", "proxy", "script"])(
    "retries partial SSE body loss once through %s",
    async (entry) => {
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call" || f.calls().length > 1) {
          return;
        }
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": started\n\n");
        setTimeout(() => e.res.destroy(), 20);
        return true;
      });
      const { state, connection } = await f.connect({ retryOnTransportFailure: true });
      const started = performance.now();
      const output = await call(state, entry);
      expect(
        output.ok,
        JSON.stringify({
          output,
          calls: f.calls().map((c) => c.body.id),
          elapsedMs: performance.now() - started,
        }),
      ).toBe(true);
      expect(f.calls()).toHaveLength(2);
      expect(requireValue(f.calls()[0]).body.id).not.toBe(requireValue(f.calls()[1]).body.id);
      expect(f.manager.getConnection("local")?.client).toBe(connection.client);
      expect(f.requests.filter((r) => r.body.method === "server/discover")).toHaveLength(1);
      expect(connection.inFlight).toBe(0);
    },
  );

  it.each(
    ["direct", "proxy", "script"].flatMap((entry) =>
      ["sse", "json", "timeout", "http500-timeout", "legacy-timeout"].map((failure) => ({
        entry,
        failure,
      })),
    ),
  )(
    "reconciles a committed mutation after $failure response loss through $entry without replay",
    async ({ entry, failure }) => {
      const receipts = new Map<string, unknown>();
      let mutations = 0;
      const f = await fixture((e) => {
        if (e.body.method === "tools/list") {
          result(e, {
            resultType: "complete",
            tools: [
              {
                name: "echo",
                inputSchema: tool.inputSchema,
                annotations: { readOnlyHint: false, idempotentHint: false },
              },
              { ...tool, name: "readback" },
            ],
          });
          return true;
        }
        if (e.body.method !== "tools/call") {
          return;
        }
        if (e.body.params.name === "readback") {
          result(e, {
            resultType: "complete",
            content: [],
            structuredContent: receipts.get(z.string().parse(e.body.params.arguments.value)),
          });
        } else {
          mutations++;
          receipts.set(z.string().parse(e.body.params.arguments.value), {
            id: "original-resource",
            version: mutations,
          });
          if (failure.endsWith("timeout")) {
            if (failure === "http500-timeout") {
              e.res.writeHead(500, { "content-type": "text/plain" });
              e.res.write("Internal error after committing");
            } else {
              setTimeout(() => result(e, { resultType: "complete", content: [] }), 160);
            }
          } else {
            e.res.writeHead(200, {
              "content-type": failure === "json" ? "application/json" : "text/event-stream",
            });
            e.res.write(
              failure === "json"
                ? `{"jsonrpc":"2.0","id":${requireValue(e.body.id)},"result":`
                : ": committed\n\n",
            );
            setTimeout(() => e.res.destroy(), 20);
          }
        }
        return true;
      });
      const { state } = await f.connect({
        retryOnTransportFailure: true,
        requestTimeoutMs: 80,
        ...(failure === "legacy-timeout" ? { protocolVersion: "legacy" as const } : {}),
      });
      const captured: McpToolCallEvent[] = [];
      if (!failure.endsWith("timeout")) {
        state.onToolCall = async (event) => {
          captured.push(event);
        };
      }
      const output = await call(state, entry);
      expect(mutations).toBe(1);
      expect(entry === "script" ? requireValue(output.error).code : output.details.error).toBe(
        "ambiguous_outcome",
      );
      expect(
        entry === "script" ? requireValue(output.error).message : output.details.message,
      ).toContain("Read back the original operation");
      expect(
        entry === "script" ? requireValue(output.error).recovery : output.details.recovery,
      ).toMatchObject({
        action: "readback",
      });
      expect(
        captured.map((event) => ({
          phase: event.phase,
          args: event.args,
          innerCallId: event.innerCallId,
          hasError: "error" in event && event.error instanceof Error,
        })),
      ).toEqual(
        failure.endsWith("timeout")
          ? []
          : [
              {
                phase: "before",
                args: { value: "test" },
                innerCallId: entry === "script" ? 1 : undefined,
                hasError: false,
              },
              {
                phase: "after",
                args: { value: "test" },
                innerCallId: entry === "script" ? 1 : undefined,
                hasError: true,
              },
            ],
      );
      const readback = await executeCall(state, {
        toolName: "local_readback",
        args: { value: "test" },
      });
      expect(readback.details.mcpResult).toMatchObject({
        structuredContent: { id: "original-resource", version: 1 },
      });
      expect(mutations).toBe(1);
    },
  );

  it("does not replay a lost JSON body even for a replay-safe tool", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "application/json" });
      e.res.write(`{"jsonrpc":"2.0","id":${requireValue(e.body.id)},"result":`);
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, "proxy");
    expect(output.details).toMatchObject({
      error: "ambiguous_outcome",
      recovery: { action: "readback" },
    });
    expect(f.calls()).toHaveLength(1);
  });

  it("does not report an unknown outcome when a rejected call times out refreshing its catalog", async () => {
    let lists = 0;
    let received: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const f = await fixture((e) => {
      if (e.body.method === "tools/list" && ++lists > 1) {
        received();
        return true;
      }
      if (e.body.method !== "tools/call") {
        return;
      }
      rpcError(e, -32020, 400);
      return true;
    });
    const { state, connection } = await f.connect({
      requestTimeoutMs: 10_000,
      retryOnTransportFailure: true,
    });
    connection.definition.requestTimeoutMs = 2_000;
    const pending = call(state, "proxy");
    expect(await Promise.race([arrived.then(() => true), pending.then(() => false)])).toBe(true);
    const output = await pending;
    expect(output.details.error).toBe("call_failed");
    expect(output.details.message).toMatch(/timeout|timed out/i);
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(1);
  }, 15_000);

  it.each([
    undefined,
    {},
    { readOnlyHint: false },
    { idempotentHint: true },
    { readOnlyHint: true },
  ])("uses only explicit replay-safe annotations for transport retry: %j", async (annotations) => {
    const f = await fixture((e) => {
      if (e.body.method === "tools/list") {
        result(e, {
          resultType: "complete",
          tools: [{ name: "echo", inputSchema: tool.inputSchema, annotations }],
        });
        return true;
      }
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.req.socket.destroy();
        return true;
      }
      return;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    // A frozen direct tool can still have old read-only hints; live hints win.
    const context = await createTestExtensionContext();
    cleanups.push(context.dispose);
    const output = await createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "local",
        originalName: "echo",
        prefixedName: "local_echo",
        description: "Echo",
        annotations: { readOnlyHint: true },
      },
    )(
      "outer-id",
      { secret: "not-in-error-text" },
      undefined,
      undefined,
      context.runner.createToolContext("outer-id", state.owner.signal),
    );
    const safe = annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
    expect(f.calls()).toHaveLength(safe ? 2 : 1);
    expect(output.details.error).toBe(safe ? undefined : "ambiguous_outcome");
    const recovery: unknown = expect.objectContaining({
      server: "local",
      tool: "echo",
      toolCallId: "outer-id",
      action: "readback",
    });
    expect(output.details.recovery).toEqual(safe ? undefined : recovery);
    expect(safe || !JSON.stringify(output).includes("not-in-error-text")).toBe(true);
  });

  it("describes complete native input schemas without a lossy TypeScript projection", async () => {
    const inputSchema = {
      type: "object",
      properties: {
        value: { type: "string", description: "Value to echo", minLength: 1 },
        count: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["value"],
      additionalProperties: false,
    };
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      result(e, {
        resultType: "complete",
        tools: [
          { ...tool, inputSchema },
          {
            ...tool,
            name: "compact",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      });
      return true;
    });
    const { state } = await f.connect();
    const script = await runMcpScript(
      state,
      `
      const native = await tools.describe({ path: "local_echo" });
      const compact = await tools.describe({ path: "local_compact" });
      return { native, compact, called: await tools.call(native.path, { value: "test" }) };
    `,
    );
    expect(script.details).not.toHaveProperty("error");
    const described = z
      .object({
        native: z.object({ inputSchema: z.unknown() }).loose(),
        compact: z.object({ inputSchema: z.unknown() }).loose(),
        called: z.unknown(),
      })
      .parse(JSON.parse(textBlock(script.content[0])));
    expect(described.native.inputSchema).toEqual(inputSchema);
    expect(described.native).not.toHaveProperty("inputTypeScript");
    expect(described.compact.inputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
    expect(described.compact).not.toHaveProperty("inputTypeScript");
    expect(described.called).toMatchObject({
      ok: true,
      data: { structuredContent: { value: "test" } },
    });
    expect(requireValue(f.calls()[0]).body.params.arguments).toEqual({ value: "test" });
  });

  it("applies public proxy connect pagination to the discovered server list", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      result(e, {
        resultType: "complete",
        tools: [tool, { ...tool, name: "second" }, { ...tool, name: "third" }],
      });
      return true;
    });
    const context = await createTestExtensionContext(
      "all",
      createMcpAdapter({
        config: {
          mcpServers: { local: { url: f.url, auth: false, lifecycle: "lazy" } },
          settings: { sampling: false, elicitation: false },
        },
      }),
    );
    cleanups.push(async () => {
      await context.runner.emit({ type: "session_shutdown", reason: "quit" });
      await context.dispose();
    });
    const gateway = requireValue(context.runner.getToolDefinition("mcp"));
    const page = await gateway.execute(
      "connect-page",
      { connect: "local", limit: 1, offset: 1 },
      undefined,
      undefined,
      context.runner.createToolContext("connect-page", context.context.signal),
    );
    expect(page.details).toMatchObject({
      mode: "list",
      server: "local",
      tools: ["local_second"],
      count: 3,
      hasMore: true,
      nextOffset: 2,
    });
    expect(textBlock(page.content[0])).toContain(
      '2-2 of 3 — mcp({ action: "list", server: "local", limit: 1, offset: 2 }) for more',
    );
  });

  it("preserves native annotations through cached metadata, direct tools and both describe paths", async () => {
    const f = await fixture();
    const { state, connection } = await f.connect({ directTools: true });
    const definition = requireValue(state.config.mcpServers.local);
    const entry = {
      configHash: computeServerHash(definition),
      tools: serializeTools(connection.tools),
      resources: [],
      cachedAt: Date.now(),
    };
    const metadata = reconstructToolMetadata("local", entry, "server", definition);
    expect(metadata).toEqual(state.toolMetadata.get("local"));
    const specs = await resolvePinnedTools(
      state.config,
      { version: 1, servers: { local: entry } },
      "server",
    );
    expect(requireValue(specs[0]).annotations).toEqual({ readOnlyHint: true });
    expect(JSON.parse(textBlock(executeDescribe(state, "local_echo").content[0]))).toMatchObject({
      annotations: { readOnlyHint: true },
    });
    const script = await runMcpScript(state, 'return tools.describe({ path: "local_echo" });');
    const described = z
      .object({ annotations: z.unknown() })
      .parse(JSON.parse(textBlock(script.content[0])));
    expect(described.annotations).toEqual({ readOnlyHint: true });
    expect(f.calls()).toHaveLength(0);
  });

  it("keeps Pi's provider prompt stable while proxy discovery and instructions refresh", async () => {
    let discoveries = 0;
    let heldCall: Exchange | undefined;
    const instructions = "Read the data guide before querying. ".repeat(20);
    const f = await fixture((e) => {
      if (e.body.method === "tools/call" && e.body.params.arguments.value === "pending") {
        heldCall = e;
        return true;
      }
      if (e.body.method === "server/discover") {
        result(e, {
          ...modern,
          instructions: ++discoveries === 1 ? "Original guidance" : instructions,
        });
        return true;
      }
      if (e.body.method === "tools/list") {
        result(e, {
          resultType: "complete",
          tools: [
            { ...tool, description: "Read the original data" },
            ...(discoveries > 1
              ? [{ ...tool, name: "second", description: "Read newly available data" }]
              : []),
          ],
        });
        return true;
      }
      return;
    });
    const root = await mkdtemp(
      join(process.env.PI_MCP_NATIVE_TEST_ROOT ?? tmpdir(), "mcp-stable-prompt-"),
    );
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const previousEnv = {
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS,
    };
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_DIRECT_TOOLS;
    cleanups.unshift(async () => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      // The Pi session is in memory; no native session files are removed.
      await rm(root, { recursive: true, force: true });
    });
    const wrapper = join(root, "extension.ts");
    await writeFile(
      wrapper,
      `
      import { createMcpAdapter } from ${JSON.stringify(resolvePath("dist/index.js"))};
      export default createMcpAdapter({ outputDirectory: ${JSON.stringify(join(root, "output"))}, config: {
        mcpServers: { local: { url: ${JSON.stringify(f.url)}, auth: false, lifecycle: "lazy" } },
        settings: { sampling: false, elicitation: false },
      } });
    `,
    );
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      additionalExtensionPaths: [wrapper],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const model: Model<"openai-completions"> = {
      id: "fixture",
      name: "fixture",
      api: "openai-completions",
      provider: "fixture",
      baseUrl: f.url,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
    };
    modelRuntime.registerProvider("fixture", {
      baseUrl: f.url,
      api: model.api,
      apiKey: "fixture-key",
      models: [model],
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager,
      modelRuntime,
      model,
    });
    cleanups.push(async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    });
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        throw new Error(error.error);
      },
    });
    expect(session.getActiveToolNames()).not.toContain("mcp");
    expect(session.getActiveToolNames()).not.toContain("mcp_script");
    const steps = [
      { connect: "local" },
      { search: "echo" },
      { connect: "local" },
      { instructions: "local" },
      { describe: "local_second" },
      { tool: "local_second", args: {} },
    ];
    const prefixes: string[] = [];
    session.agent.streamFunction = async (_model, context) => {
      prefixes.push(
        JSON.stringify({
          systemPrompt: getCurrentSystemPrompt(context.messages),
          tools: getCurrentTools(context.messages),
        }),
      );
      const loading = prefixes.length === 1;
      const step = loading ? { enable: ["gateway", "script"] } : steps[prefixes.length - 2];
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        timestamp: Date.now(),
        content: step
          ? [
              {
                type: "toolCall",
                id: `call-${prefixes.length}`,
                name: loading ? "mcp_search" : "mcp",
                arguments: step,
              },
            ]
          : [{ type: "text", text: "done" }],
        stopReason: step ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return streamMessage(message);
    };
    await session.prompt("Read the server guidance and discover the newly available tool.");
    const outputs = toolResults(session.messages).slice(1);
    expect(outputs).toHaveLength(steps.length);
    expect(
      outputs.every(
        (message) =>
          !message.isError &&
          z.record(z.string(), z.unknown()).parse(message.details ?? {}).error === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(requireValue(outputs[1]).content)).toContain("Read the original data");
    expect(textBlock(requireValue(outputs[3]).content[0])).toBe(
      `local instructions:\n\n${instructions}`,
    );
    expect(JSON.stringify(requireValue(outputs[4]).content)).toContain("Read newly available data");
    expect(f.calls().map((e) => e.body.params.name)).toEqual(["second"]);
    expect(prefixes).toHaveLength(steps.length + 2);
    const prefixSchema = z.object({
      systemPrompt: z.string(),
      tools: z.array(z.object({ name: z.string() })),
    });
    expect(
      prefixSchema.parse(JSON.parse(requireValue(prefixes[0]))).tools.map((item) => item.name),
    ).not.toEqual(expect.arrayContaining(["mcp", "mcp_script"]));
    const prefix = prefixSchema.parse(JSON.parse(requireValue(prefixes[1])));
    expect(prefix.systemPrompt).toContain("MCP server operations");
    expect(prefix.tools.map((item) => item.name)).toEqual(
      expect.arrayContaining(["mcp", "mcp_script"]),
    );
    expect(new Set(prefixes.slice(1)).size).toBe(1);

    session.setActiveToolsByName(
      session
        .getActiveToolNames()
        .filter((name: string) => name !== "mcp" && name !== "mcp_script"),
    );
    let stage = 0;
    let savedRef: string | undefined;
    let savedText: string | undefined;
    const loadingStages: Array<{
      hasGateway: boolean;
      selected: ReturnType<typeof getCurrentTools>[number] | undefined;
      callable: string[];
    }> = [];
    session.agent.streamFunction = async (_model, context) => {
      const active = getCurrentTools(context.messages);
      const selected = active.find(
        (candidate) => candidate.description === "Read newly available data",
      );
      loadingStages.push({
        hasGateway: active.some(
          (candidate) => candidate.name === "mcp" || candidate.name === "mcp_script",
        ),
        selected,
        callable: session.getCallableToolNames(),
      });
      let next: Pick<ToolCall, "name" | "arguments"> | undefined;
      if (stage === 0) {
        next = {
          name: "mcp_search",
          arguments: { query: "newly available", server: "local", limit: 1 },
        };
      } else if (stage === 1) {
        next = { name: requireValue(selected).name, arguments: { value: "typed" } };
      } else if (stage === 2) {
        const response = requireValue(
          context.messages.findLast((message) => message.role === "toolResult"),
        );
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const reference = /\[MCP result saved: (".*?")\./.exec(text)?.[1];
        savedRef = z.string().parse(JSON.parse(requireValue(reference)));
        savedText = text;
        next = { name: "mcp_search", arguments: { enable: ["gateway"] } };
      } else if (stage === 3) {
        next = {
          name: "mcp",
          arguments: {
            action: "read-result",
            ref: requireValue(savedRef),
            path: "/structuredContent",
          },
        };
      }
      stage++;
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        timestamp: Date.now(),
        content: next
          ? [{ type: "toolCall", id: `loaded-${stage}`, ...next }]
          : [{ type: "text", text: "done" }],
        stopReason: next ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return streamMessage(message);
    };
    await session.prompt(
      "Load the matching typed tool, call it, then inspect its saved structured data without another remote call.",
    );
    expect(stage).toBe(5);
    expect(loadingStages.slice(0, 3).map((snapshot) => snapshot.hasGateway)).toEqual([
      false,
      false,
      false,
    ]);
    expect(requireValue(loadingStages[0]).selected).toBeUndefined();
    expect(requireValue(loadingStages[0]).callable).not.toContain("local_second");
    expect(requireValue(requireValue(loadingStages[1]).selected).parameters).toEqual(
      tool.inputSchema,
    );
    expect(requireValue(loadingStages[1]).callable).toContain("local_second");
    expect(savedRef).toBeDefined();
    expect(savedText).toContain('mcp_search({ enable: ["gateway"] })');
    const readback = requireValue(toolResults(session.messages).at(-1));
    expect(readback.isError).toBe(false);
    expect(JSON.parse(textBlock(readback.content[0]))).toEqual({ value: "typed" });
    expect(f.calls().map((e) => e.body.params.name)).toEqual(["second", "second"]);
    const selection = requireValue(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom")
        .findLast((entry) => entry.customType === "mcp-tool-selection"),
    );
    expect(z.object({ selected: z.unknown() }).parse(selection.data).selected).toEqual([
      { server: "local", tool: "second" },
    ]);

    {
      session.setActiveToolsByName(
        session.getActiveToolNames().filter((name: string) => name !== "mcp_script"),
      );
      let requests = 0;
      const scriptVisibility: boolean[] = [];
      session.agent.streamFunction = async (_model, context) => {
        const first = requests++ === 0;
        const typed = requireValue(
          getCurrentTools(context.messages).find(
            (candidate) => candidate.description === "Read newly available data",
          ),
        );
        const pendingCall: ToolCall = {
          type: "toolCall",
          id: "pending-typed",
          name: typed.name,
          arguments: { value: "pending" },
        };
        scriptVisibility.push(
          getCurrentTools(context.messages).some((candidate) => candidate.name === "mcp_script"),
        );
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: "fixture",
          model: "fixture",
          timestamp: Date.now(),
          content: first ? [pendingCall] : [{ type: "text", text: "done" }],
          stopReason: first ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        return streamMessage(message, first ? pendingCall : undefined);
      };
      const pending = session.prompt("Keep the accepted typed call while loading script.");
      try {
        await expect.poll(() => heldCall !== undefined).toBe(true);
        const search = session.agent.state.tools.find((item) => item.name === "mcp_search");
        await requireValue(search).execute("load-with-pending", { enable: ["script"] });
        expect(session.getActiveToolNames()).toContain("mcp_script");
        expect(session.getActiveToolNames()).toContain("local_second");
      } finally {
        if (heldCall) {
          result(heldCall, {
            resultType: "complete",
            content: [{ type: "text", text: "settled once" }],
          });
        }
        await pending;
      }
      await session.waitForIdle();
      expect(scriptVisibility).toEqual([false, true]);
      expect(
        f.calls().filter((request) => request.body.params.arguments.value === "pending"),
        JSON.stringify(session.messages.slice(-4)),
      ).toHaveLength(1);
      expect(
        session.messages.filter(
          (message) => message.role === "toolResult" && message.toolCallId === "pending-typed",
        ),
      ).toMatchObject([{ isError: false, content: [{ type: "text", text: "settled once" }] }]);
    }
  }, 20_000);

  it("awaits native Pi factory checkpoints and capture across Jiti without replaying completed effects", async () => {
    const root = await mkdtemp(
      join(process.env.PI_MCP_NATIVE_TEST_ROOT ?? tmpdir(), "mcp-native-capture-"),
    );
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const previousEnv = {
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS,
    };
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_DIRECT_TOOLS;
    cleanups.unshift(async () => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      // Preserve native fixture histories for inspection; never delete Pi sessions.
    });
    const captures: Array<z.infer<typeof captureSchema> & { res: ServerResponse }> = [];
    const checkpoints: Array<z.infer<typeof checkpointSchema> & { res: ServerResponse }> = [];
    const outputDirectory = join(root, "output");
    const largeOutput = "saved detail: π\n".repeat(10_000);
    let checkpointMode = "hold";
    let writer: ServerResponse | undefined;
    let mode = "hold";
    let effects = 0;
    const receipts = new Map<string, unknown>();
    let readbackAnnotations: { readOnlyHint: boolean } | undefined = { readOnlyHint: true };
    const resourceUri = "fixture://saved-data";
    const f = await fixture(
      (e) => {
        if (e.body.method === "server/discover") {
          result(e, { ...modern, capabilities: { tools: {}, resources: {} } });
          return true;
        }
        if (e.body.method === "resources/list") {
          result(e, {
            resultType: "complete",
            resources: [{ name: "saved_data", uri: resourceUri }],
          });
          return true;
        }
        if (e.body.method === "resources/read") {
          result(e, {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            contents: [{ uri: resourceUri, text: "saved resource" }],
          });
          return true;
        }
        if (e.body.method === "tools/list") {
          result(e, {
            resultType: "complete",
            tools: [
              { name: "echo", inputSchema: tool.inputSchema },
              { ...tool, name: "readback", annotations: readbackAnnotations },
              {
                name: "upsert",
                inputSchema: tool.inputSchema,
                annotations: { readOnlyHint: false, idempotentHint: true },
              },
            ],
          });
          return true;
        }
        if (e.body.method === "tools/call") {
          const value = z.string().parse(e.body.params.arguments.value);
          if (e.body.params.name !== "readback") {
            receipts.set(value, { id: `resource-${++effects}`, value });
          }
          if (value === "lose-response" && e.body.params.name === "echo") {
            e.res.writeHead(200, { "content-type": "text/event-stream" });
            e.res.write(": committed\n\n");
            setTimeout(() => e.res.destroy(), 20);
          } else {
            result(e, {
              resultType: "complete",
              content: value === "first" ? [{ type: "text", text: largeOutput }] : [],
              structuredContent: receipts.get(value),
            });
          }
          return true;
        }
        return;
      },
      {
        "/writer": ({ res }) => {
          writer = res;
        },
        "/checkpoint": ({ body, res }) => {
          checkpoints.push({ ...checkpointSchema.parse(body), res });
          if (checkpointMode !== "hold") {
            res.writeHead(checkpointMode === "reject" ? 503 : 200).end();
          }
        },
        "/capture": ({ body, res }) => {
          const capture = captureSchema.parse(body);
          captures.push({ ...capture, res });
          if (mode !== "hold" || capture.event.innerCallId !== 1) {
            res.writeHead(mode === `reject-${capture.event.phase}` ? 503 : 200).end();
          }
        },
      },
    );
    const wrapper = join(root, "capture-extension.ts");
    await writeFile(
      wrapper,
      `
      import { createMcpAdapter } from ${JSON.stringify(resolvePath("dist/index.js"))};
      import { createNativeCaptureExtension } from ${JSON.stringify(resolvePath("__tests__/fixtures/native-capture-extension.ts"))};
      export default createNativeCaptureExtension({
        createAdapter: createMcpAdapter,
        outputDirectory: ${JSON.stringify(outputDirectory)},
        workspaceFile: ${JSON.stringify(join(root, "work.txt"))},
        url: ${JSON.stringify(f.url)},
      });
    `,
    );
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      additionalExtensionPaths: [wrapper],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    const model: Model<"openai-completions"> = {
      id: "fixture",
      name: "fixture",
      api: "openai-completions",
      provider: "fixture",
      baseUrl: f.url,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
    };
    modelRuntime.registerProvider("fixture", {
      baseUrl: f.url,
      api: model.api,
      apiKey: "fixture-key",
      models: [model],
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      modelRuntime,
      model,
    });
    cleanups.push(async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    });
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        throw new Error(error.error);
      },
    });
    // This safety/capture fixture explicitly selects its entry points; lazy loading is exercised above.
    session.setActiveToolsByName([...session.getActiveToolNames(), "mcp", "mcp_script"]);
    const script = `const first = await tools.local_echo({ value: ["first"].join("") }); await tools.local_echo({ value: first.data.structuredContent.id }); emit(first.data.content[0].text);`;
    let nativeCalls: ToolCall[] = [
      { type: "toolCall", id: "native-writer", name: "fixture_writer", arguments: {} },
      { type: "toolCall", id: "native-outer", name: "mcp_script", arguments: { code: script } },
    ];
    let modelCalls = 0;
    session.agent.streamFunction = async (_model, _context, options) => {
      const aborted = options?.signal?.aborted === true;
      let content: AssistantMessage["content"] = [];
      let stopReason: AssistantMessage["stopReason"] = "aborted";
      if (!aborted) {
        modelCalls++;
        if (modelCalls === 1) {
          content = nativeCalls;
          stopReason = "toolUse";
        } else {
          content = [{ type: "text", text: "done" }];
          stopReason = "stop";
        }
      }
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        timestamp: Date.now(),
        content,
        stopReason,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return streamMessage(message);
    };
    const pending = session.prompt("fixture: finish the workspace write and both effects");
    await expect.poll(() => writer !== undefined).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(effects).toBe(0);
    requireValue(writer).writeHead(200).end();
    await expect.poll(() => checkpoints.length).toBe(1);
    expect(checkpoints[0]).toMatchObject({
      toolCallId: "native-outer",
      workspace: "writer finished",
      artifacts: [],
      operation: {
        toolCallId: "native-outer",
        innerCallId: 1,
        server: "local",
        tool: "echo",
        args: { value: "first" },
        annotationsTrusted: true,
      },
    });
    expect(requireValue(requireValue(checkpoints[0]).operation).annotations).toBeUndefined();
    // A real wait longer than the 1s service deadline must not consume that deadline.
    await delay(1200);
    expect(requireValue(checkpoints[0]).bytes).toContain(
      '"role":"toolResult","toolCallId":"native-writer"',
    );
    expect(captures).toHaveLength(0);
    expect(effects).toBe(0);
    requireValue(checkpoints[0]).res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(1);
    expect(effects).toBe(0);
    expect(requireValue(captures[0]).event).toMatchObject({
      phase: "before",
      toolCallId: "native-outer",
      innerCallId: 1,
      args: { value: "first" },
    });
    expect(requireValue(captures[0]).bytes).toContain('"name":"mcp_script"');
    requireValue(captures[0]).res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(2);
    expect(effects).toBe(1);
    const checkpoint = requireValue(captures[1]).bytes;
    expect(
      z.object({ structuredContent: z.unknown() }).parse(requireValue(captures[1]).event.result)
        .structuredContent,
    ).toEqual({
      id: "resource-1",
      value: "first",
    });
    requireValue(captures[1]).res.writeHead(200).end();
    await expect.poll(() => checkpoints.length).toBe(2);
    expect(checkpoints[1]).toMatchObject({
      toolCallId: "native-outer",
      operation: {
        toolCallId: "native-outer",
        innerCallId: 2,
        args: { value: "resource-1" },
      },
    });
    expect(requireValue(checkpoints[1]).artifacts).not.toContain(largeOutput); // Scripts retain raw JSON, without unused rendered-text work.
    expect(
      requireValue(checkpoints[1]).artifacts.map((bytes): unknown =>
        bytes.startsWith("{") ? JSON.parse(bytes) : null,
      ),
    ).toContainEqual(
      expect.objectContaining({
        content: [{ type: "text", text: largeOutput }],
        structuredContent: { id: "resource-1", value: "first" },
      }),
    );
    expect(captures).toHaveLength(2);
    expect(effects).toBe(1);
    checkpointMode = "pass";
    requireValue(checkpoints[1]).res.writeHead(200).end();
    await pending;
    await session.waitForIdle();
    expect(effects).toBe(2);
    expect(requireValue(captures[2]).event).toMatchObject({
      toolCallId: "native-outer",
      innerCallId: 2,
      args: { value: "resource-1" },
    });
    const scriptResult = requireValue(
      toolResults(
        sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message),
      ).find((message) => message.toolCallId === "native-outer"),
    );
    const scriptDetails = z
      .object({
        outputGuard: z.object({ fullOutputPath: z.string() }),
        resultRefs: z.array(z.string()),
      })
      .parse(scriptResult.details);
    const finalPath = scriptDetails.outputGuard.fullOutputPath;
    expect(dirname(dirname(finalPath))).toBe(outputDirectory);
    expect(await readFile(finalPath, "utf8")).toBe(
      [largeOutput, ...scriptDetails.resultRefs.map(formatMcpResultReference)].join("\n"),
    );
    const restoredPath = join(root, "restored.jsonl");
    await writeFile(restoredPath, checkpoint);
    const restored = SessionManager.open(restoredPath);
    const entries = restored
      .getEntries()
      .filter((entry) => entry.type === "custom")
      .filter((entry) => entry.customType === "fixture-mcp-call")
      .map((entry) => captureEventSchema.parse(entry.data));
    expect(entries.map((entry) => entry.phase)).toEqual(["before", "after"]);
    expect(requireValue(entries[1]).result).toMatchObject({
      structuredContent: { id: "resource-1" },
    });
    expect(effects).toBe(2); // Opening native history does not replay its script.

    const registered = session.extensionRunner.getAllRegisteredTools();
    for (const name of ["local_echo", "mcp", "mcp_script"]) {
      expect(
        requireValue(registered.find((t) => t.definition.name === name)).definition.executionMode,
      ).toBe("sequential");
    }
    const execute = async (name: string, id: string, params: unknown, signal?: AbortSignal) => {
      const definition = requireValue(
        registered.find((t) => t.definition.name === name),
      ).definition;
      const output = await definition.execute(
        id,
        params,
        signal,
        undefined,
        session.extensionRunner.createToolContext(id, signal),
      );
      return { ...output, details: z.record(z.string(), z.unknown()).parse(output.details) };
    };
    mode = "reject-before";
    const blocked = await execute("local_echo", "blocked-outer", { value: "never" });
    expect(blocked.details).toMatchObject({
      error: "call_capture_failed",
      recovery: { phase: "before", toolCallId: "blocked-outer" },
    });
    expect(effects).toBe(2);
    expect(JSON.stringify(blocked)).not.toContain("synthetic-secret-must-not-leak");
    mode = "reject-after";
    const interrupted = await execute("mcp_script", "interrupted-outer", { code: script });
    expect(interrupted.details).toMatchObject({
      error: "call_capture_failed",
      recovery: {
        phase: "after",
        toolCallId: "interrupted-outer",
        innerCallId: 1,
        args: { value: "first" },
        result: { structuredContent: { id: "resource-3" } },
      },
    });
    expect(effects).toBe(3); // Never hands an uncheckpointed result to dependent script work.
    expect(JSON.stringify(interrupted)).not.toContain("synthetic-secret-must-not-leak");
    mode = "hold";
    const controller = new AbortController();
    const stoppedCaptureCount = captures.length;
    const stopped = execute("mcp_script", "stopped-outer", { code: script }, controller.signal);
    await expect.poll(() => captures.length).toBe(stoppedCaptureCount + 1);
    controller.abort(new Error("Stop"));
    expect((await stopped).details.error).toBe("aborted");
    expect(effects).toBe(3);
    mode = "pass";
    const proxy = await execute("mcp", "proxy-outer", {
      tool: "local_echo",
      args: { value: "proxy" },
    });
    expect(proxy.details.error).toBeUndefined();
    expect(requireValue(captures.at(-1)).event).toMatchObject({
      phase: "after",
      toolCallId: "proxy-outer",
      args: { value: "proxy" },
    });
    expect(requireValue(captures.at(-1)).event.innerCallId).toBeUndefined();
    expect(effects).toBe(4);
    const lost = await execute("mcp_script", "lost-outer", {
      code: 'await tools.local_echo({ value: ["lose", "response"].join("-") });',
    });
    expect(lost.details.calls).toMatchObject([
      {
        error: "ambiguous_outcome",
        recovery: { toolCallId: "lost-outer", innerCallId: 1, action: "readback" },
      },
    ]);
    expect(textBlock(lost.content[0])).toContain("Read back the original operation");
    expect(effects).toBe(5);
    const lostPath = join(root, "lost-response.jsonl");
    await writeFile(lostPath, requireValue(captures.at(-1)).bytes);
    const lostHistory = SessionManager.open(lostPath)
      .getEntries()
      .filter((entry) => entry.type === "custom")
      .filter((entry) => entry.customType === "fixture-mcp-call")
      .map((entry) => captureEventSchema.parse(entry.data));
    const intent = requireValue(lostHistory.at(-2));
    expect(intent).toMatchObject({
      phase: "before",
      toolCallId: "lost-outer",
      innerCallId: 1,
      args: { value: "lose-response" },
    });
    const readback = await execute("mcp", "readback-outer", {
      tool: "local_readback",
      args: intent.args,
    });
    expect(
      z.object({ structuredContent: z.unknown() }).parse(readback.details.mcpResult)
        .structuredContent,
    ).toEqual({
      id: "resource-5",
      value: "lose-response",
    });
    expect(requireValue(captures.at(-1)).event.result).toMatchObject({
      structuredContent: { id: "resource-5" },
    });
    expect(effects).toBe(5);
    expect(checkpoints.map((c) => c.toolCallId)).toEqual([
      "native-outer",
      "native-outer",
      "blocked-outer",
      "interrupted-outer",
      "stopped-outer",
      "proxy-outer",
      "lost-outer",
      "readback-outer",
    ]);
    checkpointMode = "reject";
    await expect(execute("local_echo", "checkpoint-rejected", { value: "never" })).rejects.toThrow(
      "checkpoint unavailable",
    );
    expect(effects).toBe(5);
    const beforeRejectedScript = captures.length;
    const rejectedScript = await execute("mcp_script", "checkpoint-script-rejected", {
      code: `
      const failed = await tools.local_echo({ value: "never" });
      const catalog = await tools.describe({ path: "local_echo" });
      return { failed, name: catalog.name };
    `,
    });
    expect(rejectedScript.details.error).toBeUndefined();
    expect(JSON.parse(textBlock(rejectedScript.content[0]))).toMatchObject({
      failed: { ok: false, error: { code: "call_failed" } },
      name: "echo",
    });
    expect(captures).toHaveLength(beforeRejectedScript);
    expect(effects).toBe(5);

    for (const entry of ["direct", "proxy", "script"]) {
      checkpointMode = "hold";
      const beforeCount = checkpoints.length;
      const captureCount = captures.length;
      const { name, arguments: args } = entryCall(entry, "echo", { value: "never" });
      const id = `native-stop-${name}`;
      nativeCalls = [
        {
          type: "toolCall",
          id,
          name,
          arguments: entry === "script" ? { code: script } : args,
        },
      ];
      modelCalls = 0;
      const stopping = session.prompt(`fixture: stop ${name} during its checkpoint`);
      await expect.poll(() => checkpoints.length).toBe(beforeCount + 1);
      expect(requireValue(checkpoints.at(-1)).toolCallId).toBe(id);
      await session.abort();
      await stopping;
      await session.waitForIdle();
      requireValue(checkpoints.at(-1)).res.end();
      expect(modelCalls).toBe(1);
      expect(captures).toHaveLength(captureCount);
      expect(effects).toBe(5);
    }

    checkpointMode = "pass";
    mode = "pass";
    expect(registered.some((t) => t.definition.name === "local_read_saved_data")).toBe(false);
    const operationMetadata = new Map<
      string,
      Pick<McpOperationContext, "annotations" | "resourceUri">
    >([
      ["readback", { annotations: { readOnlyHint: true } }],
      ["upsert", { annotations: { readOnlyHint: false, idempotentHint: true } }],
      ["read_saved_data", { resourceUri }],
    ]);
    for (const { entry, names } of [
      { entry: "direct", names: ["readback", "upsert"] },
      { entry: "proxy", names: ["readback", "upsert", "read_saved_data"] },
      { entry: "script", names: ["readback", "upsert", "read_saved_data"] },
    ]) {
      for (const name of names) {
        const id = `${entry}-${name}`;
        const beforeCount = checkpoints.length;
        const captureCount = captures.length;
        const args = { value: id };
        const invocation = entryCall(entry, name, args);
        const output = await execute(invocation.name, id, invocation.arguments);
        expect(
          output.details.error,
          JSON.stringify({ id, details: output.details }),
        ).toBeUndefined();
        expect(checkpoints).toHaveLength(beforeCount + 1);
        const operation = requireValue(checkpoints.at(-1)).operation;
        expect(operation).toEqual({
          toolCallId: id,
          ...(entry === "script" ? { innerCallId: 1 } : {}),
          server: "local",
          tool: name,
          args,
          annotationsTrusted: true,
          ...requireValue(operationMetadata.get(name)),
        });
        const { annotationsTrusted: _trust, ...nativeFields } = requireValue(operation);
        expect(captures.slice(captureCount).map((c) => c.event.phase)).toEqual(["before", "after"]);
        expect(requireValue(captures[captureCount]).event).toEqual({
          ...nativeFields,
          phase: "before",
        });
        expect(requireValue(captures.at(-1)).event).toMatchObject({
          ...nativeFields,
          phase: "after",
        });
        expect(requireValue(captures.at(-1)).event).not.toHaveProperty("annotationsTrusted");
      }
    }
    await execute("untrusted_readback", "untrusted-read", { value: "untrusted" });
    expect(requireValue(checkpoints.at(-1)).operation).toEqual({
      toolCallId: "untrusted-read",
      server: "untrusted",
      tool: "readback",
      args: { value: "untrusted" },
      annotationsTrusted: false,
      annotations: { readOnlyHint: true },
    });

    // Keep invoking the old direct definition while the native live connection refreshes.
    for (const annotations of [undefined, { readOnlyHint: false }]) {
      readbackAnnotations = annotations;
      await execute("mcp", "refresh", { connect: "local" });
      expect(requireValue(checkpoints.at(-1)).operation).toBeUndefined();
      await execute("local_readback", "stale-direct", { value: "stale" });
      expect(requireValue(requireValue(checkpoints.at(-1)).operation).annotations).toEqual(
        annotations,
      );
      expect(requireValue(captures.at(-1)).event.annotations).toEqual(annotations);
    }
    for (const params of [{}, { search: "echo" }, { action: "ui-messages" }]) {
      const count = captures.length;
      await execute("mcp", "unresolved-mode", params);
      expect(requireValue(checkpoints.at(-1)).operation).toBeUndefined();
      expect(captures).toHaveLength(count);
    }

    // Inner calls stay parallel, with independent IDs and args even under one outer ID.
    checkpointMode = "hold";
    const checkpointCount = checkpoints.length;
    const parallelCaptureCount = captures.length;
    const parallel = execute("mcp_script", "parallel-outer", {
      code: `return Promise.all([
      tools.local_echo({ value: "parallel-first" }), tools.local_upsert({ value: "parallel-second" })
    ]);`,
    });
    await expect.poll(() => checkpoints.length).toBe(checkpointCount + 2);
    // Parallel HTTP arrivals need not match the script's native call order.
    const pair = checkpoints
      .slice(checkpointCount)
      .sort(
        (a, b) =>
          requireValue(requireValue(a.operation).innerCallId) -
          requireValue(requireValue(b.operation).innerCallId),
      );
    expect(
      pair.map((c) => [
        requireValue(c.operation).toolCallId,
        requireValue(c.operation).innerCallId,
        requireValue(c.operation).args.value,
      ]),
    ).toEqual([
      ["parallel-outer", 1, "parallel-first"],
      ["parallel-outer", 2, "parallel-second"],
    ]);
    requireValue(pair[1]).res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(parallelCaptureCount + 2);
    expect(captures.slice(parallelCaptureCount).map((c) => c.event.innerCallId)).toEqual([2, 2]);
    requireValue(pair[0]).res.writeHead(200).end();
    expect((await parallel).details.calls).toMatchObject([{ ok: true }, { ok: true }]);
    expect(captures.slice(parallelCaptureCount).map((c) => c.event.innerCallId)).toEqual([
      2, 2, 1, 1,
    ]);
  }, 20000);

  it.each([undefined, false])(
    "does not retry unless opted in (%s)",
    async (retryOnTransportFailure) => {
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        e.req.socket.destroy();
        return true;
      });
      const { state } = await f.connect(
        retryOnTransportFailure !== undefined ? { retryOnTransportFailure } : {},
      );
      expect((await call(state, "proxy")).ok).toBe(false);
      expect(f.calls()).toHaveLength(1);
    },
  );

  it.each([undefined, false])(
    "settles partial SSE loss without retry when disabled (%s)",
    async (retryOnTransportFailure) => {
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": started\n\n");
        setTimeout(() => e.res.destroy(), 20);
        return true;
      });
      const { state } = await f.connect(
        retryOnTransportFailure !== undefined ? { retryOnTransportFailure } : {},
      );
      const output = await call(state, "proxy");
      expect(output.ok).toBe(false);
      expect(output.details.message).not.toMatch(/timeout|timed out/i);
      expect(f.calls()).toHaveLength(1);
    },
  );

  it.each(["network", "http503", "sse"])("stops after the second %s failure", async (failure) => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      if (failure === "sse") {
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": started\n\n");
        setTimeout(() => e.res.destroy(), 20);
      } else if (failure === "network") {
        e.req.socket.destroy();
      } else {
        e.res.writeHead(503).end("service unavailable");
      }
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, "proxy");
    expect(output.ok).toBe(false);
    expect(output.details.message).not.toMatch(/timeout|timed out/i);
    expect(f.calls()).toHaveLength(2);
  });

  it.each(["plain", "json"])("retries a tool HTTP503 %s response once", async (body) => {
    const f = await fixture((e) => {
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.res
          .writeHead(503)
          .end(body === "plain" ? "service unavailable" : JSON.stringify({ error: "unavailable" }));
        return true;
      }
      return;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(new Set(f.calls().map((c) => c.body.id)).size).toBe(2);
  });

  it.each([
    "protocol",
    "http401",
    "http403",
    "http503-rpc",
    "http503-null-id",
    "tool",
    "invalid-json",
    "sse-protocol",
    "sse-tool",
  ])("does not retry %s errors", async (failure) => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      if (failure.startsWith("sse-")) {
        e.res.writeHead(200, { "content-type": "text/event-stream" }).end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: e.body.id,
            ...(failure === "sse-tool"
              ? { result: { resultType: "complete", isError: true, content: [] } }
              : { error: { code: -32602, message: "fixture rejection" } }),
          })}\n\n`,
        );
      } else if (failure === "http401" || failure === "http403") {
        e.res.writeHead(Number(failure.slice(4))).end("denied");
      } else if (failure === "tool") {
        result(e, { resultType: "complete", isError: true, content: [] });
      } else if (failure === "invalid-json") {
        e.res.writeHead(200, { "content-type": "application/json" }).end("not json");
      } else {
        rpcError(
          e,
          -32602,
          failure === "protocol" ? 200 : 503,
          failure === "http503-null-id" ? null : e.body.id,
        );
      }
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it("preserves streaming cancellation and trace identity without a cancellation POST", async () => {
    let closed = false;
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": waiting\n\n");
      e.res.on("close", () => {
        closed = true;
      });
      return true;
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-trace-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(directory, "trace.jsonl") });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    expect(connection.transport.hasPerRequestStream).toBe(true);
    const controller = new AbortController();
    const pending = call(state, "proxy", controller.signal);
    await expect.poll(() => f.calls().length).toBe(1);
    controller.abort(new Error("caller cancelled"));
    expect((await pending).details).toMatchObject({
      error: "ambiguous_outcome",
      recovery: { action: "readback" },
    });
    await expect.poll(() => closed).toBe(true);
    expect(f.calls()).toHaveLength(1);
    expect(
      f.requests.some((r) => r.body.method === "notifications/cancelled" || r.req.method === "GET"),
    ).toBe(false);
    await f.manager.closeAll();
    const trace = await readFile(join(directory, "trace.jsonl"), "utf8");
    expect(trace).toContain('"method":"tools/call"');
    expect(trace).not.toContain('"value":"test"');
  });

  it("settles and traces a pending SSE send on intentional manager shutdown without retry", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": started\n\n");
      return true;
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-close-trace-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    const traceFile = join(directory, "trace.jsonl");
    f.manager.setTraceConfig({ enabled: true, file: traceFile });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const send = connection.transport.send.bind(connection.transport);
    let settled = 0;
    connection.transport.send = (message, options) => {
      const pending = send(message, options);
      return "method" in message && message.method === "tools/call"
        ? pending.finally(() => {
            settled++;
          })
        : pending;
    };
    const pending = call(state, "proxy");
    await expect.poll(() => f.calls().length).toBe(1);
    await f.manager.closeAll();
    expect((await pending).details).toMatchObject({
      error: "ambiguous_outcome",
      recovery: { action: "readback" },
    });
    await expect.poll(() => settled).toBe(1);
    expect(f.calls()).toHaveLength(1);
    await expect.poll(() => readFile(traceFile, "utf8")).toContain('"method":"tools/call"');
    const events = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({ direction: z.string(), method: z.string().optional() })
          .loose()
          .parse(JSON.parse(line)),
      );
    expect(
      events.filter((e) => e.direction === "outbound" && e.method === "tools/call"),
    ).toMatchObject([{ id: requireValue(f.calls()[0]).body.id, status: "sent" }]);
  });

  it.each(["network", "sse"])(
    "keeps an absolute deadline across %s retry without reporting caller cancellation",
    async (failure) => {
      const f = await fixture(async (e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        if (f.calls().length === 1) {
          if (failure === "sse") {
            e.res.writeHead(200, { "content-type": "text/event-stream" });
            e.res.write(": started\n\n");
          }
          await delay(100);
          e.req.socket.destroy();
        }
        return true;
      });
      const { state } = await f.connect({ requestTimeoutMs: 160, retryOnTransportFailure: true });
      const started = performance.now();
      const output = await call(state, "proxy");
      expect(output.details).toMatchObject({
        error: "ambiguous_outcome",
        recovery: { action: "readback" },
      });
      expect(performance.now() - started).toBeLessThan(240);
      expect(f.calls()).toHaveLength(2);
    },
  );

  it.each(["open", "closed"])(
    "does not infer transport failure from a clean %s SSE stream",
    async (ending) => {
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": waiting\n\n");
        if (ending === "closed") {
          setTimeout(() => e.res.end(), 10);
        }
        return true;
      });
      const { state } = await f.connect({ requestTimeoutMs: 40, retryOnTransportFailure: true });
      expect((await call(state, "proxy")).ok).toBe(false);
      expect(f.calls()).toHaveLength(1);
    },
  );

  it("does not stack modern retries after legacy session recovery", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(f.calls().length === 1 ? 404 : 503).end("session unavailable");
      return true;
    });
    const { state } = await f.connect({ protocolVersion: "legacy", retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(2);
    expect(f.requests.filter((r) => r.body.method === "initialize")).toHaveLength(2);
  });

  it("delivers a chunked modern POST SSE result and adapter stream notifications", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: SERVER_STREAM_RESULT_PATCH_METHOD,
          params: {
            streamToken: "stream",
            result: { content: [{ type: "text", text: "partial" }] },
          },
        })}\n\n`,
      );
      const frame = `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: e.body.id,
        result: { resultType: "complete", content: [{ type: "text", text: "streamed" }] },
      })}\n\n`;
      e.res.write(frame.slice(0, 30));
      setTimeout(() => e.res.end(frame.slice(30)), 5);
      return true;
    });
    const { state } = await f.connect();
    const patches: unknown[] = [];
    f.manager.registerUiStreamListener("stream", (_name, patch) => patches.push(patch));
    const output = await call(state, "proxy");
    expect(output.ok).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "streamed" }]);
    expect(patches).toEqual([
      { streamToken: "stream", result: { content: [{ type: "text", text: "partial" }] } },
    ]);
    expect(f.requests.every((r) => r.req.method === "POST")).toBe(true);
  });

  it.each([
    ["json", "end"],
    ["json", "destroy"],
    ["envelope", "end"],
    ["envelope", "destroy"],
  ])("does not retry malformed SSE %s followed by %s", async (invalid, ending) => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(
        `event: message\ndata: ${invalid === "json" ? "not json" : '{"unexpected":true}'}\n\n`,
      );
      setTimeout(() => (ending === "end" ? e.res.end() : e.res.destroy()), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, "proxy");
    expect(output.ok).toBe(false);
    expect(output.details.message).not.toMatch(/timeout|timed out|terminated/i);
    expect(f.calls()).toHaveLength(1);
  });

  it("returns a complete result before EOF and keeps late stream notifications without replay", async function observesLateSseError() {
    let stream: ServerResponse | undefined;
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      stream = e.res;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: e.body.id,
          result: { resultType: "complete", content: [{ type: "text", text: "complete" }] },
        })}\n\n`,
      );
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const patches: unknown[] = [];
    const errors: Error[] = [];
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-010: the native MCP Client exposes only this error callback.
    connection.client.onerror = (error) => errors.push(error);
    f.manager.registerUiStreamListener("late", (_name, patch) => patches.push(patch));
    expect((await call(state, "proxy")).content).toEqual([{ type: "text", text: "complete" }]);
    requireValue(stream).write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "late",
          result: { content: [{ type: "text", text: "after result" }] },
        },
      })}\n\n`,
    );
    await expect.poll(() => patches.length).toBe(1);
    requireValue(stream).destroy();
    await expect.poll(() => errors.length).toBe(1);
    expect(f.calls()).toHaveLength(1);
    expect(connection.inFlight).toBe(0);
  });

  it("does not interrupt or replay an accepted sibling while recovering partial SSE loss", async () => {
    let accepted: Exchange | undefined;
    let attempts = 0;
    const f = await fixture((e) => {
      if (e.body.method !== "tools/call") {
        return;
      }
      if (e.body.params.arguments.sibling === true) {
        accepted = e;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": accepted\n\n");
        return true;
      }
      if (++attempts > 1) {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": started\n\n");
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const sibling = executeCall(state, { toolName: "local_echo", args: { sibling: true } });
    await expect.poll(() => accepted !== undefined).toBe(true);
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(requireValue(accepted).res.destroyed).toBe(false);
    requireValue(accepted).res.end(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: requireValue(accepted).body.id,
        result: { resultType: "complete", content: [{ type: "text", text: "sibling result" }] },
      })}\n\n`,
    );
    expect((await sibling).content).toEqual([{ type: "text", text: "sibling result" }]);
    expect(f.calls().filter((c) => c.body.params.arguments.sibling === true)).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(f.manager.getConnection("local")?.client).toBe(connection.client);
    expect(connection.inFlight).toBe(0);
  });

  it("does not attribute a nested catalog's lost response to the tool stream", async () => {
    let lists = 0;
    const f = await fixture((e) => {
      if (e.body.method === "tools/list" && ++lists > 1) {
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": catalog\n\n");
        setTimeout(() => e.res.destroy(), 20);
        return true;
      }
      if (e.body.method !== "tools/call") {
        return;
      }
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: SERVER_STREAM_RESULT_PATCH_METHOD,
          params: { streamToken: "catalog", result: { content: [] } },
        })}\n\n`,
      );
      setTimeout(() => e.res.end(), 60);
      return true;
    });
    const { state, connection } = await f.connect({
      retryOnTransportFailure: true,
      requestTimeoutMs: 150,
    });
    let catalog: Promise<unknown> | undefined;
    f.manager.registerUiStreamListener("catalog", () => {
      catalog = connection.client
        .listTools(undefined, { cacheMode: "refresh", timeout: 100 })
        .catch((error: unknown) => error);
    });
    expect((await call(state, "proxy")).ok).toBe(false);
    await catalog;
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["end", "destroy"])("leaves native SSE resumption in charge after %s", async (ending) => {
    let id: WireRequest["id"];
    const f = await fixture((e) => {
      if (e.req.method === "GET") {
        e.res.writeHead(200, { "content-type": "text/event-stream" }).end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", content: [{ type: "text", text: "resumed" }] },
          })}\n\n`,
        );
        return true;
      }
      if (e.body.method !== "tools/call") {
        return;
      }
      id = e.body.id;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write("id: resume-token\nretry: 1\ndata:\n\n");
      setTimeout(() => (ending === "end" ? e.res.end() : e.res.destroy()), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).content).toEqual([{ type: "text", text: "resumed" }]);
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.filter((r) => r.req.method === "GET")).toHaveLength(1);
    expect(
      requireValue(f.requests.find((request) => request.req.method === "GET")).req.headers[
        "last-event-id"
      ],
    ).toBe("resume-token");
  });

  it.each([401, 403])(
    "does not replace native resumption HTTP%s with a fresh tool POST",
    async (status) => {
      const f = await fixture((e) => {
        if (e.req.method === "GET") {
          e.res.writeHead(status).end("denied");
          return true;
        }
        if (e.body.method !== "tools/call") {
          return;
        }
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write("id: resume-token\nretry: 1\ndata:\n\n");
        setTimeout(() => e.res.destroy(), 20);
        return true;
      });
      const { state } = await f.connect({ retryOnTransportFailure: true });
      expect((await call(state, "proxy")).ok).toBe(false);
      expect(f.calls()).toHaveLength(1);
      expect(f.requests.some((r) => r.req.method === "GET")).toBe(true);
    },
  );

  it("refreshes modern catalogs through the native POST subscription and closes it on shutdown", async () => {
    let stream: ServerResponse | undefined;
    let subscriptionId: WireRequest["id"];
    let lists = 0;
    let closed = false;
    const f = await fixture((e) => {
      if (e.body.method === "server/discover") {
        result(e, { ...modern, capabilities: { tools: { listChanged: true } } });
        return true;
      }
      if (e.body.method === "subscriptions/listen") {
        stream = e.res;
        subscriptionId = e.body.id;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: {
              _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId },
              notifications: { toolsListChanged: true },
            },
          })}\n\n`,
        );
        e.res.on("close", () => {
          closed = true;
        });
        return true;
      }
      if (e.body.method === "tools/list") {
        result(e, {
          resultType: "complete",
          tools: [{ ...tool, name: ++lists === 1 ? "before" : "after" }],
        });
        return true;
      }
      return;
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-subscription-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(directory, "trace.jsonl") });
    const { connection } = await f.connect();
    expect(requireValue(connection.tools[0]).name).toBe("before");
    requireValue(stream).write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } },
      })}\n\n`,
    );
    await expect.poll(() => requireValue(connection.tools[0]).name).toBe("after");
    expect(f.requests.filter((r) => r.body.method === "subscriptions/listen")).toHaveLength(1);
    expect(f.requests.some((r) => r.req.method === "GET")).toBe(false);
    await f.manager.closeAll();
    await expect.poll(() => closed).toBe(true);
  });

  it.each([2000, 150])(
    "preserves native multi-round-trip state, IDs and the %ims service deadline",
    async (requestTimeoutMs) => {
      const timeline: Array<{ phase: string; elapsedMs: number }> = [];
      let started = 0;
      const mark = (phase: string) => {
        timeline.push({ phase, elapsedMs: performance.now() - started });
      };
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        mark("tools/call");
        if (f.calls().length > 1) {
          return;
        }
        result(e, {
          resultType: "input_required",
          requestState: "opaque-state",
          inputRequests: {},
        });
        mark("input_required sent");
        return true;
      });
      // The SDK paces requestState-only legs by 250ms. Test state/IDs with room
      // for that native pause, and separately prove it cannot reset the deadline.
      const { state } = await f.connect({ retryOnTransportFailure: true, requestTimeoutMs });
      started = performance.now();
      mark("call started");
      const output = await call(state, "proxy");
      mark("call settled");
      expect(
        output.ok,
        JSON.stringify({ output, timeline, calls: f.calls().map(({ body }) => body) }),
      ).toBe(requestTimeoutMs === 2000);
      const timeoutMessage: unknown = expect.stringMatching(/timeout|timed out/i);
      expect({ error: output.details.error, message: output.details.message }).toEqual(
        requestTimeoutMs === 150
          ? { error: "call_failed", message: timeoutMessage }
          : { error: undefined, message: undefined },
      );
      const count = requestTimeoutMs === 150 ? 1 : 2;
      expect(f.calls()).toHaveLength(count);
      expect(new Set(f.calls().map((request) => request.body.id)).size).toBe(count);
      expect(f.calls().map((request) => request.body.params.requestState)).toEqual(
        requestTimeoutMs === 150 ? [undefined] : [undefined, "opaque-state"],
      );
    },
  );

  it.each([404, 405, 406, 415])(
    "connects deprecated SSE only after HTTP%s endpoint rejection",
    async (status) => {
      let stream: ServerResponse | undefined;
      let stall = false;
      const f = await fixture((e) => {
        if (e.req.url === "/mcp" && e.req.method === "POST") {
          e.res.writeHead(status).end();
          return true;
        }
        if (e.req.url === "/mcp" && e.req.method === "GET") {
          stream = e.res;
          e.res.writeHead(200, { "content-type": "text/event-stream" });
          e.res.write("event: endpoint\ndata: /messages\n\n");
          return true;
        }
        if (e.req.url !== "/messages") {
          return;
        }
        if (e.body.id !== undefined && !(stall && e.body.method === "tools/call")) {
          let payload: unknown = { content: [{ type: "text", text: "ok" }] };
          if (e.body.method === "initialize") {
            payload = {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "sse", version: "1" },
            };
          } else if (e.body.method === "tools/list") {
            payload = { tools: [tool] };
          }
          requireValue(stream).write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id, result: payload })}\n\n`,
          );
        }
        e.res.writeHead(202).end();
        return true;
      });
      const { state, connection } = await f.connect();
      expect(connection.client.getProtocolEra()).toBe("legacy");
      expect((await call(state, "proxy")).ok).toBe(true);
      expect(f.requests.filter((r) => r.req.method === "GET")).toHaveLength(1);
      expect(
        f.requests.filter((r) => r.req.url === "/messages" && r.body.method === "initialize"),
      ).toHaveLength(1);
      stall = true;
      connection.definition.requestTimeoutMs = 80;
      expect((await call(state, "proxy")).details).toMatchObject({
        error: "ambiguous_outcome",
        recovery: { action: "readback" },
      });
      expect(f.calls()).toHaveLength(2);
    },
  );

  it("closes an in-flight native discover request when connect is cancelled", async () => {
    let closed = false;
    const f = await fixture((e) => {
      if (e.body.method !== "server/discover") {
        return;
      }
      e.res.on("close", () => {
        closed = true;
      });
      return true;
    });
    const controller = new AbortController();
    const pending = f.manager.connect("local", { url: f.url, auth: false }, controller.signal);
    const rejection = Promise.allSettled([pending]);
    await expect.poll(() => f.requests.length).toBe(1);
    controller.abort(new Error("cancel discovery"));
    const [settled] = await rejection;
    assert.ok(settled.status === "rejected");
    const reason: unknown = settled.reason;
    assert.ok(reason instanceof Error);
    expect(reason.message).toContain("cancel discovery");
    await expect.poll(() => closed).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["direct", "proxy", "script"])(
    "preserves null structured content through %s",
    async (entry) => {
      const f = await fixture((e) => {
        if (e.body.method !== "tools/call") {
          return;
        }
        result(e, { resultType: "complete", content: [], structuredContent: null });
        return true;
      });
      const { state } = await f.connect({ requestTimeoutMs: 500.5 });
      const output = await call(state, entry);
      expect(output.ok, JSON.stringify(output)).toBe(true);
      const scriptData: unknown = expect.objectContaining({ structuredContent: null });
      expect(entry === "script" ? output.data : output.content[0]).toEqual(
        entry === "script" ? scriptData : { type: "text", text: "null" },
      );
      expect(
        entry === "script" ||
          textBlock(output.content[1]).includes(z.string().parse(output.details.resultRef)),
      ).toBe(true);
    },
  );

  it("discovers every tool when changing catalog pages reuse the same cursor", async () => {
    let page = 0;
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      result(e, {
        resultType: "complete",
        tools: [{ ...tool, name: `tool-${page}` }],
        ...(page < 2 ? { nextCursor: "opaque" } : {}),
      });
      page++;
      return true;
    });
    expect((await f.connect()).connection.tools.map((item) => item.name)).toEqual([
      "tool-0",
      "tool-1",
      "tool-2",
    ]);
    expect(page).toBe(3);
  });

  it("preserves catalogs longer than the native default 64-page cap", async () => {
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      const page = Number(e.body.params.cursor ?? 0);
      result(e, {
        resultType: "complete",
        tools: [{ ...tool, name: `tool-${page}` }],
        ...(page < 65 ? { nextCursor: String(page + 1) } : {}),
      });
      return true;
    });
    expect((await f.connect()).connection.tools).toHaveLength(66);
  });

  it("rejects a never-ending changing catalog instead of publishing a partial list", async () => {
    let pages = 0;
    const f = await fixture((e) => {
      if (e.body.method !== "tools/list") {
        return;
      }
      pages++;
      if (pages > 1024) {
        rpcError(e, -32603);
        return true;
      }
      result(e, {
        resultType: "complete",
        tools: [{ ...tool, name: `tool-${pages}` }],
        nextCursor: "opaque",
      });
      return true;
    });
    await expect(f.connect()).rejects.toMatchObject({ code: SdkErrorCode.ListPaginationExceeded });
    expect(pages).toBe(1024);
    expect(f.manager.getConnection("local")).toBeUndefined();
  });
});
