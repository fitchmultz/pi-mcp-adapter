import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computeServerHash } from "../metadata-cache.ts";

const original = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function harness(cachedAt = Date.now()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-session-cache-real-"));
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
  const first = manager.appendCustomEntry("mcp-tool-selection", { selected: [{ server: "demo", tool: "search" }], inactive: [{ server: "demo", tool: "pinned" }], features: [] });
  const second = manager.appendCustomEntry("mcp-tool-selection", { selected: [], inactive: [], features: ["gateway"] });
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: manager, noTools: "builtin" });
  session.extensionRunner.setFlagValue("mcp-config", configPath);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
  await new Promise(resolve => setImmediate(resolve));
  return { root, session, first, second, errors, cachePath, cache, configPath, definition };
}

describe("cached tool surface through Pi SessionManager", () => {
  it("restores each branch while reusing metadata and observes changed metadata and config on session_start", async () => {
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
