import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computeServerHash } from "../metadata-cache.ts";

const original = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS };
const roots: string[] = [];
afterEach(async () => {
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

async function harness(
  cachedAt = Date.now(),
  extensionPath = resolve("index.ts"),
  initialServers?: Record<string, { command: string; args: string[]; lifecycle: "eager" | "lazy" }>,
) {
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
  await writeFile(configPath, JSON.stringify({ mcpServers: initialServers ?? { demo: definition }, settings: { sampling: false, elicitation: false } }));
  function cache(description: string) {
    return { version: 2, servers: { demo: { configHash: computeServerHash(definition), cachedAt, resources: [], tools: [
      { name: "pinned", description: "Pinned", inputSchema: { type: "object" } },
      { name: "search", description, inputSchema: { type: "object", properties: { query: { type: "string", description } } } },
    ] } } };
  }
  await writeFile(cachePath, JSON.stringify(cache("original")));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, additionalExtensionPaths: [extensionPath] });
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

function liveServers(lifecycle: "eager" | "lazy") {
  const server = (fixture: string) => ({
    command: process.execPath,
    args: [resolve("__tests__/fixtures", fixture)],
    lifecycle,
  });
  return {
    first: server("delayed-mcp-server.mjs"),
    second: server("prompts-server.mjs"),
    third: server("output-server.mjs"),
  };
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

  it("persists an eager startup cohort in one replacement", async () => {
    const servers = liveServers("eager");
    const names = Object.keys(servers);
    let replacements = 0;
    let track = true;
    const originalRename = fs.renameSync;
    fs.renameSync = ((from, to) => {
      const cachePath = join(process.env.PI_CODING_AGENT_DIR ?? "", "fitch-mcp-adapter", "mcp-cache.json");
      if (track && String(to) === cachePath) replacements++;
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      h = await harness(Date.now(), resolve("dist/index.js"), servers);
      await expect.poll(async () => {
        const stored = JSON.parse(await readFile(h!.cachePath, "utf8"));
        return names.map(name => stored.servers[name]?.tools?.[0]?.name);
      }, { timeout: 15_000 }).toEqual(["reload_identity", "noop", "echo"]);
      track = false;
      const stored = JSON.parse(await readFile(h.cachePath, "utf8"));
      expect(stored.servers.second.prompts.map((prompt: { name: string }) => prompt.name)).toEqual(["brief", "haiku"]);
      expect(stored.servers.third.resources).toMatchObject([{ name: "large", uri: "test://large" }]);
      expect(h.errors).toEqual([]);
      expect(replacements).toBe(1);
    } finally {
      track = false;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
      if (h) {
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        h.session.dispose();
      }
    }
  }, 30_000);

  it("persists all connected server metadata in one shutdown replacement", async () => {
    const h = await harness(Date.now(), resolve("dist/index.js"));
    const servers = liveServers("lazy");
    const expectedTools = { first: "reload_identity", second: "noop", third: "echo" };
    const names = Object.keys(servers);
    let shutdown = false;
    try {
      await writeFile(h.configPath, JSON.stringify({
        mcpServers: servers,
        settings: { sampling: false, elicitation: false },
      }));
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await new Promise(resolve => setImmediate(resolve));
      const proxy = h.session.agent.state.tools.find(tool => tool.name === "mcp");
      expect(proxy).toBeDefined();
      for (const name of names) {
        const result = await proxy!.execute(`connect-${name}`, { action: "connect", server: name });
        expect(result.details?.error).toBeUndefined();
      }

      const cache = JSON.parse(await readFile(h.cachePath, "utf8"));
      for (const name of names) cache.servers[name].tools = [{ name: "stale" }];
      cache.servers.second.prompts = [{ name: "stale" }];
      cache.servers.third.resources = [{ name: "stale", uri: "test://stale" }];
      cache.servers.external = { futureFormat: true };
      await writeFile(`${h.cachePath}.replacement`, JSON.stringify(cache));
      await rename(`${h.cachePath}.replacement`, h.cachePath);

      let replacements = 0;
      const originalRename = fs.renameSync;
      fs.renameSync = ((from, to) => {
        if (String(to) === h.cachePath) replacements++;
        return originalRename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try {
        shutdown = true;
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        fs.renameSync = originalRename;
        syncBuiltinESMExports();
      }

      const stored = JSON.parse(await readFile(h.cachePath, "utf8"));
      for (const [name, expectedTool] of Object.entries(expectedTools)) {
        expect(stored.servers[name].tools.map((tool: { name: string }) => tool.name)).toEqual([expectedTool]);
      }
      expect(stored.servers.second.prompts.map((prompt: { name: string }) => prompt.name)).toEqual(["brief", "haiku"]);
      expect(stored.servers.third.resources).toMatchObject([{ name: "large", uri: "test://large" }]);
      expect(stored.servers.external).toEqual({ futureFormat: true });
      expect(h.errors).toEqual([]);
      expect(replacements).toBe(1);
    } finally {
      if (!shutdown) await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
  }, 30_000);

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
