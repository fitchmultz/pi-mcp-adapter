import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { JSONObjectSchema } from "@modelcontextprotocol/core";
import type { McpConfig } from "../../types.ts";
import { gatewayParameters } from "../../gateway-arguments.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness(
  options: { tools?: string[]; excludeTools?: string[]; config?: McpConfig } = {},
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
    export default createMcpAdapter({ config: ${JSON.stringify(options.config ?? { mcpServers: {} })} });`,
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
  it("advertises object-typed search alternatives and validates query or enable through Pi", async () => {
    const h = await harness();
    let search: ReturnType<typeof getCurrentTools>[number] | undefined;
    const outputs = await h.request(
      [
        { name: "mcp_search", arguments: { query: "" } },
        { name: "mcp_search", arguments: { enable: ["gateway"] } },
        { name: "mcp_search", arguments: { query: "", enable: ["script"] } },
        { name: "mcp_search", arguments: {} },
      ],
      (tools, stage) => {
        if (stage === 0) {
          search = tools.find((tool) => tool.name === "mcp_search");
        }
      },
    );
    // Providers such as xAI require an explicit object type on each root alternative.
    expect(search?.parameters).toMatchObject({
      type: "object",
      anyOf: [
        { type: "object", required: ["query"] },
        { type: "object", required: ["enable"] },
      ],
    });
    expect(outputs).toHaveLength(4);
    expect(outputs.slice(0, 3).map((output) => output.isError)).toEqual([false, false, false]);
    expect(h.active()).toEqual(["mcp", "mcp_script", "mcp_search"]);
    const rejected = requireValue(outputs[3]);
    expect(rejected.isError).toBe(true);
    // Require native schema rejection, not just the handler's "Provide query or enable" guard.
    const content = requireValue(rejected.content[0]);
    assert.equal(content.type, "text");
    expect(content.text).toContain('Validation failed for tool "mcp_search"');
  }, 20_000);

  it("loads complete original schemas on the next request, persists branches/reload and respects manual deselection", async () => {
    const h = await harness();
    expect(h.active()).toEqual(["mcp_search"]);
    expect(h.session.getAllTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["mcp", "mcp_script", "mcp_search"]),
    );
    const branch = h.session.sessionManager.appendCustomEntry("test-branch", {});
    const schemas: Array<{ script: unknown; gateway: unknown }> = [];
    const outputs = await h.request(
      [
        { name: "mcp_search", arguments: { enable: ["script"] } },
        { name: "mcp_script", arguments: { code: "emit(6 * 7);" } },
        { name: "mcp_search", arguments: { enable: ["gateway"] } },
        { name: "mcp", arguments: { action: "ui-messages" } },
        { name: "mcp", arguments: { action: "resources" } },
      ],
      (tools) => {
        schemas.push({
          script: tools.find((tool) => tool.name === "mcp_script")?.parameters,
          gateway: tools.find((tool) => tool.name === "mcp")?.parameters,
        });
      },
    );
    expect(schemas.map((schema) => schema.script !== undefined)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(schemas.map((schema) => schema.gateway !== undefined)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    for (const schema of schemas.slice(1)) {
      expect(schema.script).toMatchObject({
        required: ["code"],
        properties: { code: { type: "string" }, timeoutMs: { minimum: 1 } },
      });
    }
    for (const schema of schemas.slice(3)) {
      expect(schema.gateway).toEqual(gatewayParameters);
    }
    expect(outputs).toHaveLength(5);
    for (const output of outputs.slice(0, 4)) {
      expect(output.isError).toBe(false);
      expect(JSONObjectSchema.parse(output.details).error).toBeUndefined();
    }
    expect(requireValue(outputs[1]).content[0]).toMatchObject({ type: "text", text: "42" });
    expect(requireValue(outputs[4]).isError).toBe(true); // Original per-action validation still owns execution.
    expect(h.active()).toEqual(["mcp", "mcp_script", "mcp_search"]);
    const selectedBranch = requireValue(h.session.sessionManager.getLeafId());
    await h.session.reload();
    expect(h.active()).toEqual(["mcp", "mcp_script", "mcp_search"]);
    h.session.setActiveToolsByName(["mcp_search", "mcp"]);
    await h.session.reload();
    expect(h.active()).toEqual(["mcp", "mcp_search"]);
    await h.session.navigateTree(branch, { summarize: false });
    expect(h.active()).toEqual(["mcp_search"]);
    await h.session.navigateTree(selectedBranch, { summarize: false });
    expect(h.active()).toEqual(["mcp", "mcp_script", "mcp_search"]);
  }, 20_000);

  it.each(["mcp", "mcp_script"])(
    "keeps loader-excluded %s usable and eager",
    async (name) => {
      const h = await harness({ tools: [name] });
      expect(h.active()).toEqual([name]);
      const result = await h.request([
        { name, arguments: name === "mcp" ? { action: "status" } : { code: "return 42;" } },
      ]);
      const output = requireValue(result[0]);
      expect(output.isError).toBe(false);
      expect(JSONObjectSchema.parse(output.details).error).toBeUndefined();
      await h.session.reload();
      expect(h.active()).toEqual([name]);
    },
    20_000,
  );

  it.each([
    { tools: ["mcp_search", "mcp"], allowed: "mcp", unavailable: "script" },
    { tools: ["mcp_search", "mcp_script"], allowed: "mcp_script", unavailable: "gateway" },
    { excludeTools: ["mcp", "mcp_script"], allowed: undefined, unavailable: "both" },
    {
      config: { mcpServers: {}, settings: { scriptMode: false } },
      allowed: "mcp",
      unavailable: "script",
    },
  ])(
    "never activates or persists denied/config-disabled features: $unavailable / $allowed",
    async (options) => {
      const h = await harness(options);
      expect(h.active()).toEqual(["mcp_search"]);
      const [result] = await h.request([
        { name: "mcp_search", arguments: { enable: ["gateway", "script"] } },
      ]);
      assert.ok(result !== undefined);
      const details = JSONObjectSchema.parse(result.details);
      expect(details.loaded).toEqual(
        options.allowed !== undefined ? [{ name: options.allowed }] : [],
      );
      expect(details.unavailable).toEqual(
        options.unavailable === "both" ? ["gateway", "script"] : [options.unavailable],
      );
      const selection = h.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "mcp-tool-selection");
      assert.ok(selection?.type === "custom");
      const data = JSONObjectSchema.parse(selection.data);
      expect(data.features).toEqual(
        options.allowed !== undefined ? [options.allowed === "mcp" ? "gateway" : "script"] : [],
      );
      await h.session.reload();
      expect(h.active()).toEqual(
        options.allowed !== undefined ? [options.allowed, "mcp_search"].sort() : ["mcp_search"],
      );
    },
    20_000,
  );
});
