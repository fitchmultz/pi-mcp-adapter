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
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../../index.ts";
import { computeServerHash } from "../../metadata-cache.ts";

let root: string;
let session: AgentSession | undefined;
let server: McpServer | undefined;
let release: (() => void) | undefined;
let discoverySignal: AbortSignal;
let pending: Promise<unknown>[] = [];
let calls: string[] = [];
let discoveries: number;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

async function start() {
  root = await mkdtemp(join(tmpdir(), "pi-mcp-init-abort-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "fitch-mcp-adapter"), { recursive: true });
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  delete process.env.MCP_DIRECT_TOOLS;
  pending = [];
  calls = [];
  discoveries = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const discovering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" as const } }];
  server = new McpServer({ name: "init-abort", version: "1" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler("tools/list", async (_request, ctx) => {
    discoveries++;
    discoverySignal = ctx.mcpReq.signal;
    entered();
    await held;
    return { tools };
  });
  server.server.setRequestHandler("tools/call", (request) => {
    calls.push(request.params.name);
    return { content: [{ type: "text", text: "still connected" }] };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // Exercise both native HTTP transports without opening a network listener.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://unused.invalid/mcp") {
        throw new Error(`Unexpected network request: ${request.url}`);
      }
      return transport.handleRequest(request);
    }),
  );
  const definition = {
    url: "https://unused.invalid/mcp",
    auth: false as const,
    lifecycle: "eager" as const,
    directTools: true,
  };
  await writeFile(
    join(agentDir, "fitch-mcp-adapter", "mcp-cache.json"),
    JSON.stringify({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(definition),
          tools,
          resources: [],
          cachedAt: Date.now(),
        },
      },
    }),
  );
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
    extensionFactories: [
      createMcpAdapter({
        config: {
          mcpServers: { demo: definition },
          settings: { sampling: false, elicitation: false },
        },
      }),
    ],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    }),
    noTools: "builtin",
  }));
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      throw new Error(error.error);
    },
  });
  await discovering;
  expect(session.getActiveToolNames()).toContain("mcp");
  expect(session.getActiveToolNames()).not.toContain("mcp_script");
  session.setActiveToolsByName([...session.getActiveToolNames(), "mcp_script"]);
  expect(calls).toEqual([]);
  expect(discoveries).toBe(1);
}

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
  if (originalDirectTools === undefined) {
    delete process.env.MCP_DIRECT_TOOLS;
  } else {
    process.env.MCP_DIRECT_TOOLS = originalDirectTools;
  }
  await rm(root, { recursive: true, force: true });
});

function call(name: string, signal?: AbortSignal) {
  const tool = session?.agent.state.tools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  if (tool === undefined) {
    throw new Error(`${name} was not registered`);
  }
  let args: object = {};
  if (name === "mcp") {
    args = { tool: "demo_echo", args: {} };
  } else if (name === "mcp_script") {
    args = { code: "emit(await tools.demo_echo({}));" };
  }
  const result = tool.execute("init-abort", args, signal);
  pending.push(result);
  return result;
}

describe.each(["mcp", "mcp_script", "demo_echo"])("native registered %s initialization", (name) => {
  it.each(["before", "during"])(
    "honors cancellation %s the wait without cancelling shared startup",
    async (timing) => {
      await start();
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      if (timing === "before") {
        controller.abort(reason);
      }
      let outcome: unknown;
      const cancelled = call(name, controller.signal).then(
        (value) => {
          outcome = value;
          return value;
        },
        (error: unknown) => {
          outcome = error;
          return error;
        },
      );
      let siblingSettled = false;
      const sibling = call(name).then((value) => {
        siblingSettled = true;
        return value;
      });
      await setImmediate();
      expect(outcome).toBe(timing === "before" ? reason : undefined);
      if (timing === "during") {
        controller.abort(reason);
      }
      await expect.poll(() => outcome, { timeout: 500, interval: 10 }).toBe(reason);
      await cancelled;
      expect(siblingSettled).toBe(false);
      expect(discoverySignal.aborted).toBe(false);
      expect(calls).toEqual([]);
      expect(discoveries).toBe(1);

      release?.();
      const result = await sibling;
      expect(result.isError).not.toBe(true);
      expect(result.details).not.toHaveProperty("error");
      expect(JSON.stringify(result.content)).toContain("still connected");
      expect(calls).toEqual(["echo"]);
      expect(discoveries).toBe(1);
    },
  );
});

it.each(["mcp", "mcp_script"])("keeps the %s 30-second initialization timeout", async (name) => {
  await start();
  vi.useFakeTimers();
  let settled = false;
  const waiting = call(name).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await waiting).details).toMatchObject({ error: "init_timeout", timeoutMs: 30_000 });
  expect(discoverySignal.aborted).toBe(false);
  expect(calls).toEqual([]);
});
