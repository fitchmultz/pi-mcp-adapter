import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMcpAdapter, type McpAdapterOptions, type McpToolCallEvent } from "../index.ts";

let root: string;
let server: Server;
let url: string;
let sessions: AgentSession[];
let calls: Array<{ name: string; args: Record<string, unknown> }>;
let closed: unknown[];
const nativeFetch = globalThis.fetch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-script-default-"));
  await mkdir(join(root, "agent"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (target.hostname !== "127.0.0.1") throw new Error(`Unexpected network request: ${target.origin}`);
    return nativeFetch(input, init);
  });
  sessions = [];
  calls = [];
  closed = [];
  server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const request = JSON.parse(data);
    const respond = (result: unknown) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (request.method === "server/discover") {
      respond({
        resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "script-deadline", version: "1" } },
      });
    } else if (request.method === "tools/list") {
      respond({ resultType: "complete", ttlMs: 60_000, cacheScope: "private", tools: ["echo", "hang"].map(name => ({
        name, inputSchema: { type: "object", properties: { id: { type: "string" } } },
      })) });
    } else if (request.method === "tools/call") {
      const { name, arguments: args } = request.params;
      calls.push({ name, args });
      if (name === "hang") { res.once("close", () => closed.push(args.id)); return; }
      respond({ resultType: "complete", content: [{ type: "text", text: args.id }], structuredContent: args });
    } else {
      res.writeHead(202).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  url = `http://127.0.0.1:${address.port}/mcp`;
});

afterEach(async () => {
  for (const session of sessions) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function startAdapter(options: McpAdapterOptions = {}, requestTimeoutMs = 5_000) {
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createMcpAdapter({
      ...options,
      config: {
        mcpServers: { local: { url, auth: false, lifecycle: "eager", requestTimeoutMs } },
        settings: { sampling: false, elicitation: false },
      },
    })],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null }),
    noTools: "builtin",
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
  const proxy = session.agent.state.tools.find(tool => tool.name === "mcp");
  const script = session.agent.state.tools.find(tool => tool.name === "mcp_script");
  if (!proxy || !script) throw new Error("Adapter tools were not registered");
  expect((await proxy.execute("bootstrap", {}, undefined)).details?.error).toBeUndefined();
  return { script, session };
}

it("lets an opted-in factory cross 30 seconds once while an unconfigured factory keeps its deadline", async () => {
  async function run(label: string, options: McpAdapterOptions) {
    const captured: McpToolCallEvent[] = [];
    let checkpoints = 0;
    const { script } = await startAdapter({
      ...options,
      beforeExecute: async (id, ctx) => {
        if (id !== "bootstrap" && ++checkpoints === 2) await delay(31_000, undefined, { signal: ctx.signal });
      },
      onToolCall: async event => { captured.push(event); },
    });
    const started = performance.now();
    const result = await script.execute(label, { code: `
      const first = await tools.local_echo({ id: "${label}-one" });
      emit(first.data.structuredContent.id);
      const second = await tools.local_echo({ id: "${label}-two" });
      emit(second.data.structuredContent.id);
      return "complete";
    ` }, undefined);
    return { result, captured, elapsedMs: performance.now() - started, parameters: script.parameters };
  }
  const [optedIn, ordinary] = await Promise.all([
    run("opted-in", { defaultScriptTimeoutMs: null }),
    run("ordinary", {}),
  ]);
  console.info("real-clock factory deadlines", JSON.stringify({
    optedIn: { elapsedMs: optedIn.elapsedMs, details: optedIn.result.details },
    ordinary: { elapsedMs: ordinary.elapsedMs, details: ordinary.result.details },
    calls,
  }));
  expect(optedIn.result.details).not.toHaveProperty("error");
  expect(optedIn.result.details).toMatchObject({ timeoutMs: null, calls: [{ ok: true }, { ok: true }] });
  expect(optedIn.elapsedMs).toBeGreaterThanOrEqual(31_000);
  expect(optedIn.result.content).toEqual([
    { type: "text", text: "opted-in-one" }, { type: "text", text: "opted-in-two" }, { type: "text", text: "complete" },
  ]);
  expect(optedIn.captured.map(event => [event.phase, event.toolCallId, event.innerCallId, event.args.id])).toEqual([
    ["before", "opted-in", 1, "opted-in-one"], ["after", "opted-in", 1, "opted-in-one"],
    ["before", "opted-in", 2, "opted-in-two"], ["after", "opted-in", 2, "opted-in-two"],
  ]);
  expect(ordinary.result.details).toMatchObject({ error: "timeout", timeoutMs: 30_000 });
  expect(ordinary.elapsedMs).toBeGreaterThanOrEqual(29_500);
  expect(ordinary.elapsedMs).toBeLessThan(40_000);
  expect(calls.map(call => call.args.id).sort()).toEqual(["opted-in-one", "opted-in-two", "ordinary-one"]);
  expect(optedIn.parameters.properties.timeoutMs.description).toContain("no default deadline");
  expect(ordinary.parameters.properties.timeoutMs.description).toContain("default: 30000");
}, 45_000);

it("uses a numeric host default and lets an explicit shorter limit override it", async () => {
  const { script } = await startAdapter({ defaultScriptTimeoutMs: 250 });
  expect(script.parameters.properties.timeoutMs.description).toContain("default: 250");
  const code = "await new Promise(() => {});";
  expect((await script.execute("host-default", { code }, undefined)).details).toMatchObject({ error: "timeout", timeoutMs: 250 });
  expect((await script.execute("explicit", { code, timeoutMs: 50 }, undefined)).details).toMatchObject({ error: "timeout", timeoutMs: 50 });
});

it("honors an explicit deadline when the host disables the default", async () => {
  const { script } = await startAdapter({ defaultScriptTimeoutMs: null });
  const started = performance.now();
  const result = await script.execute("explicit", { code: "await new Promise(() => {});", timeoutMs: 75 }, undefined);
  expect(result.details).toMatchObject({ error: "timeout", timeoutMs: 75 });
  expect(performance.now() - started).toBeLessThan(2_000);
});

it.each(["Stop", "owner shutdown"])("%s terminates a CPU-bound script without a default deadline", async cancellation => {
  const { script, session } = await startAdapter({ defaultScriptTimeoutMs: null });
  const controller = new AbortController();
  const pending = script.execute("cpu", { code: `
    await tools.local_echo({ id: "cpu-ready" }); emit("cpu-entered"); while (true) {}
  ` }, controller.signal);
  try {
    await expect.poll(() => calls).toEqual([{ name: "echo", args: { id: "cpu-ready" } }]);
    await delay(200);
    const started = performance.now();
    if (cancellation === "Stop") controller.abort(new Error("operator stopped"));
    else await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const result = await pending;
    const elapsedMs = performance.now() - started;
    console.info(cancellation, JSON.stringify({ elapsedMs, details: result.details }));
    expect(result.details).toMatchObject({ error: "aborted", timeoutMs: null, calls: [{ ok: true }] });
    expect(result.content[0]).toEqual({ type: "text", text: "cpu-entered" });
    expect(elapsedMs).toBeLessThan(2_000);
    expect(calls).toEqual([{ name: "echo", args: { id: "cpu-ready" } }]);
  } finally {
    controller.abort();
    await pending;
  }
});

it("keeps the independent provider deadline without replaying the original call", async () => {
  const { script } = await startAdapter({ defaultScriptTimeoutMs: null }, 150);
  const started = performance.now();
  const result = await script.execute("provider-deadline", { code: `
    const failed = await tools.local_hang({ id: "original" });
    const next = await tools.local_echo({ id: "following" });
    return { failed, next };
  ` }, undefined);
  const elapsedMs = performance.now() - started;
  console.info("provider deadline", JSON.stringify({ elapsedMs, details: result.details, calls }));
  expect(result.details).not.toHaveProperty("error");
  expect(result.details).toMatchObject({ timeoutMs: null, calls: [{ ok: false, error: "call_failed" }, { ok: true }] });
  expect(elapsedMs).toBeLessThan(2_000);
  expect(calls).toEqual([{ name: "hang", args: { id: "original" } }, { name: "echo", args: { id: "following" } }]);
  await expect.poll(() => closed).toContain("original");
});

it("cancels an already-dispatched unfinished call on early script return", async () => {
  const { script } = await startAdapter({ defaultScriptTimeoutMs: null });
  const result = await script.execute("early", { code: `
    tools.local_hang({ id: "straggler" });
    await tools.local_echo({ id: "joined" });
    return "early";
  ` }, undefined);
  expect(result.details).not.toHaveProperty("error");
  expect(result.details).toMatchObject({ timeoutMs: null, calls: [{ ok: false, error: "incomplete" }, { ok: true }] });
  expect(result.content).toEqual([{ type: "text", text: "early" }]);
  expect(calls).toEqual([{ name: "hang", args: { id: "straggler" } }, { name: "echo", args: { id: "joined" } }]);
  await expect.poll(() => closed).toContain("straggler");
});

it("rejects host defaults that cannot be represented by a native timer", () => {
  for (const value of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648]) {
    expect(() => createMcpAdapter({ defaultScriptTimeoutMs: value })).toThrow(RangeError);
  }
});
