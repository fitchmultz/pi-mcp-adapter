import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkErrorCode } from "@modelcontextprotocol/client";
import type { ToolCall } from "@earendil-works/pi-ai";
import { McpServerManager } from "../server-manager.ts";
import { executeCall, executeDescribe } from "../proxy-modes.ts";
import { computeServerHash, reconstructToolMetadata, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { createDirectToolExecutor, resolveDirectTools } from "../direct-tools.ts";
import { runMcpScript } from "../mcp-code.ts";
import type { McpExtensionState } from "../state.ts";
import { SERVER_STREAM_RESULT_PATCH_METHOD, type McpOperationContext, type ServerEntry } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

type WireRequest = { id?: string | number | null; method?: string; params?: any };
type Exchange = { req: IncomingMessage; res: ServerResponse; body: WireRequest };
const tool = { name: "echo", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } };
const modern = {
  resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
  instructions: "Local fixture instructions",
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "local-wire", version: "1" } },
};
function result({ res, body }: Exchange, payload: unknown, headers = {}) {
  if (body.method?.endsWith("/list")) payload = { ttlMs: 60_000, cacheScope: "private", ...payload as object };
  res.writeHead(200, { "content-type": "application/json", ...headers })
    .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: payload }));
}
function rpcError({ res, body }: Exchange, code: number, status = 200, id = body.id) {
  res.writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "fixture rejection" } }));
}
async function fixture(handler: (exchange: Exchange) => boolean | void | Promise<boolean | void> = () => {}) {
  const requests: Exchange[] = [];
  let sessions = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks).toString("utf8");
    const exchange = { req, res, body: data ? JSON.parse(data) : {} };
    requests.push(exchange);
    if (await handler(exchange)) return;
    const { body } = exchange;
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (body.method === "server/discover") return result(exchange, modern);
    if (body.method === "initialize") return result(exchange, {
      protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "legacy", version: "1" },
    }, { "mcp-session-id": `session-${++sessions}` });
    if (body.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    if (body.method === "tools/list") return result(exchange, { resultType: "complete", tools: [tool] });
    if (body.method === "tools/call") return result(exchange, {
      resultType: "complete", content: [{ type: "text", text: "ok" }], structuredContent: body.params?.arguments ?? {},
    });
    rpcError(exchange, -32601);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const calls = () => requests.filter(r => r.body.method === "tools/call");
  const connect = async (options: ServerEntry = {}) => {
    const definition = { url, auth: false as const, requestTimeoutMs: 500, ...options };
    const connection = await manager.connect("local", definition);
    const state = {
      manager, config: { mcpServers: { local: definition }, settings: {} },
      toolMetadata: new Map([["local", buildToolMetadata(connection.tools, [], definition, "local", "server").metadata]]),
      failureTracker: new Map(), serverInstructions: new Map(), completedUiSessions: [],
    } as unknown as McpExtensionState;
    return { connection, state };
  };
  return { manager, url, requests, calls, connect };
}

async function call(state: McpExtensionState, entry: string, signal?: AbortSignal) {
  if (entry === "script") {
    const output = await runMcpScript(state, 'return await tools.local_echo({ value: "test" });', 2000, undefined, signal);
    const text = output.content.filter(c => c.type === "text").at(-1);
    return text?.type === "text" ? JSON.parse(text.text) : undefined;
  }
  const output = entry === "direct"
    ? await createDirectToolExecutor(() => state, () => null, {
        serverName: "local", originalName: "echo", prefixedName: "local_echo", description: "Echo",
      })("call-id", { value: "test" }, signal, undefined, {} as any)
    : await executeCall(state, "local_echo", { value: "test" }, undefined, undefined, signal);
  return { ok: output.details.error === undefined, ...output };
}

describe("published SDK v2 over real local HTTP", () => {
  it.each([
    { protocolVersion: "future" }, { retryOnTransportFailure: "true" },
    { oauth: { skipIssuerMetadataValidation: "true" } },
  ])("rejects invalid in-memory protocol options before connecting: %j", async invalid => {
    const f = await fixture();
    await expect(f.connect(invalid as unknown as ServerEntry)).rejects.toThrow(/must be/);
    expect(f.requests).toHaveLength(0);
  });

  it("uses native discovery, wire metadata and nested dynamic parameter headers without legacy traffic", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/list") return;
      result(e, { resultType: "complete", tools: [{ ...tool, inputSchema: {
        type: "object", properties: { nested: { type: "object", properties: {
          region: { type: "string", "x-mcp-header": "Region" },
        } } },
      } }] });
      return true;
    });
    const { connection } = await f.connect();
    await connection.client.callTool({ name: "echo", arguments: { nested: { region: "Hello, 世界" } } });
    expect(connection.client.getProtocolEra()).toBe("modern");
    expect(connection.instructions).toBe("Local fixture instructions");
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
    for (const { req, body } of f.requests) {
      expect(req.method).toBe("POST");
      expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(req.headers["mcp-method"]).toBe(body.method);
      expect(req.headers["mcp-session-id"]).toBeUndefined();
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    }
    expect(f.calls()[0].req.headers["mcp-name"]).toBe("echo");
    expect(f.calls()[0].req.headers["mcp-param-region"]).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
  });

  it("leaves HEADER_MISMATCH refresh and fresh request IDs to the SDK", async () => {
    let lists = 0;
    const f = await fixture(e => {
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [{ ...tool, inputSchema: {
          type: "object", properties: { region: { type: "string", "x-mcp-header": ++lists === 1 ? "Old" : "Region" } },
        } }] });
        return true;
      }
      if (e.body.method === "tools/call" && !e.req.headers["mcp-param-region"]) {
        rpcError(e, -32020, 400);
        return true;
      }
    });
    const { connection } = await f.connect({ retryOnTransportFailure: true });
    await connection.client.callTool({ name: "echo", arguments: { region: "west" } });
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
    expect(f.calls()[1].req.headers["mcp-param-region"]).toBe("west");
  });

  it.each([-32601, -32700, -32000, -32020, -32021])("keeps native matched error %s fallback", async code => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      rpcError(e, code);
      return true;
    });
    const { connection } = await f.connect();
    expect(connection.client.getProtocolEra()).toBe("legacy");
    const initializations = f.requests.filter(r => r.body.method === "initialize");
    expect(initializations).toHaveLength(1);
    expect(initializations[0].req.headers["mcp-method"]).toBeUndefined();
    expect(initializations[0].body.params._meta).toBeUndefined();
  });

  it.each(["malformed", "http400"])("keeps native %s discovery fallback", async mode => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      if (mode === "malformed") result(e, {});
      else e.res.writeHead(400).end("legacy endpoint");
      return true;
    });
    expect((await f.connect()).connection.client.getProtocolEra()).toBe("legacy");
  });

  it("reports the native HTTP200 null-ID limitation honestly; explicit legacy works", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      rpcError(e, -32700, 200, null);
      return true;
    });
    await expect(f.connect()).rejects.toMatchObject({ code: SdkErrorCode.EraNegotiationFailed });
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover"]);
    expect((await f.connect({ protocolVersion: "legacy" })).connection.status).toBe("connected");
    expect(f.requests.filter(r => r.body.method === "initialize")).toHaveLength(1);
  });

  it.each([401, 403, 500, "network"])("never chooses SSE or legacy for discovery %s", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      if (failure === "network") e.req.socket.destroy();
      else e.res.writeHead(failure).end("unavailable");
      return true;
    });
    const code = failure === 401 ? SdkErrorCode.ClientHttpAuthentication
      : failure === 403 ? SdkErrorCode.ClientHttpForbidden
      : SdkErrorCode.EraNegotiationFailed;
    await expect(f.connect()).rejects.toMatchObject({ code });
    expect(f.manager.getConnection("local")).toBeUndefined();
    expect(f.requests.map(r => r.body.method)).toEqual(["server/discover"]);
  });

  it("never chooses SSE or legacy for discovery timeout", async () => {
    let received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      received();
      return true;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = expect(f.connect({ requestTimeoutMs: 35 })).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout });
      await arrived;
      await vi.advanceTimersByTimeAsync(35);
      await outcome;
      expect(f.manager.getConnection("local")).toBeUndefined();
      expect(f.requests.map(r => r.body.method)).toEqual(["server/discover"]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["direct", "proxy", "script"])("uses one same-client fresh transport retry through %s", async entry => {
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.req.socket.destroy();
        return true;
      }
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, entry);
    expect(output.ok).toBe(true);
    expect(f.manager.getConnection("local")?.client).toBe(connection.client);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
    expect(f.requests.filter(r => r.body.method === "server/discover")).toHaveLength(1);
    expect(connection.inFlight).toBe(0);
  });

  it.each(["direct", "proxy", "script"])("retries partial SSE body loss once through %s", async entry => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call" || f.calls().length > 1) return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": started\n\n");
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const started = performance.now();
    const output = await call(state, entry);
    expect(output.ok, JSON.stringify({ output, calls: f.calls().map(c => c.body.id), elapsedMs: performance.now() - started })).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
    expect(f.manager.getConnection("local")?.client).toBe(connection.client);
    expect(f.requests.filter(r => r.body.method === "server/discover")).toHaveLength(1);
    expect(connection.inFlight).toBe(0);
  });

  it.each(["direct", "proxy", "script"])("reconciles a committed mutation after lost response through %s without replay", async entry => {
    const receipts = new Map<string, unknown>();
    let mutations = 0;
    const f = await fixture(e => {
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [
          { name: "echo", inputSchema: tool.inputSchema, annotations: { readOnlyHint: false, idempotentHint: false } },
          { ...tool, name: "readback" },
        ] });
        return true;
      }
      if (e.body.method !== "tools/call") return;
      if (e.body.params.name === "readback") {
        result(e, { resultType: "complete", content: [], structuredContent: receipts.get(e.body.params.arguments.value) });
      } else {
        mutations++;
        receipts.set(e.body.params.arguments.value, { id: "original-resource", version: mutations });
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": committed\n\n");
        setTimeout(() => e.res.destroy(), 20);
      }
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const captured: any[] = [];
    state.onToolCall = async event => { captured.push(event); };
    const output = await call(state, entry);
    expect(mutations).toBe(1);
    expect(entry === "script" ? output.error.code : output.details.error).toBe("ambiguous_outcome");
    expect(captured.map(e => e.phase)).toEqual(["before", "after"]);
    expect(captured[0].args).toEqual({ value: "test" });
    expect(captured[1].error).toBeInstanceOf(Error);
    if (entry === "script") expect(captured[0].innerCallId).toBe(1);
    const readback = await executeCall(state, "local_readback", { value: "test" });
    expect(readback.details.mcpResult).toMatchObject({ structuredContent: { id: "original-resource", version: 1 } });
    expect(mutations).toBe(1);
  });

  it.each([undefined, {}, { readOnlyHint: false }, { idempotentHint: true }, { readOnlyHint: true }])(
    "uses only explicit replay-safe annotations for transport retry: %j", async annotations => {
      const f = await fixture(e => {
        if (e.body.method === "tools/list") {
          result(e, { resultType: "complete", tools: [{ name: "echo", inputSchema: tool.inputSchema, annotations }] });
          return true;
        }
        if (e.body.method === "tools/call" && f.calls().length === 1) { e.req.socket.destroy(); return true; }
      });
      const { state } = await f.connect({ retryOnTransportFailure: true });
      // A frozen direct tool can still have old read-only hints; live hints win.
      const output = await createDirectToolExecutor(() => state, () => null, {
        serverName: "local", originalName: "echo", prefixedName: "local_echo", description: "Echo",
        annotations: { readOnlyHint: true },
      })("outer-id", { secret: "not-in-error-text" }, undefined, undefined, {} as any);
      const safe = annotations?.readOnlyHint === true || annotations?.idempotentHint === true;
      expect(f.calls()).toHaveLength(safe ? 2 : 1);
      expect(output.details.error).toBe(safe ? undefined : "ambiguous_outcome");
      if (!safe) {
        expect(output.details.recovery).toMatchObject({ server: "local", tool: "echo", toolCallId: "outer-id", action: "readback" });
        expect(JSON.stringify(output)).not.toContain("not-in-error-text");
      }
    },
  );

  it("preserves native annotations through cached metadata, direct tools and both describe paths", async () => {
    const f = await fixture();
    const { state, connection } = await f.connect({ directTools: true });
    const definition = state.config.mcpServers.local;
    const entry = { configHash: computeServerHash(definition), tools: serializeTools(connection.tools), resources: [], cachedAt: Date.now() };
    const metadata = reconstructToolMetadata("local", entry, "server", definition);
    expect(metadata).toEqual(state.toolMetadata.get("local"));
    const specs = resolveDirectTools(state.config, { version: 1, servers: { local: entry } }, "server");
    expect(specs[0].annotations).toEqual({ readOnlyHint: true });
    expect(executeDescribe(state, "local_echo").content[0]).toMatchObject({ text: expect.stringContaining('"readOnlyHint":true') });
    const script = await runMcpScript(state, 'return tools.describe({ path: "local_echo" });');
    expect(JSON.parse(script.content[0].text).annotations).toEqual({ readOnlyHint: true });
    expect(f.calls()).toHaveLength(0);
  });

  it("awaits native Pi factory checkpoints and capture across Jiti without replaying completed effects", async () => {
    const piPath = process.env.PI_PACKAGE_DIR;
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piPath
      ? await import(/* @vite-ignore */ pathToFileURL(join(piPath, "dist/index.js")).href)
      : await import("@earendil-works/pi-coding-agent");
    const root = await mkdtemp(join(process.env.PI_MCP_NATIVE_TEST_ROOT ?? tmpdir(), "mcp-native-capture-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const previousEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS };
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_DIRECT_TOOLS;
    cleanups.unshift(async () => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Preserve native fixture histories for inspection; never delete Pi sessions.
    });
    const captures: Array<{ event: any; bytes: string; res: ServerResponse }> = [];
    const checkpoints: Array<{ toolCallId: string; operation?: McpOperationContext; bytes: string; workspace: string | null; artifacts: string[]; res: ServerResponse }> = [];
    const outputDirectory = join(root, "output");
    const largeOutput = "saved detail: π\n".repeat(10_000);
    let checkpointMode = "hold";
    let writer: ServerResponse | undefined;
    let mode = "hold";
    let effects = 0;
    const receipts = new Map<string, unknown>();
    let readbackAnnotations: { readOnlyHint: boolean } | undefined = { readOnlyHint: true };
    const resourceUri = "fixture://saved-data";
    const f = await fixture(e => {
      if (e.req.url === "/writer") { writer = e.res; return true; }
      if (e.req.url === "/checkpoint") {
        checkpoints.push({ ...e.body as any, res: e.res });
        if (checkpointMode === "hold") return true;
        e.res.writeHead(checkpointMode === "reject" ? 503 : 200).end();
        return true;
      }
      if (e.req.url === "/capture") {
        const { event, bytes } = e.body as any;
        captures.push({ event, bytes, res: e.res });
        if (mode === "hold" && event.innerCallId === 1) return true;
        e.res.writeHead(mode === `reject-${event.phase}` ? 503 : 200).end();
        return true;
      }
      if (e.body.method === "server/discover") {
        result(e, { ...modern, capabilities: { tools: {}, resources: {} } });
        return true;
      }
      if (e.body.method === "resources/list") {
        result(e, { resultType: "complete", resources: [{ name: "saved_data", uri: resourceUri }] });
        return true;
      }
      if (e.body.method === "resources/read") {
        result(e, { resultType: "complete", ttlMs: 0, cacheScope: "private", contents: [{ uri: resourceUri, text: "saved resource" }] });
        return true;
      }
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [
          { name: "echo", inputSchema: tool.inputSchema },
          { ...tool, name: "readback", annotations: readbackAnnotations },
          { name: "upsert", inputSchema: tool.inputSchema, annotations: { readOnlyHint: false, idempotentHint: true } },
        ] });
        return true;
      }
      if (e.body.method === "tools/call") {
        const value = e.body.params.arguments.value;
        if (e.body.params.name !== "readback") receipts.set(value, { id: `resource-${++effects}`, value });
        if (value === "lose-response" && e.body.params.name === "echo") {
          e.res.writeHead(200, { "content-type": "text/event-stream" });
          e.res.write(": committed\n\n");
          setTimeout(() => e.res.destroy(), 20);
        } else result(e, { resultType: "complete", content: value === "first" ? [{ type: "text", text: largeOutput }] : [], structuredContent: receipts.get(value) });
        return true;
      }
    });
    const wrapper = join(root, "capture-extension.ts");
    await writeFile(wrapper, `
      import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { Type } from "typebox";
      import { createMcpAdapter } from ${JSON.stringify(resolve("dist/index.js"))};
      export default function (pi) {
        let sessionManager;
        pi.on("session_start", (_event, ctx) => { sessionManager = ctx.sessionManager; });
        const outputDirectory = ${JSON.stringify(outputDirectory)};
        const workspaceFile = ${JSON.stringify(join(root, "work.txt"))};
        pi.registerTool({
          name: "fixture_writer", label: "Writer", description: "Finish a workspace write", parameters: Type.Object({}),
          async execute(_id, _args, signal) {
            await fetch(${JSON.stringify(new URL("/writer", f.url).href)}, { method: "POST", signal });
            writeFileSync(workspaceFile, "writer finished");
            return { content: [{ type: "text", text: "writer finished" }], details: {} };
          },
        });
        createMcpAdapter({
          outputDirectory,
          beforeExecute: async (toolCallId, ctx, operation) => {
            const artifacts = existsSync(outputDirectory)
              ? readdirSync(outputDirectory, { recursive: true }).filter(name => name.endsWith(".txt"))
                .map(name => readFileSync(join(outputDirectory, name), "utf8")) : [];
            const response = await fetch(${JSON.stringify(new URL("/checkpoint", f.url).href)}, {
              method: "POST", signal: ctx.signal,
              body: JSON.stringify({ toolCallId, operation, bytes: readFileSync(ctx.sessionManager.getSessionFile(), "utf8"),
                workspace: existsSync(workspaceFile) ? readFileSync(workspaceFile, "utf8") : null, artifacts }),
            });
            if (!response.ok) throw new Error("checkpoint unavailable");
          },
          config: { mcpServers: {
            local: { url: ${JSON.stringify(f.url)}, auth: false, lifecycle: "eager", directTools: true, retryOnTransportFailure: true, requestTimeoutMs: 1000 },
            untrusted: { url: ${JSON.stringify(f.url)}, auth: false, lifecycle: "eager", directTools: true, requestTimeoutMs: 1000 },
          }, settings: { sampling: false, elicitation: false, freezeDirectTools: true } },
          onToolCall: async ({ signal, ...event }) => {
            pi.appendEntry("fixture-mcp-call", event);
            const bytes = readFileSync(sessionManager.getSessionFile(), "utf8");
            const response = await fetch(${JSON.stringify(new URL("/capture", f.url).href)}, {
              method: "POST", body: JSON.stringify({ event, bytes }), signal,
            });
            if (!response.ok) throw new Error("capture unavailable: synthetic-secret-must-not-leak");
          },
        })(pi);
      }
    `);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }), additionalExtensionPaths: [wrapper],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    const model = { id: "fixture", name: "fixture", api: "test", provider: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
    const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, sessionManager, settingsManager, modelRuntime, model });
    cleanups.push(async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    });
    await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(error.error); } });
    const script = `const first = await tools.local_echo({ value: ["first"].join("") }); await tools.local_echo({ value: first.data.structuredContent.id }); emit(first.data.content[0].text);`;
    let nativeCalls: ToolCall[] = [
      { type: "toolCall", id: "native-writer", name: "fixture_writer", arguments: {} },
      { type: "toolCall", id: "native-outer", name: "mcp_script", arguments: { code: script } },
    ];
    let modelCalls = 0;
    session.agent.streamFunction = async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
      const aborted = options.signal?.aborted;
      const message = { role: "assistant", api: "test", provider: "fixture", model: "fixture", timestamp: Date.now(),
        content: aborted ? [] : ++modelCalls === 1 ? nativeCalls : [{ type: "text", text: "done" }],
        stopReason: aborted ? "aborted" : modelCalls === 1 ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return { async *[Symbol.asyncIterator]() { yield aborted
        ? { type: "error", reason: "aborted", error: message }
        : { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    const pending = session.agent.prompt("fixture: finish the workspace write and both effects");
    await expect.poll(() => writer !== undefined).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(effects).toBe(0);
    writer!.writeHead(200).end();
    await expect.poll(() => checkpoints.length).toBe(1);
    expect(checkpoints[0]).toMatchObject({ toolCallId: "native-outer", workspace: "writer finished", artifacts: [], operation: {
      toolCallId: "native-outer", innerCallId: 1, server: "local", tool: "echo", args: { value: "first" }, annotationsTrusted: true,
    } });
    expect(checkpoints[0].operation.annotations).toBeUndefined();
    // A real wait longer than the 1s service deadline must not consume that deadline.
    await delay(1200);
    expect(checkpoints[0].bytes).toContain('"role":"toolResult","toolCallId":"native-writer"');
    expect(captures).toHaveLength(0);
    expect(effects).toBe(0);
    checkpoints[0].res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(1);
    expect(effects).toBe(0);
    expect(captures[0].event).toMatchObject({ phase: "before", toolCallId: "native-outer", innerCallId: 1, args: { value: "first" } });
    expect(captures[0].bytes).toContain('"name":"mcp_script"');
    captures[0].res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(2);
    expect(effects).toBe(1);
    const checkpoint = captures[1].bytes;
    expect(captures[1].event.result.structuredContent).toEqual({ id: "resource-1", value: "first" });
    captures[1].res.writeHead(200).end();
    await expect.poll(() => checkpoints.length).toBe(2);
    expect(checkpoints[1]).toMatchObject({ toolCallId: "native-outer", operation: {
      toolCallId: "native-outer", innerCallId: 2, args: { value: "resource-1" },
    } });
    expect(checkpoints[1].artifacts).toContain(largeOutput);
    expect(checkpoints[1].artifacts.map(bytes => bytes.startsWith("{") ? JSON.parse(bytes) : null))
      .toContainEqual(expect.objectContaining({ content: [{ type: "text", text: largeOutput }], structuredContent: { id: "resource-1", value: "first" } }));
    expect(captures).toHaveLength(2);
    expect(effects).toBe(1);
    checkpointMode = "pass";
    checkpoints[1].res.writeHead(200).end();
    await pending;
    await session.waitForIdle();
    expect(effects).toBe(2);
    expect(captures[2].event).toMatchObject({ toolCallId: "native-outer", innerCallId: 2, args: { value: "resource-1" } });
    const scriptResult = sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "native-outer");
    const finalPath = scriptResult.message.details.outputGuard.fullOutputPath;
    expect(dirname(dirname(finalPath))).toBe(outputDirectory);
    expect(await readFile(finalPath, "utf8")).toBe(largeOutput);
    const restoredPath = join(root, "restored.jsonl");
    await writeFile(restoredPath, checkpoint);
    const restored = SessionManager.open(restoredPath);
    const entries = restored.getEntries().filter((e: any) => e.type === "custom");
    expect(entries.map((e: any) => e.data.phase)).toEqual(["before", "after"]);
    expect(entries[1].data.result.structuredContent.id).toBe("resource-1");
    expect(effects).toBe(2); // Opening native history does not replay its script.

    const registered = session.extensionRunner.getAllRegisteredTools();
    for (const name of ["local_echo", "mcp", "mcp_script"]) {
      expect(registered.find((t: any) => t.definition.name === name).definition.executionMode).toBe("sequential");
    }
    const execute = (name: string, id: string, params: unknown, signal?: AbortSignal) => registered.find((t: any) => t.definition.name === name)!.definition.execute(
      id, params, signal, undefined, { ...session.extensionRunner.createContext(), signal },
    );
    mode = "reject-before";
    const blocked = await execute("local_echo", "blocked-outer", { value: "never" });
    expect(blocked.details).toMatchObject({ error: "call_capture_failed", recovery: { phase: "before", toolCallId: "blocked-outer" } });
    expect(effects).toBe(2);
    expect(JSON.stringify(blocked)).not.toContain("synthetic-secret-must-not-leak");
    mode = "reject-after";
    const interrupted = await execute("mcp_script", "interrupted-outer", { code: script });
    expect(interrupted.details).toMatchObject({ error: "call_capture_failed", recovery: {
      phase: "after", toolCallId: "interrupted-outer", innerCallId: 1, args: { value: "first" }, result: { structuredContent: { id: "resource-3" } },
    } });
    expect(effects).toBe(3); // Never hands an uncheckpointed result to dependent script work.
    expect(JSON.stringify(interrupted)).not.toContain("synthetic-secret-must-not-leak");
    mode = "hold";
    const controller = new AbortController();
    const captureCount = captures.length;
    const stopped = execute("mcp_script", "stopped-outer", { code: script }, controller.signal);
    await expect.poll(() => captures.length).toBe(captureCount + 1);
    controller.abort(new Error("Stop"));
    expect((await stopped).details.error).toBe("aborted");
    expect(effects).toBe(3);
    mode = "pass";
    const proxy = await execute("mcp", "proxy-outer", { tool: "local_echo", args: { value: "proxy" } });
    expect(proxy.details.error).toBeUndefined();
    expect(captures.at(-1).event).toMatchObject({ phase: "after", toolCallId: "proxy-outer", args: { value: "proxy" } });
    expect(captures.at(-1).event.innerCallId).toBeUndefined();
    expect(effects).toBe(4);
    const lost = await execute("mcp_script", "lost-outer", { code: 'await tools.local_echo({ value: ["lose", "response"].join("-") });' });
    expect(lost.details.calls[0]).toMatchObject({ error: "ambiguous_outcome", recovery: { toolCallId: "lost-outer", innerCallId: 1, action: "readback" } });
    expect(lost.content[0].text).toContain("Read back the original operation");
    expect(effects).toBe(5);
    const lostPath = join(root, "lost-response.jsonl");
    await writeFile(lostPath, captures.at(-1).bytes);
    const lostHistory = SessionManager.open(lostPath).getEntries().filter((e: any) => e.type === "custom");
    const intent = lostHistory.at(-2).data;
    expect(intent).toMatchObject({ phase: "before", toolCallId: "lost-outer", innerCallId: 1, args: { value: "lose-response" } });
    const readback = await execute("mcp", "readback-outer", { tool: "local_readback", args: intent.args });
    expect(readback.details.mcpResult.structuredContent).toEqual({ id: "resource-5", value: "lose-response" });
    expect(captures.at(-1).event.result.structuredContent.id).toBe("resource-5");
    expect(effects).toBe(5);
    expect(checkpoints.map(c => c.toolCallId)).toEqual([
      "native-outer", "native-outer", "blocked-outer", "interrupted-outer", "stopped-outer", "proxy-outer", "lost-outer", "readback-outer",
    ]);
    checkpointMode = "reject";
    await expect(execute("local_echo", "checkpoint-rejected", { value: "never" })).rejects.toThrow("checkpoint unavailable");
    expect(effects).toBe(5);

    for (const name of ["local_echo", "mcp", "mcp_script"]) {
      checkpointMode = "hold";
      const beforeCount = checkpoints.length;
      const captureCount = captures.length;
      const id = `native-stop-${name}`;
      nativeCalls = [{ type: "toolCall", id, name, arguments: name === "mcp_script" ? { code: script }
        : name === "mcp" ? { tool: "local_echo", args: { value: "never" } } : { value: "never" } }];
      modelCalls = 0;
      const stopping = session.agent.prompt(`fixture: stop ${name} during its checkpoint`);
      await expect.poll(() => checkpoints.length).toBe(beforeCount + 1);
      expect(checkpoints.at(-1).toolCallId).toBe(id);
      await session.abort();
      await stopping;
      await session.waitForIdle();
      checkpoints.at(-1).res.end();
      expect(modelCalls).toBe(1);
      expect(captures).toHaveLength(captureCount);
      expect(effects).toBe(5);
    }

    checkpointMode = "pass";
    mode = "pass";
    for (const entry of ["direct", "proxy", "script"]) {
      for (const name of ["readback", "upsert", "read_saved_data"]) {
        const id = `${entry}-${name}`;
        const beforeCount = checkpoints.length;
        const captureCount = captures.length;
        const args = { value: id };
        const output = await execute(entry === "direct" ? `local_${name}` : entry === "proxy" ? "mcp" : "mcp_script", id,
          entry === "direct" ? args : entry === "proxy" ? { tool: `local_${name}`, args }
            : { code: `return await tools.local_${name}(${JSON.stringify(args)});` });
        expect(output.details.error, JSON.stringify({ id, details: output.details })).toBeUndefined();
        expect(checkpoints).toHaveLength(beforeCount + 1);
        const operation = checkpoints.at(-1)!.operation;
        expect(operation).toEqual({
          toolCallId: id, ...(entry === "script" ? { innerCallId: 1 } : {}),
          server: "local", tool: name, args, annotationsTrusted: true,
          ...(name === "readback" ? { annotations: { readOnlyHint: true } }
            : name === "upsert" ? { annotations: { readOnlyHint: false, idempotentHint: true } } : { resourceUri }),
        });
        const { annotationsTrusted: _trust, ...nativeFields } = operation;
        expect(captures.slice(captureCount).map(c => c.event.phase)).toEqual(["before", "after"]);
        expect(captures[captureCount].event).toEqual({ ...nativeFields, phase: "before" });
        expect(captures.at(-1)!.event).toMatchObject({ ...nativeFields, phase: "after" });
        expect(captures.at(-1)!.event).not.toHaveProperty("annotationsTrusted");
      }
    }
    await execute("untrusted_readback", "untrusted-read", { value: "untrusted" });
    expect(checkpoints.at(-1)!.operation).toEqual({
      toolCallId: "untrusted-read", server: "untrusted", tool: "readback", args: { value: "untrusted" },
      annotationsTrusted: false, annotations: { readOnlyHint: true },
    });

    // Keep invoking the old direct definition while the native live connection refreshes.
    for (const annotations of [undefined, { readOnlyHint: false }]) {
      readbackAnnotations = annotations;
      await execute("mcp", "refresh", { connect: "local" });
      expect(checkpoints.at(-1)!.operation).toBeUndefined();
      await execute("local_readback", "stale-direct", { value: "stale" });
      expect(checkpoints.at(-1)!.operation.annotations).toEqual(annotations);
      expect(captures.at(-1)!.event.annotations).toEqual(annotations);
    }
    for (const params of [{}, { search: "echo" }, { action: "auth-start" }]) {
      const count = captures.length;
      await execute("mcp", "unresolved-mode", params);
      expect(checkpoints.at(-1)!.operation).toBeUndefined();
      expect(captures).toHaveLength(count);
    }

    // Inner calls stay parallel, with independent IDs and args even under one outer ID.
    checkpointMode = "hold";
    const checkpointCount = checkpoints.length;
    const parallelCaptureCount = captures.length;
    const parallel = execute("mcp_script", "parallel-outer", { code: `return Promise.all([
      tools.local_echo({ value: "parallel-first" }), tools.local_upsert({ value: "parallel-second" })
    ]);` });
    await expect.poll(() => checkpoints.length).toBe(checkpointCount + 2);
    const pair = checkpoints.slice(checkpointCount);
    expect(pair.map(c => [c.operation.toolCallId, c.operation.innerCallId, c.operation.args.value])).toEqual([
      ["parallel-outer", 1, "parallel-first"], ["parallel-outer", 2, "parallel-second"],
    ]);
    pair[1].res.writeHead(200).end();
    await expect.poll(() => captures.length).toBe(parallelCaptureCount + 2);
    expect(captures.slice(parallelCaptureCount).map(c => c.event.innerCallId)).toEqual([2, 2]);
    pair[0].res.writeHead(200).end();
    expect((await parallel).details.calls).toMatchObject([{ ok: true }, { ok: true }]);
    expect(captures.slice(parallelCaptureCount).map(c => c.event.innerCallId)).toEqual([2, 2, 1, 1]);
  }, 20000);

  it.each([undefined, false])("does not retry unless opted in (%s)", async retryOnTransportFailure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.req.socket.destroy(); return true;
    });
    const { state } = await f.connect({ ...(retryOnTransportFailure !== undefined ? { retryOnTransportFailure } : {}) });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it.each([undefined, false])("settles partial SSE loss without retry when disabled (%s)", async retryOnTransportFailure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": started\n\n");
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state } = await f.connect({ ...(retryOnTransportFailure !== undefined ? { retryOnTransportFailure } : {}) });
    const output = await call(state, "proxy");
    expect(output.ok).toBe(false);
    expect(output.details.message).not.toMatch(/timeout|timed out/i);
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["network", "http503", "sse"])("stops after the second %s failure", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      if (failure === "sse") {
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": started\n\n");
        setTimeout(() => e.res.destroy(), 20);
      } else if (failure === "network") e.req.socket.destroy();
      else e.res.writeHead(503).end("service unavailable");
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, "proxy");
    expect(output.ok).toBe(false);
    expect(output.details.message).not.toMatch(/timeout|timed out/i);
    expect(f.calls()).toHaveLength(2);
  });

  it.each(["plain", "json"])("retries a tool HTTP503 %s response once", async body => {
    const f = await fixture(e => {
      if (e.body.method === "tools/call" && f.calls().length === 1) {
        e.res.writeHead(503).end(body === "plain" ? "service unavailable" : JSON.stringify({ error: "unavailable" })); return true;
      }
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(new Set(f.calls().map(c => c.body.id)).size).toBe(2);
  });

  it.each(["protocol", "http401", "http403", "http503-rpc", "http503-null-id", "tool", "invalid-json", "sse-protocol", "sse-tool"])("does not retry %s errors", async failure => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      if (failure.startsWith("sse-")) {
        e.res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0", id: e.body.id,
          ...(failure === "sse-tool" ? { result: { resultType: "complete", isError: true, content: [] } }
            : { error: { code: -32602, message: "fixture rejection" } }),
        })}\n\n`);
      } else if (failure === "http401" || failure === "http403") e.res.writeHead(Number(failure.slice(4))).end("denied");
      else if (failure === "tool") result(e, { resultType: "complete", isError: true, content: [] });
      else if (failure === "invalid-json") e.res.writeHead(200, { "content-type": "application/json" }).end("not json");
      else rpcError(e, -32602, failure === "protocol" ? 200 : 503, failure === "http503-null-id" ? null : e.body.id);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it("preserves streaming cancellation and trace identity without a cancellation POST", async () => {
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": waiting\n\n");
      e.res.on("close", () => { closed = true; });
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
    expect((await pending).details.error).toBe("aborted");
    await expect.poll(() => closed).toBe(true);
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.some(r => r.body.method === "notifications/cancelled" || r.req.method === "GET")).toBe(false);
    await f.manager.closeAll();
    const trace = await readFile(join(directory, "trace.jsonl"), "utf8");
    expect(trace).toContain('"method":"tools/call"');
    expect(trace).not.toContain('"value":"test"');
  });

  it("settles and traces a pending SSE send on intentional manager shutdown without retry", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
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
        ? pending.finally(() => { settled++; }) : pending;
    };
    const pending = call(state, "proxy");
    await expect.poll(() => f.calls().length).toBe(1);
    await f.manager.closeAll();
    expect((await pending).details.message).toContain("Connection closed");
    await expect.poll(() => settled).toBe(1);
    expect(f.calls()).toHaveLength(1);
    await expect.poll(() => readFile(traceFile, "utf8")).toContain('"method":"tools/call"');
    const events = (await readFile(traceFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(e => e.direction === "outbound" && e.method === "tools/call"))
      .toMatchObject([{ id: f.calls()[0].body.id, status: "sent" }]);
  });

  it.each(["network", "sse"])("keeps an absolute deadline across %s retry without reporting caller cancellation", async failure => {
    const f = await fixture(async e => {
      if (e.body.method !== "tools/call") return;
      if (f.calls().length === 1) {
        if (failure === "sse") {
          e.res.writeHead(200, { "content-type": "text/event-stream" });
          e.res.write(": started\n\n");
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        e.req.socket.destroy();
      }
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 160, retryOnTransportFailure: true });
    const started = performance.now();
    const output = await call(state, "proxy");
    expect(output.details.error).toBe("call_failed");
    expect(output.details.message).toMatch(/timeout|timed out/i);
    expect(performance.now() - started).toBeLessThan(240);
    expect(f.calls()).toHaveLength(2);
  });

  it.each(["open", "closed"])("does not infer transport failure from a clean %s SSE stream", async ending => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": waiting\n\n");
      if (ending === "closed") setTimeout(() => e.res.end(), 10);
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 40, retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
  });

  it("does not stack modern retries after legacy session recovery", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(f.calls().length === 1 ? 404 : 503).end("session unavailable");
      return true;
    });
    const { state } = await f.connect({ protocolVersion: "legacy", retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(2);
    expect(f.requests.filter(r => r.body.method === "initialize")).toHaveLength(2);
  });

  it("delivers a chunked modern POST SSE result and adapter stream notifications", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: { streamToken: "stream", result: { content: [{ type: "text", text: "partial" }] } },
      })}\n\n`);
      const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id,
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
    expect(patches).toEqual([{ streamToken: "stream", result: { content: [{ type: "text", text: "partial" }] } }]);
    expect(f.requests.every(r => r.req.method === "POST")).toBe(true);
  });

  it.each([["json", "end"], ["json", "destroy"], ["envelope", "end"], ["envelope", "destroy"]])(
    "does not retry malformed SSE %s followed by %s", async (invalid, ending) => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(`event: message\ndata: ${invalid === "json" ? "not json" : '{"unexpected":true}'}\n\n`);
      setTimeout(() => ending === "end" ? e.res.end() : e.res.destroy(), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const output = await call(state, "proxy");
    expect(output.ok).toBe(false);
    expect(output.details.message).not.toMatch(/timeout|timed out|terminated/i);
    expect(f.calls()).toHaveLength(1);
  });

  it("returns a complete result before EOF and keeps late stream notifications without replay", async () => {
    let stream: ServerResponse;
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      stream = e.res;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id,
        result: { resultType: "complete", content: [{ type: "text", text: "complete" }] },
      })}\n\n`);
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const patches: unknown[] = [];
    const errors: Error[] = [];
    connection.client.onerror = error => errors.push(error);
    f.manager.registerUiStreamListener("late", (_name, patch) => patches.push(patch));
    expect((await call(state, "proxy")).content).toEqual([{ type: "text", text: "complete" }]);
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: SERVER_STREAM_RESULT_PATCH_METHOD,
      params: { streamToken: "late", result: { content: [{ type: "text", text: "after result" }] } },
    })}\n\n`);
    await expect.poll(() => patches.length).toBe(1);
    stream!.destroy();
    await expect.poll(() => errors.length).toBe(1);
    expect(f.calls()).toHaveLength(1);
    expect(connection.inFlight).toBe(0);
  });

  it("does not interrupt or replay an accepted sibling while recovering partial SSE loss", async () => {
    let accepted: Exchange | undefined;
    let attempts = 0;
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      if (e.body.params.arguments.sibling) {
        accepted = e;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": accepted\n\n");
        return true;
      }
      if (++attempts > 1) return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(": started\n\n");
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true });
    const sibling = executeCall(state, "local_echo", { sibling: true });
    await expect.poll(() => accepted !== undefined).toBe(true);
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(accepted!.res.destroyed).toBe(false);
    accepted!.res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: accepted!.body.id,
      result: { resultType: "complete", content: [{ type: "text", text: "sibling result" }] },
    })}\n\n`);
    expect((await sibling).content).toEqual([{ type: "text", text: "sibling result" }]);
    expect(f.calls().filter(c => c.body.params.arguments.sibling)).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(f.manager.getConnection("local")?.client).toBe(connection.client);
    expect(connection.inFlight).toBe(0);
  });

  it("does not attribute a nested catalog's lost response to the tool stream", async () => {
    let lists = 0;
    const f = await fixture(e => {
      if (e.body.method === "tools/list" && ++lists > 1) {
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(": catalog\n\n");
        setTimeout(() => e.res.destroy(), 20);
        return true;
      }
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: { streamToken: "catalog", result: { content: [] } },
      })}\n\n`);
      setTimeout(() => e.res.end(), 60);
      return true;
    });
    const { state, connection } = await f.connect({ retryOnTransportFailure: true, requestTimeoutMs: 150 });
    let catalog: Promise<unknown> | undefined;
    f.manager.registerUiStreamListener("catalog", () => {
      catalog = connection.client.listTools(undefined, { cacheMode: "refresh", timeout: 100 }).catch(error => error);
    });
    expect((await call(state, "proxy")).ok).toBe(false);
    await catalog;
    expect(lists).toBe(2);
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["end", "destroy"])("leaves native SSE resumption in charge after %s", async ending => {
    let id: WireRequest["id"];
    const f = await fixture(e => {
      if (e.req.method === "GET") {
        expect(e.req.headers["last-event-id"]).toBe("resume-token");
        e.res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0", id, result: { resultType: "complete", content: [{ type: "text", text: "resumed" }] },
        })}\n\n`);
        return true;
      }
      if (e.body.method !== "tools/call") return;
      id = e.body.id;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write("id: resume-token\nretry: 1\ndata:\n\n");
      setTimeout(() => ending === "end" ? e.res.end() : e.res.destroy(), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).content).toEqual([{ type: "text", text: "resumed" }]);
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.filter(r => r.req.method === "GET")).toHaveLength(1);
  });

  it.each([401, 403])("does not replace native resumption HTTP%s with a fresh tool POST", async status => {
    const f = await fixture(e => {
      if (e.req.method === "GET") { e.res.writeHead(status).end("denied"); return true; }
      if (e.body.method !== "tools/call") return;
      e.res.writeHead(200, { "content-type": "text/event-stream" });
      e.res.write("id: resume-token\nretry: 1\ndata:\n\n");
      setTimeout(() => e.res.destroy(), 20);
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    expect((await call(state, "proxy")).ok).toBe(false);
    expect(f.calls()).toHaveLength(1);
    expect(f.requests.some(r => r.req.method === "GET")).toBe(true);
  });

  it("refreshes modern catalogs through the native POST subscription and closes it on shutdown", async () => {
    let stream: ServerResponse;
    let subscriptionId: WireRequest["id"];
    let lists = 0;
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method === "server/discover") {
        result(e, { ...modern, capabilities: { tools: { listChanged: true } } });
        return true;
      }
      if (e.body.method === "subscriptions/listen") {
        stream = e.res;
        subscriptionId = e.body.id;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged",
          params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId }, notifications: { toolsListChanged: true } },
        })}\n\n`);
        e.res.on("close", () => { closed = true; });
        return true;
      }
      if (e.body.method === "tools/list") {
        result(e, { resultType: "complete", tools: [{ ...tool, name: ++lists === 1 ? "before" : "after" }] });
        return true;
      }
    });
    const directory = await mkdtemp(join(tmpdir(), "mcp-v2-subscription-"));
    cleanups.unshift(() => rm(directory, { recursive: true, force: true }));
    f.manager.setTraceConfig({ enabled: true, file: join(directory, "trace.jsonl") });
    const { connection } = await f.connect();
    expect(connection.tools[0].name).toBe("before");
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } },
    })}\n\n`);
    await expect.poll(() => connection.tools[0].name).toBe("after");
    expect(f.requests.filter(r => r.body.method === "subscriptions/listen")).toHaveLength(1);
    expect(f.requests.some(r => r.req.method === "GET")).toBe(false);
    await f.manager.closeAll();
    await expect.poll(() => closed).toBe(true);
  });

  it("preserves native multi-round-trip state and fresh IDs", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call" || f.calls().length > 1) return;
      result(e, { resultType: "input_required", requestState: "opaque-state", inputRequests: {} });
      return true;
    });
    const { state } = await f.connect({ retryOnTransportFailure: true });
    const started = performance.now();
    const output = await call(state, "proxy");
    expect(output.ok, JSON.stringify({ output, elapsedMs: performance.now() - started, calls: f.calls().map(({ body }) => body) })).toBe(true);
    expect(f.calls()).toHaveLength(2);
    expect(f.calls()[1].body.params.requestState).toBe("opaque-state");
    expect(f.calls()[0].body.id).not.toBe(f.calls()[1].body.id);
  });

  it.each([404, 405, 406, 415])("connects deprecated SSE only after HTTP%s endpoint rejection", async status => {
    let stream: ServerResponse;
    const f = await fixture(e => {
      if (e.req.url === "/mcp" && e.req.method === "POST") { e.res.writeHead(status).end(); return true; }
      if (e.req.url === "/mcp" && e.req.method === "GET") {
        stream = e.res;
        e.res.writeHead(200, { "content-type": "text/event-stream" });
        e.res.write("event: endpoint\ndata: /messages\n\n");
        return true;
      }
      if (e.req.url !== "/messages") return;
      if (e.body.id !== undefined) {
        const payload = e.body.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1" } }
          : e.body.method === "tools/list" ? { tools: [tool] } : { content: [{ type: "text", text: "ok" }] };
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: e.body.id, result: payload })}\n\n`);
      }
      e.res.writeHead(202).end();
      return true;
    });
    const { state, connection } = await f.connect();
    expect(connection.client.getProtocolEra()).toBe("legacy");
    expect((await call(state, "proxy")).ok).toBe(true);
    expect(f.requests.filter(r => r.req.method === "GET")).toHaveLength(1);
    expect(f.requests.filter(r => r.req.url === "/messages" && r.body.method === "initialize")).toHaveLength(1);
  });

  it("closes an in-flight native discover request when connect is cancelled", async () => {
    let closed = false;
    const f = await fixture(e => {
      if (e.body.method !== "server/discover") return;
      e.res.on("close", () => { closed = true; });
      return true;
    });
    const controller = new AbortController();
    const pending = f.manager.connect("local", { url: f.url, auth: false }, controller.signal);
    const rejection = expect(pending).rejects.toThrow("cancel discovery");
    await expect.poll(() => f.requests.length).toBe(1);
    controller.abort(new Error("cancel discovery"));
    await rejection;
    await expect.poll(() => closed).toBe(true);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["direct", "proxy", "script"])("preserves null structured content through %s", async entry => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/call") return;
      result(e, { resultType: "complete", content: [], structuredContent: null });
      return true;
    });
    const { state } = await f.connect({ requestTimeoutMs: 500.5 });
    const output = await call(state, entry);
    expect(output.ok, JSON.stringify(output)).toBe(true);
    if (entry === "script") expect(output.data.structuredContent).toBeNull();
    else expect(output.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("preserves catalogs longer than the native default 64-page cap", async () => {
    const f = await fixture(e => {
      if (e.body.method !== "tools/list") return;
      const page = Number(e.body.params?.cursor ?? 0);
      result(e, { resultType: "complete", tools: [{ ...tool, name: `tool-${page}` }], ...(page < 65 ? { nextCursor: String(page + 1) } : {}) });
      return true;
    });
    expect((await f.connect()).connection.tools).toHaveLength(66);
  });
});
