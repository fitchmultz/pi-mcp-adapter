import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { McpConfig } from "../types.ts";
import { gatewayParameters } from "../gateway-arguments.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(options: { tools?: string[]; excludeTools?: string[]; config?: McpConfig } = {}) {
  const sdk = process.env.PI_PACKAGE_DIR
    ? await import(/* @vite-ignore */ pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href)
    : await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "mcp-lazy-gateways-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const env = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS };
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.MCP_DIRECT_TOOLS;
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const wrapper = join(root, "extension.ts");
  await writeFile(wrapper, `import { createMcpAdapter } from ${JSON.stringify(resolve("dist/index.js"))};
    export default createMcpAdapter({ config: ${JSON.stringify(options.config ?? { mcpServers: {} })} });`);
  const settingsManager = sdk.SettingsManager.inMemory();
  const loaderOptions = { cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    additionalExtensionPaths: [wrapper] };
  const resourceLoader = new sdk.DefaultResourceLoader(loaderOptions);
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const model = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  modelRuntime.registerProvider("fixture", { baseUrl: "http://127.0.0.1:1", api: model.api, apiKey: "fixture", models: [model] });
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model,
    sessionManager: sdk.SessionManager.create(root, join(root, "sessions")), noTools: "builtin",
    ...(options.tools ? { tools: options.tools } : {}), ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}) });
  cleanups.push(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  await session.bindExtensions({ mode: "print", onError: (error: { error: string }) => { throw new Error(error.error); } });
  const active = () => session.getActiveToolNames().filter((name: string) => name.startsWith("mcp")).sort();
  async function request(steps: Array<{ name: string; arguments: Record<string, unknown> }>, inspect?: (tools: ReturnType<typeof getCurrentTools>, stage: number) => void) {
    let stage = 0;
    const before = session.messages.length;
    session.agent.streamFunction = async (_model: unknown, context: TranscriptContext) => {
      inspect?.(getCurrentTools(context.messages), stage);
      const call = steps[stage++];
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", id: `call-${before}-${stage}`, ...call }] : [{ type: "text", text: "done" }],
        stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.prompt("Exercise the local MCP adapter tools.");
    await session.waitForIdle();
    expect(stage, JSON.stringify(session.messages.slice(before))).toBe(steps.length + 1);
    return session.messages.slice(before).filter((message: any) => message.role === "toolResult");
  }
  return { session, active, request };
}

describe("lazy MCP gateways through real Pi SDK", () => {
  it("loads complete original schemas on the next request, persists branches/reload and respects manual deselection", async () => {
    const h = await harness();
    expect(h.active()).toEqual(["mcp_search"]);
    expect(h.session.getAllTools().map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["mcp", "mcp_script", "mcp_search"]));
    const branch = h.session.sessionManager.appendCustomEntry("test-branch", {});
    const outputs = await h.request([
      { name: "mcp_search", arguments: { enable: ["script"] } },
      { name: "mcp_script", arguments: { code: "emit(6 * 7);" } },
      { name: "mcp_search", arguments: { enable: ["gateway"] } },
      { name: "mcp", arguments: { action: "ui-messages" } },
      { name: "mcp", arguments: { action: "resources" } },
    ], (tools, stage) => {
      expect(tools.some(tool => tool.name === "mcp_script")).toBe(stage >= 1);
      expect(tools.some(tool => tool.name === "mcp")).toBe(stage >= 3);
      if (stage >= 1) expect(tools.find(tool => tool.name === "mcp_script")?.parameters).toMatchObject({
        required: ["code"], properties: { code: { type: "string" }, timeoutMs: { minimum: 1 } },
      });
      if (stage >= 3) expect(tools.find(tool => tool.name === "mcp")?.parameters).toEqual(gatewayParameters);
    });
    expect(outputs.slice(0, 4).every((output: any) => !output.isError && !output.details?.error)).toBe(true);
    expect(outputs[1].content[0].text).toBe("42");
    expect(outputs[4].isError).toBe(true); // Original per-action validation still owns execution.
    expect(h.active()).toEqual(["mcp", "mcp_script", "mcp_search"]);
    const selectedBranch = h.session.sessionManager.getLeafId();
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

  it.each(["mcp", "mcp_script"])("keeps loader-excluded %s usable and eager", async name => {
    const h = await harness({ tools: [name] });
    expect(h.active()).toEqual([name]);
    const result = await h.request([{ name, arguments: name === "mcp" ? { action: "status" } : { code: "return 42;" } }]);
    expect(result[0].isError).toBe(false);
    expect(result[0].details?.error).toBeUndefined();
    await h.session.reload();
    expect(h.active()).toEqual([name]);
  }, 20_000);

  it.each([
    { tools: ["mcp_search", "mcp"], allowed: "mcp", unavailable: "script" },
    { tools: ["mcp_search", "mcp_script"], allowed: "mcp_script", unavailable: "gateway" },
    { excludeTools: ["mcp", "mcp_script"], allowed: undefined, unavailable: "both" },
    { config: { mcpServers: {}, settings: { scriptMode: false } }, allowed: "mcp", unavailable: "script" },
  ])("never activates or persists denied/config-disabled features: $unavailable / $allowed", async options => {
    const h = await harness(options);
    expect(h.active()).toEqual(["mcp_search"]);
    const [result] = await h.request([{ name: "mcp_search", arguments: { enable: ["gateway", "script"] } }]);
    expect(result.details.loaded).toEqual(options.allowed ? [{ name: options.allowed }] : []);
    expect(result.details.unavailable).toEqual(options.unavailable === "both" ? ["gateway", "script"] : [options.unavailable]);
    const selection = h.session.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "mcp-tool-selection").at(-1).data;
    expect(selection.features).toEqual(options.allowed ? [options.allowed === "mcp" ? "gateway" : "script"] : []);
    await h.session.reload();
    expect(h.active()).toEqual(options.allowed ? [options.allowed, "mcp_search"].sort() : ["mcp_search"]);
  }, 20_000);
});
