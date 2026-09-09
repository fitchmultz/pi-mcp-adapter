import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";
import { computeServerHash } from "../metadata-cache.ts";

let root: string;
let session: AgentSession;
let server: Server;
let release: () => void;
let discoverySignal: AbortSignal;
let pending: Promise<unknown>[];
let calls: string[];
let connect: MockInstance<Client["connect"]>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-mcp-init-abort-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  pending = [];
  calls = [];
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const discovering = new Promise<void>(resolve => { entered = resolve; });
  const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" as const } }];
  server = new Server({ name: "init-abort", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async (_request, ctx) => {
    discoverySignal = ctx.mcpReq.signal;
    entered();
    await held;
    return { tools };
  });
  server.setRequestHandler("tools/call", request => {
    calls.push(request.params.name);
    return { content: [{ type: "text", text: "still connected" }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const nativeConnect = Client.prototype.connect;
  // Replace only the wire transport; initialization, discovery and dispatch remain real.
  connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client, _transport, options) {
    return nativeConnect.call(this, clientTransport, options);
  });
  const definition = { url: "https://unused.invalid/mcp", auth: false as const, lifecycle: "eager" as const, directTools: true };
  await writeFile(join(agentDir, "mcp-cache.json"), JSON.stringify({
    version: 1,
    servers: { demo: { configHash: computeServerHash(definition), tools, resources: [], cachedAt: Date.now() } },
  }));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createMcpAdapter({ config: {
      mcpServers: { demo: definition },
      settings: { sampling: false, elicitation: false },
    } })],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null }),
    noTools: "builtin",
  }));
  await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
  await discovering;
});

afterEach(async () => {
  release?.();
  await Promise.allSettled(pending);
  await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  await server?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function call(name: string, signal?: AbortSignal) {
  const tool = session.agent.state.tools.find(tool => tool.name === name)!;
  expect(tool).toBeDefined();
  const args = name === "mcp" ? { tool: "demo_echo", args: {} }
    : name === "mcp_script" ? { code: "emit(await tools.demo_echo({}));" } : {};
  const result = tool.execute("init-abort", args, signal);
  pending.push(result);
  return result;
}

describe.each(["mcp", "mcp_script", "demo_echo"])("native registered %s initialization", name => {
  it.each(["before", "during"])("honors cancellation %s the wait without cancelling shared startup", async timing => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    if (timing === "before") controller.abort(reason);
    let outcome: unknown;
    const cancelled = call(name, controller.signal).then(value => { outcome = value; }, error => { outcome = error; });
    let siblingSettled = false;
    const sibling = call(name).then(value => { siblingSettled = true; return value; });
    await setImmediate();
    if (timing === "during") {
      expect(outcome).toBeUndefined();
      controller.abort(reason);
    }
    await expect.poll(() => outcome, { timeout: 500, interval: 10 }).toBe(reason);
    await cancelled;
    expect(siblingSettled).toBe(false);
    expect(discoverySignal.aborted).toBe(false);
    expect(calls).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);

    release();
    const result = await sibling;
    expect(result.details?.error).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("still connected");
    expect(calls).toEqual(["echo"]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each(["mcp", "mcp_script"])("keeps the %s 30-second initialization timeout", async name => {
  vi.useFakeTimers();
  let settled = false;
  const waiting = call(name).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await waiting).details).toMatchObject({ error: "init_timeout", timeoutMs: 30_000 });
  expect(discoverySignal.aborted).toBe(false);
  expect(calls).toEqual([]);
});
