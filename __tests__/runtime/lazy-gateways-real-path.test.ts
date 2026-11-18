import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { JSONObjectSchema } from "@modelcontextprotocol/core";
import { gatewayParameters } from "../../gateway-arguments.ts";
import type { McpConfig } from "../../types.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness(
  options: { tools?: string[]; excludeTools?: string[]; servers?: McpConfig["mcpServers"] } = {},
) {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "mcp-lazy-gateways-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const env = {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS,
  };
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.MCP_DIRECT_TOOLS;
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const wrapper = join(root, "extension.ts");
  await writeFile(
    wrapper,
    `import { createMcpAdapter } from ${JSON.stringify(resolve("dist/index.js"))};
    export default createMcpAdapter({ config: { mcpServers: ${JSON.stringify(options.servers ?? {})} } });`,
  );
  const settingsManager = sdk.SettingsManager.inMemory();
  const loaderOptions = {
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    additionalExtensionPaths: [wrapper],
  };
  const resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await sdk.ModelRuntime.create({
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
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  modelRuntime.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:1",
    api: model.api,
    apiKey: "fixture",
    models: [model],
  });
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    model,
    sessionManager: sdk.SessionManager.create(root, join(root, "sessions")),
    noTools: "builtin",
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.excludeTools !== undefined ? { excludeTools: options.excludeTools } : {}),
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
  const active = () =>
    session
      .getActiveToolNames()
      .filter((name) => name.startsWith("mcp"))
      .sort();
  async function request(
    steps: Array<Pick<ToolCall, "name" | "arguments">>,
    inspect?: (tools: ReturnType<typeof getCurrentTools>, stage: number) => void,
  ) {
    let stage = 0;
    const before = session.messages.length;
    session.agent.streamFunction = async (_model, context) => {
      inspect?.(getCurrentTools(context.messages), stage);
      const call = steps[stage++];
      const stopReason = call ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: call
          ? [{ type: "toolCall", id: `call-${before}-${stage}`, ...call }]
          : [{ type: "text", text: "done" }],
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
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: stopReason, message });
      return stream;
    };
    await session.prompt("Exercise the local MCP adapter tools.");
    await session.waitForIdle();
    expect(stage, JSON.stringify(session.messages.slice(before))).toBe(steps.length + 1);
    return session.messages.slice(before).filter((message) => message.role === "toolResult");
  }
  return { session, active, request };
}

describe("lazy MCP gateways through real Pi SDK", () => {
  it("attaches only the latest pending app context once, on the next user prompt", async () => {
    vi.stubEnv("MCP_UI_VIEWER", "none");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const h = await harness({
      servers: {
        selection: {
          command: process.execPath,
          args: [join(import.meta.dirname, "fixtures/app-context-server.mjs")],
        },
      },
    });
    const [launch] = await h.request([
      {
        name: "mcp",
        arguments: {
          action: "call",
          server: "selection",
          tool: "open_selector",
        },
      },
    ]);
    const output = requireValue(launch);
    expect(output.isError).toBe(false);
    const { uiUrl } = JSONObjectSchema.parse(output.details);
    if (typeof uiUrl !== "string") {
      throw new Error("Missing app URL");
    }
    const view = new URL(uiUrl);
    const endpoint = new URL("/proxy/ui/context", view);
    const postSelection = async (selection: string) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: requireValue(view.searchParams.get("session")),
          params: { structuredContent: { selection } },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, result: {} });
    };

    const contextMessages = () =>
      h.session.messages.filter(
        (message) => message.role === "custom" && message.customType === "mcp-ui-context",
      );
    const observe = vi.fn<() => void>();
    const unsubscribe = h.session.subscribe((event) => {
      if (event.type === "agent_start") {
        observe();
      }
    });
    onTestFinished(unsubscribe);
    await postSelection("obsolete");
    await postSelection("current");
    await h.session.waitForIdle();
    expect(observe).not.toHaveBeenCalled();
    expect(contextMessages()).toEqual([]);

    await h.session.sendCustomMessage(
      { customType: "unrelated", content: "Unrelated extension request", display: false },
      { triggerTurn: true },
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(contextMessages()).toEqual([]);

    await h.session.prompt("Use the current selection");
    const [context] = contextMessages();
    expect(context).toMatchObject({
      display: false,
      content: 'Context from the selection MCP app:\n{"structuredContent":{"selection":"current"}}',
    });
    await h.session.prompt("Continue");
    expect(contextMessages()).toEqual([context]);
    expect(observe).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("declares the gateway from startup with its complete schema", async () => {
    const h = await harness();
    expect(h.active()).toEqual(["mcp"]);
    const schemas: unknown[] = [];
    const outputs = await h.request(
      [
        { name: "mcp", arguments: { action: "ui-messages" } },
        { name: "mcp", arguments: { action: "resources" } },
      ],
      (tools) => {
        schemas.push(tools.find((tool) => tool.name === "mcp")?.parameters);
      },
    );
    expect(schemas).toHaveLength(3);
    for (const schema of schemas) {
      expect(schema).toEqual(gatewayParameters);
    }
    expect(requireValue(outputs[0]).isError).toBe(false);
    expect(requireValue(outputs[1]).isError).toBe(true); // Original per-action validation still owns execution.
    await h.session.reload();
    expect(h.active()).toEqual(["mcp"]);
  }, 20_000);

  it("keeps an allowlisted gateway usable across reload", async () => {
    const h = await harness({ tools: ["mcp"] });
    expect(h.active()).toEqual(["mcp"]);
    const result = await h.request([{ name: "mcp", arguments: { action: "status" } }]);
    const output = requireValue(result[0]);
    expect(output.isError).toBe(false);
    expect(JSONObjectSchema.parse(output.details).error).toBeUndefined();
    await h.session.reload();
    expect(h.active()).toEqual(["mcp"]);
  }, 20_000);

  it.each([
    { tools: ["mcp"], registered: ["mcp"] },
    { excludeTools: ["mcp"], registered: [] },
  ])(
    "registers only permitted gateways: $registered",
    async (options) => {
      const h = await harness(options);
      const registered = () =>
        h.session
          .getAllTools()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("mcp"))
          .sort();
      expect(registered()).toEqual(options.registered);
      expect(h.active()).toEqual(options.registered);
      await h.session.reload();
      expect(registered()).toEqual(options.registered);
      expect(h.active()).toEqual(options.registered);
    },
    20_000,
  );
});
