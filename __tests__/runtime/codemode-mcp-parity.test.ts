import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text as readStreamText } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import { CallToolRequestSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { createMcpAdapter } from "../../index.ts";
import { asObjectRecord } from "../../mcp-output-values.ts";
import {
  attachRawMcpResult,
  nativeMcpResult,
  withMcpScriptOutput,
} from "../../mcp-script-output.ts";

/** Valid 1x1 transparent PNG in base64 (accepted by Pi codemode's `image()` signature check). */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const SERVER_INSTRUCTIONS = "Use kb tools to inspect project records.";
const SERVER_DESCRIPTION = "Knowledge base documents";

const TYPED_OUTPUT_SCHEMA = {
  type: "object",
  $defs: {
    Row: {
      type: "object",
      properties: { id: { type: "number" }, label: { type: "string" } },
      required: ["id", "label"],
    },
  },
  definitions: {
    Summary: {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    },
  },
  properties: {
    rows: { type: "array", items: { $ref: "#/$defs/Row" } },
    summary: { $ref: "#/definitions/Summary" },
  },
  required: ["rows", "summary"],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function handleToolCall(message: unknown): unknown {
  const { params } = CallToolRequestSchema.parse(message);
  const args = params.arguments ?? {};
  if (params.name === "plain_rows") {
    const size = typeof args.size === "number" ? args.size : 60_000;
    const payload = { kind: "plain", body: "a".repeat(size) };
    return {
      resultType: "complete",
      content: [
        { type: "text", text: JSON.stringify(payload), _meta: { private: "block-secret" } },
      ],
      _meta: { private: "top-secret" },
    };
  }
  if (params.name === "typed_rows") {
    const structured = { rows: [{ id: 1, label: "alpha" }], summary: { total: 1 } };
    return {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
      ...(args.fail === true ? { isError: true } : {}),
    };
  }
  if (params.name === "preview_png") {
    return {
      resultType: "complete",
      content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
    };
  }
  return { resultType: "complete", content: [{ type: "text", text: "gated-ran" }] };
}

function handleRpcMethod(method: string): unknown {
  switch (method) {
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS,
      };
    case "initialize":
      return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "kb-fixture", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      };
    case "tools/list":
      return {
        resultType: "complete",
        ttlMs: 1000,
        cacheScope: "private",
        tools: [
          {
            name: "plain_rows",
            description: "Fetch plain rows",
            inputSchema: {
              type: "object",
              properties: { size: { type: "number" } },
            },
          },
          {
            name: "typed_rows",
            description: "Fetch typed rows",
            inputSchema: {
              type: "object",
              properties: { fail: { type: "boolean" } },
            },
            outputSchema: TYPED_OUTPUT_SCHEMA,
          },
          {
            name: "preview_png",
            description: "Render a PNG preview",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "gated",
            description: "Approval-gated action",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    case "resources/list":
      return { resultType: "complete", resources: [] };
    default:
      return { resultType: "complete" };
  }
}

async function serveFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const message = JSONRPCMessageSchema.parse(JSON.parse(await readStreamText(request)));
  if (!("method" in message) || message.method.startsWith("notifications/")) {
    response.writeHead(202).end();
    return;
  }
  assert.ok("id" in message);
  const result =
    message.method === "tools/call" ? handleToolCall(message) : handleRpcMethod(message.method);
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

async function startFixtureServer(): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    serveFixtureRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
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
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}/mcp`;
}

function createFixtureStream(
  model: Model<"openai-completions">,
  call: { name: string; arguments: JsonObject } | undefined,
  id: string,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: call
      ? [{ type: "toolCall", id, name: call.name, arguments: call.arguments }]
      : [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: call ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (call) {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id, name: call.name, arguments: call.arguments },
        partial: message,
      });
    } else {
      stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
    }
    stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
    stream.end();
  });
  return stream;
}

async function createCodemodeSession(options?: { readonly enableCodemode?: boolean }) {
  const url = await startFixtureServer();
  const root = await mkdtemp(join(tmpdir(), "mcp-208-codemode-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model: Model<"openai-completions"> = {
    id: "fixture",
    name: "fixture",
    api: "openai-completions",
    provider: "fixture",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  modelRuntime.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fixture",
    api: "openai-completions",
    models: [model],
  });
  const adapter = createMcpAdapter({
    config: {
      mcpServers: {
        kb: {
          url,
          auth: false,
          lifecycle: "eager",
          description: SERVER_DESCRIPTION,
        },
      },
      settings: {
        sampling: false,
        elicitation: false,
        approveTools: ["gated"],
      },
    },
    outputDirectory: join(root, "output"),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      adapter,
      createCodemodeExtension({ models: false }),
      createToolSearchExtension(),
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(root),
    noTools: "builtin",
  });
  await session.bindExtensions({
    mode: "print",
    onError(error) {
      throw new Error(error.error);
    },
  });
  cleanups.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const run = async (name: string, args: JsonObject): Promise<ToolResultMessage> => {
    let issued = false;
    const before = session.messages.length;
    session.agent.streamFunction = () => {
      const call = issued ? undefined : { name, arguments: args };
      issued = true;
      return createFixtureStream(model, call, `call-${before}`);
    };
    await session.prompt("run");
    const found = session.messages.slice(before).find((entry) => entry.role === "toolResult");
    assert.ok(found, `expected toolResult for ${name}`);
    return found;
  };

  const connected = await run("mcp", { action: "connect", server: "kb" });
  expect(connected.isError).toBe(false);
  if (options?.enableCodemode !== false) {
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  }
  return { session, run };
}

function textBlocks(result: ToolResultMessage): string[] {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

describe("Pi codemode MCP CallToolResult parity", () => {
  it("delivers untruncated >50 KiB CallToolResult payloads, image blocks, $ref declarations, and namespace aliases", async () => {
    const { run } = await createCodemodeSession();

    const coded = await run("codemode", {
      code: `
        const large = await tools.mcp__kb__plain_rows({ size: 60000 });
        const parsedLarge = JSON.parse(large.content[0].text);
        const typed = await tools.mcp__kb__typed_rows({});
        const typedErr = await tools.mcp__kb__typed_rows({ fail: true });
        const png = await tools.mcp__kb__preview_png({});
        image(png.content[0]);
        let gatedError = null;
        try {
          await tools.mcp__kb__gated({});
        } catch (error) {
          gatedError = error.message;
        }
        const decl = await describeTool("mcp__kb__typed_rows");
        const ns = await describeNamespace("kb");
        const found = await searchTools("rows", { namespace: "kb" });
        const boilerplateNoise = await searchTools("read-result", { namespace: "kb" });
        const gatewayLarge = await tools.mcp({
          action: "call",
          server: "kb",
          tool: "plain_rows",
          args: { size: 25000 },
          format: "structured",
        });
        const gatewayText = await tools.mcp({
          action: "call",
          server: "kb",
          tool: "typed_rows",
          args: {},
        });
        text({
          largeLength: parsedLarge.body.length,
          hasMeta: "_meta" in large || "_meta" in large.content[0],
          typedStructured: typed.structuredContent,
          typedErrIsError: typedErr.isError,
          typedErrStructured: typedErr.structuredContent,
          gatedError,
          decl,
          ns,
          foundNames: found.map((entry) => entry.name),
          boilerplateMatches: boilerplateNoise.map((entry) => entry.name),
          gatewayLargeOmitted: gatewayLarge.mcpAdapter.omitted,
          gatewayLargeBodyLength: JSON.parse(gatewayLarge.mcpResult.content[0].text).body.length,
          gatewayLargeHasRef: typeof gatewayLarge.mcpAdapter.resultRef === "string",
          gatewayText,
        });
      `,
    });

    expect(coded.isError, textBlocks(coded).join("\n")).toBe(false);
    expect(coded.content.some((block) => block.type === "image")).toBe(true);
    const texts = textBlocks(coded);
    expect(texts.some((block) => block.includes("[Image saved to"))).toBe(true);
    const jsonBlock = texts.at(-1);
    assert.ok(jsonBlock !== undefined);
    const payload = z
      .object({
        largeLength: z.number(),
        hasMeta: z.boolean(),
        typedStructured: z.object({
          rows: z.array(z.object({ id: z.number(), label: z.string() })),
          summary: z.object({ total: z.number() }),
        }),
        typedErrIsError: z.boolean(),
        typedErrStructured: z.unknown(),
        gatedError: z.string(),
        decl: z.string(),
        ns: z.object({
          name: z.string(),
          description: z.string(),
          instructions: z.string(),
          tools: z.array(z.string()),
        }),
        foundNames: z.array(z.string()),
        boilerplateMatches: z.array(z.string()),
        gatewayLargeOmitted: z.boolean(),
        gatewayLargeBodyLength: z.number(),
        gatewayLargeHasRef: z.boolean(),
        gatewayText: z.string(),
      })
      .parse(JSON.parse(jsonBlock));

    expect(payload.largeLength).toBe(60_000);
    expect(payload.hasMeta).toBe(false);
    expect(payload.typedStructured).toEqual({
      rows: [{ id: 1, label: "alpha" }],
      summary: { total: 1 },
    });
    expect(payload.typedErrIsError).toBe(true);
    expect(payload.typedErrStructured).toEqual(payload.typedStructured);
    expect(payload.gatedError).toMatch(/approval-gated/);
    // Relocated $defs and definitions must resolve into rendered TypeScript types, not `unknown`.
    expect(payload.decl).toContain("rows: Array<{ id: number; label: string; }>");
    expect(payload.decl).toContain("summary: { total: number; }");
    expect(payload.ns).toEqual({
      name: "mcp_kb",
      description: SERVER_DESCRIPTION,
      instructions: SERVER_INSTRUCTIONS,
      tools: [
        "mcp__kb__plain_rows",
        "mcp__kb__typed_rows",
        "mcp__kb__preview_png",
        "mcp__kb__gated",
      ],
    });
    expect(payload.foundNames.sort()).toEqual(["mcp__kb__plain_rows", "mcp__kb__typed_rows"]);
    expect(payload.boilerplateMatches).toEqual([]);
    expect(payload.gatewayLargeOmitted).toBe(false);
    expect(payload.gatewayLargeBodyLength).toBe(25_000);
    expect(payload.gatewayLargeHasRef).toBe(true);
    // Deduplicated direct display text does not emit a duplicate JSON block.
    expect(payload.gatewayText).toBe(JSON.stringify(payload.typedStructured));
  }, 20_000);

  it("keeps model-facing direct calls bounded and deduplicated while preserving details limits", async () => {
    // Keep codemode inactive so tool_search loads kb_typed_rows into active tools even on fork Pi
    // where codemode + non-mid-convo-tool models stay inline to preserve prompt cache.
    const { run } = await createCodemodeSession({ enableCodemode: false });

    const loaded = await run("tool_search", { query: "typed rows" });
    expect(loaded.isError, textBlocks(loaded).join("\n")).toBe(false);

    const directTyped = await run("mcp__kb__typed_rows", {});
    expect(directTyped.isError, textBlocks(directTyped).join("\n")).toBe(false);
    expect(directTyped.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ rows: [{ id: 1, label: "alpha" }], summary: { total: 1 } }),
      },
    ]);

    const directLarge = await run("mcp", {
      action: "call",
      server: "kb",
      tool: "plain_rows",
      args: { size: 60_000 },
    });
    expect(directLarge.isError).toBe(false);
    const details = z
      .object({
        mcpResult: z.object({ omitted: z.literal(true) }),
        resultRef: z.string(),
        outputGuard: z.object({ truncated: z.literal(true) }),
      })
      .parse(directLarge.details);
    expect(details.mcpResult.omitted).toBe(true);
  }, 20_000);

  it("preserves own __proto__ keys in structuredContent across direct and structured gateway results", () => {
    const rawStructured: Record<string, unknown> = Object.defineProperty({ a: 2 }, "__proto__", {
      value: { x: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const raw = { content: [{ type: "text", text: "ok" }], structuredContent: rawStructured };
    const base = attachRawMcpResult(
      { content: [{ type: "text" as const, text: "ok" }], details: {} },
      raw,
    );

    const direct = nativeMcpResult(base);
    const directStructured = asObjectRecord(
      asObjectRecord(direct.structuredContent)?.structuredContent,
    );
    assert.ok(directStructured !== undefined);
    expect(Object.hasOwn(directStructured, "__proto__")).toBe(true);
    expect(directStructured["__proto__"]).toEqual({ x: 1 });
    expect(directStructured.a).toBe(2);

    const gateway = withMcpScriptOutput(base);
    const gatewayMcpResult = asObjectRecord(asObjectRecord(gateway.structuredContent)?.mcpResult);
    const gatewayStructured = asObjectRecord(gatewayMcpResult?.structuredContent);
    assert.ok(gatewayStructured !== undefined);
    expect(Object.hasOwn(gatewayStructured, "__proto__")).toBe(true);
    expect(gatewayStructured["__proto__"]).toEqual({ x: 1 });
  });
});
