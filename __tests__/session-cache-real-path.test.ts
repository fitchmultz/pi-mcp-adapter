import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import MiniSearch from "minisearch";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computeServerHash } from "../metadata-cache.ts";

const original = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) {
    const entries = await readdir(root);
    const evidenceDir = process.env.PI_COMPAT_EVIDENCE_DIR;
    if (evidenceDir && entries.includes("sessions")) {
      await cp(join(root, "sessions"), join(evidenceDir, "session-cache-journals", basename(root)), { recursive: true });
    }
    await Promise.all(entries.filter(name => name !== "sessions" && !name.endsWith(".jsonl"))
      .map(name => rm(join(root, name), { recursive: true, force: true })));
    console.info(`Retained synthetic Pi journals under ${root}`);
  }
});

async function harness(cachedAt = Date.now()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-session-cache-real-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const adapterDir = join(agentDir, "fitch-mcp-adapter");
  await mkdir(adapterDir, { recursive: true });
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.MCP_DIRECT_TOOLS;
  const definition = { command: "synthetic-never-started", lifecycle: "lazy" as const, directTools: ["pinned"] };
  const cachePath = join(adapterDir, "mcp-cache.json");
  const configPath = join(adapterDir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { demo: definition }, settings: { sampling: false, elicitation: false } }));
  function cache(description: string) {
    return { version: 2, servers: { demo: { configHash: computeServerHash(definition), cachedAt, resources: [], tools: [
      { name: "pinned", description: "Pinned", inputSchema: { type: "object" } },
      { name: "search", description, inputSchema: { type: "object", properties: { query: { type: "string", description } } } },
    ] } } };
  }
  await writeFile(cachePath, JSON.stringify(cache("original")));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, additionalExtensionPaths: [resolve("index.ts")] });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "synthetic", model: "fixture", timestamp: Date.now(),
    content: [{ type: "text", text: "Public synthetic session." }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const first = manager.appendCustomEntry("mcp-tool-selection", { selected: [{ server: "demo", tool: "search" }], inactive: [{ server: "demo", tool: "pinned" }], features: [] });
  const second = manager.appendCustomEntry("mcp-tool-selection", { selected: [], inactive: [], features: ["gateway"] });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: manager, noTools: "builtin" });
  session.extensionRunner.setFlagValue("mcp-config", configPath);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
  await new Promise(resolve => setImmediate(resolve));
  return { root, session, first, second, errors, cachePath, cache, configPath, definition };
}

async function liveCatalogHarness() {
  const h = await harness();
  const callsPath = join(h.root, "catalog-calls.txt");
  const definition = {
    command: process.execPath,
    args: [resolve("__tests__/fixtures/search-catalog-server.mjs"), join(h.root, "catalog-phase"), callsPath],
    lifecycle: "lazy" as const,
    directTools: true,
  };
  const configure = async (server: object) => {
    await writeFile(h.configPath, JSON.stringify({ mcpServers: { demo: server }, settings: { sampling: false, elicitation: false } }));
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  };
  await writeFile(`${h.cachePath}.replacement`, JSON.stringify({ version: 2, servers: {} }));
  await rename(`${h.cachePath}.replacement`, h.cachePath);
  await configure(definition);
  let id = 0;
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = h.session.agent.state.tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Pi tool ${name} is not active`);
    return tool.execute(`catalog-${++id}`, params);
  };
  return { ...h, callsPath, definition, configure, run };
}

function matchedTools(result: { details: Record<string, unknown> }): string[] {
  return (result.details.matches as Array<{ tool: string }>).map(match => match.tool);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

function resourceUris(result: { details: Record<string, unknown> }): string[] {
  return (result.details.items as Array<{ uri: string }>).map(item => item.uri);
}

describe("cached tool surface through Pi SessionManager", () => {
  it("restores each branch's selections and observes changed metadata and config on session_start", async () => {
    const h = await harness();
    const active = () => h.session.getActiveToolNames().sort();
    try {
      expect(active()).toEqual(["demo_pinned", "mcp", "mcp_search"]);
      await h.session.navigateTree(h.first, { summarize: false });
      expect(active()).toEqual(["demo_search", "mcp_search"]);
      await h.session.navigateTree(h.second, { summarize: false });
      expect(active()).toEqual(["demo_pinned", "mcp", "mcp_search"]);
      await h.session.navigateTree(h.first, { summarize: false });
      expect(active()).toEqual(["demo_search", "mcp_search"]);
      await writeFile(`${h.cachePath}.replacement`, JSON.stringify(h.cache("updated")));
      await rename(`${h.cachePath}.replacement`, h.cachePath);
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await new Promise(resolve => setImmediate(resolve));
      expect(active()).toEqual(["demo_search", "mcp_search"]);
      const search = h.session.getAllTools().find(tool => tool.name === "demo_search");
      expect(search?.description).toBe("updated");
      expect(search?.parameters).toMatchObject({ properties: { query: { description: "updated" } } });
      await writeFile(h.configPath, JSON.stringify({ mcpServers: { demo: { ...h.definition, disabled: true } } }));
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await new Promise(resolve => setImmediate(resolve));
      expect(active()).toEqual(["mcp_search"]);
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
    expect(JSON.parse(await readFile(h.cachePath, "utf8")).servers.demo.tools[1].description).toBe("updated");
  });

  it("protects other configured servers when live discovery saves metadata and prunes obsolete entries", async () => {
    const h = await harness();
    const live = { command: process.execPath, args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")], lifecycle: "lazy" as const };
    const protectedDefinition = { command: "synthetic-never-started", lifecycle: "lazy" as const };
    const stale = { ...h.cache("protected").servers.demo, configHash: computeServerHash(protectedDefinition), cachedAt: Date.now() - 8 * 86400000 };
    const unknown = { futureFormat: true, cachedAt: Date.now() + 86400000 };
    try {
      await writeFile(h.configPath, JSON.stringify({ mcpServers: { demo: live, protected: protectedDefinition }, settings: { sampling: false, elicitation: false } }));
      await writeFile(h.cachePath, JSON.stringify({ version: 2, servers: {
        demo: { ...h.cache("demo").servers.demo, configHash: computeServerHash(live) },
        protected: stale, "recovery-old": stale,
        "recovery-future": { ...stale, cachedAt: Date.now() + 86400000 }, unknown,
      } }));
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await new Promise(resolve => setImmediate(resolve));
      const proxy = h.session.agent.state.tools.find(tool => tool.name === "mcp");
      expect(proxy).toBeDefined();
      await proxy!.execute("connect-for-cache-save", { action: "connect", server: "demo" });
      const stored = JSON.parse(await readFile(h.cachePath, "utf8"));
      expect(stored.servers.demo.tools.map((tool: { name: string }) => tool.name)).toEqual(["reload_identity"]);
      expect(stored.servers.protected).toEqual(stale);
      expect(stored.servers.unknown).toEqual(unknown);
      expect(stored.servers["recovery-old"]).toBeUndefined();
      expect(stored.servers["recovery-future"]).toBeUndefined();
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
  });

  it("does not advertise future-dated metadata as a known capability", async () => {
    const h = await harness(Date.now() + 86400000);
    try {
      expect(h.session.getAllTools().map(tool => tool.name)).not.toContain("demo_search");
      expect(h.session.getActiveToolNames().sort()).toEqual(["mcp", "mcp_search"]);
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
  });
});

describe("live catalog through Pi and MCP stdio", () => {
  it("keeps repeated calls and searches current across list changes, reconnect and config reload", async () => {
    const add = vi.spyOn(MiniSearch.prototype, "add");
    const h = await liveCatalogHarness();
    const search = (query: string) => h.run("mcp_search", { query, server: "demo", enable: ["gateway"] });
    const resources = () => h.run("mcp", { action: "resources", server: "demo" });
    try {
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(matchedTools(await search("indigo"))).toEqual([]);
      expect(add).toHaveBeenCalled();
      add.mockClear();
      expect(resultText(await h.run("demo_probe", { value: "first" }))).toContain("probe 0");
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(add).not.toHaveBeenCalled();
      expect(resultText(await h.run("mcp", { action: "call", server: "demo", tool: "probe", args: {} }))).toContain("probe 0");
      expect(resourceUris(await resources())).toEqual(["fixture://old"]);
      expect(resultText(await h.run("mcp", { action: "read-resource", server: "demo", uri: "fixture://old" }))).toContain("resource 0");
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(add).not.toHaveBeenCalled();

      expect(resultText(await h.run("mcp", { action: "call", server: "demo", tool: "advance", args: {} }))).toContain("catalog updated");
      await expect.poll(async () => matchedTools(await search("quartz")), { timeout: 10000 }).toEqual(["demo_probe"]);
      expect(add).toHaveBeenCalled();
      await expect.poll(async () => resourceUris(await resources()), { timeout: 10000 }).toEqual(["fixture://new"]);
      expect(matchedTools(await search("saffron"))).toEqual([]);
      expect(matchedTools(await search("indigo"))).toEqual(["demo_hidden"]);
      expect(h.session.getAllTools().find(tool => tool.name === "demo_probe")?.parameters)
        .toMatchObject({ properties: { value: { description: "quartz" } } });
      expect(resultText(await h.run("demo_probe", { value: "second" }))).toContain("probe 1");
      expect(resultText(await h.run("mcp", { action: "read-resource", server: "demo", uri: "fixture://new" }))).toContain("resource 1");

      expect((await h.run("mcp", { action: "connect", server: "demo" })).details.error).toBeUndefined();
      expect(matchedTools(await search("quartz"))).toEqual(["demo_probe"]);
      expect(resourceUris(await resources())).toEqual(["fixture://new"]);

      const callsBeforeDenial = await readFile(h.callsPath, "utf8");
      await h.configure({
        ...h.definition, toolPrefix: "none", includeTools: ["probe", "advance", "hidden", "read_reference"],
        excludeTools: ["hidden"], exposeResources: false, approveTools: ["probe"],
      });
      expect(matchedTools(await search("quartz"))).toEqual(["probe"]);
      expect(matchedTools(await search("indigo"))).toEqual([]);
      expect(resourceUris(await resources())).toEqual([]);
      expect((await h.run("probe", { value: "denied" })).details.error).toBe("approval_required");
      expect(await readFile(h.callsPath, "utf8")).toBe(callsBeforeDenial);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
    expect(h.errors).toEqual([]);
  }, 30000);
});
