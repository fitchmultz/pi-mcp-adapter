import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import MiniSearch from "minisearch";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { computeServerHash } from "../metadata-cache.ts";

const original = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  MCP_DIRECT_TOOLS: process.env.MCP_DIRECT_TOOLS,
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const root of roots.splice(0)) {
    const entries = await readdir(root);
    const evidenceDir = process.env.PI_COMPAT_EVIDENCE_DIR;
    if (evidenceDir !== undefined && evidenceDir.length > 0 && entries.includes("sessions")) {
      await cp(
        join(root, "sessions"),
        join(evidenceDir, "session-cache-journals", basename(root)),
        { recursive: true },
      );
    }
    await Promise.all(
      entries
        .filter((name) => name !== "sessions" && !name.endsWith(".jsonl"))
        .map((name) => rm(join(root, name), { recursive: true, force: true })),
    );
    console.info(`Retained synthetic Pi journals under ${root}`);
  }
});

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "synthetic",
    model: "fixture",
    timestamp: Date.now(),
    content,
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
}

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
  const definition = {
    command: "synthetic-never-started",
    lifecycle: "lazy" as const,
    directTools: ["pinned"],
  };
  const cachePath = join(adapterDir, "mcp-cache.json");
  const configPath = join(adapterDir, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: initialServers ?? { demo: definition },
      settings: { sampling: false, elicitation: false },
    }),
  );
  function cache(description: string) {
    return {
      version: 2,
      servers: {
        demo: {
          configHash: computeServerHash(definition),
          cachedAt,
          resources: [],
          tools: [
            { name: "pinned", description: "Pinned", inputSchema: { type: "object" } },
            {
              name: "search",
              description,
              inputSchema: {
                type: "object",
                properties: { query: { type: "string", description } },
              },
            },
          ],
        },
      },
    };
  }
  await writeFile(cachePath, JSON.stringify(cache("original")));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    additionalExtensionPaths: [extensionPath],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage(
    assistantMessage([{ type: "text", text: "Public synthetic session." }], "stop"),
  );
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: manager,
    noTools: "builtin",
  });
  session.extensionRunner.setFlagValue("mcp-config", configPath);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await setImmediate();
  return { root, session, errors, cachePath, cache, configPath, definition };
}

async function liveCatalogHarness() {
  const h = await harness();
  const callsPath = join(h.root, "catalog-calls.txt");
  const definition = {
    command: process.execPath,
    args: [
      resolve("__tests__/fixtures/search-catalog-server.mjs"),
      join(h.root, "catalog-phase"),
      callsPath,
    ],
    lifecycle: "lazy" as const,
    directTools: true,
  };
  const configure = async (server: object) => {
    await writeFile(
      h.configPath,
      JSON.stringify({
        mcpServers: { demo: server },
        settings: { sampling: false, elicitation: false },
      }),
    );
    await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  };
  await writeFile(`${h.cachePath}.replacement`, JSON.stringify({ version: 2, servers: {} }));
  await rename(`${h.cachePath}.replacement`, h.cachePath);
  await configure(definition);
  let id = 0;
  // Deferred catalog tools are declared once loaded; load them the way tool_search does.
  const run = async (name: string, params: Record<string, unknown>) => {
    if (h.session.getCallableToolNames().includes(name)) {
      h.session.setActiveToolsByName([...new Set([...h.session.getActiveToolNames(), name])]);
    }
    const tool = h.session.agent.state.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Pi tool ${name} is not active`);
    }
    const output = await tool.execute(`catalog-${++id}`, params);
    return { ...output, details: z.record(z.string(), z.unknown()).parse(output.details) };
  };
  return { ...h, callsPath, definition, configure, run };
}

function matchedTools(result: { details: Record<string, unknown> }): string[] {
  return z
    .object({ matches: z.array(z.object({ tool: z.string() })) })
    .parse(result.details)
    .matches.map((match) => match.tool);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function resourceUris(result: { details: Record<string, unknown> }): string[] {
  return z
    .object({ items: z.array(z.object({ uri: z.string() })) })
    .parse(result.details)
    .items.map((item) => item.uri);
}

const cachedNames = z.array(
  z.looseObject({ name: z.string(), description: z.string().optional() }),
);
const storedCacheSchema = z.object({
  version: z.number(),
  servers: z.record(
    z.string(),
    z.looseObject({
      tools: cachedNames.optional(),
      prompts: cachedNames.optional(),
      resources: z.array(z.unknown()).optional(),
    }),
  ),
});

async function readStoredCache(path: string) {
  return storedCacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
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
  it("registers the cached catalog and observes changed metadata and config on session_start", async () => {
    const h = await harness();
    const active = () => h.session.getActiveToolNames().sort();
    const search = () => h.session.getAllTools().find((tool) => tool.name === "demo_search");
    try {
      expect(active()).toEqual(["demo_pinned", "mcp"]);
      expect(search()?.exposure).toBe("deferred");
      expect(h.session.getCallableToolNames()).toContain("demo_search");
      await writeFile(`${h.cachePath}.replacement`, JSON.stringify(h.cache("updated")));
      await rename(`${h.cachePath}.replacement`, h.cachePath);
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await setImmediate();
      expect(active()).toEqual(["demo_pinned", "mcp"]);
      expect(search()?.description).toBe("updated");
      expect(search()?.parameters).toMatchObject({
        properties: { query: { description: "updated" } },
      });
      await writeFile(
        h.configPath,
        JSON.stringify({ mcpServers: { demo: { ...h.definition, disabled: true } } }),
      );
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await setImmediate();
      expect(active()).toEqual(["mcp"]);
      expect(search()?.exposure).toBe("hidden");
      expect(h.session.getCallableToolNames()).not.toContain("demo_search");
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
    expect((await readStoredCache(h.cachePath)).servers.demo?.tools?.[1]?.description).toBe(
      "updated",
    );
  });

  it("protects other configured servers when live discovery saves metadata and prunes obsolete entries", async () => {
    const h = await harness();
    const live = {
      command: process.execPath,
      args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")],
      lifecycle: "lazy" as const,
    };
    const protectedDefinition = { command: "synthetic-never-started", lifecycle: "lazy" as const };
    const stale = {
      ...h.cache("protected").servers.demo,
      configHash: computeServerHash(protectedDefinition),
      cachedAt: Date.now() - 8 * 86400000,
    };
    const unknown = { futureFormat: true, cachedAt: Date.now() + 86400000 };
    try {
      await writeFile(
        h.configPath,
        JSON.stringify({
          mcpServers: { demo: live, protected: protectedDefinition },
          settings: { sampling: false, elicitation: false },
        }),
      );
      await writeFile(
        h.cachePath,
        JSON.stringify({
          version: 2,
          servers: {
            demo: { ...h.cache("demo").servers.demo, configHash: computeServerHash(live) },
            protected: stale,
            "recovery-old": stale,
            "recovery-future": { ...stale, cachedAt: Date.now() + 86400000 },
            unknown,
          },
        }),
      );
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await setImmediate();
      const proxy = h.session.agent.state.tools.find((tool) => tool.name === "mcp");
      expect(proxy).toBeDefined();
      assert(proxy !== undefined);
      await proxy.execute("connect-for-cache-save", { action: "connect", server: "demo" });
      const stored = await readStoredCache(h.cachePath);
      expect(stored.servers.demo?.tools?.map((tool) => tool.name)).toEqual(["reload_identity"]);
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
    fs.renameSync = (from, to) => {
      const cachePath = join(
        process.env.PI_CODING_AGENT_DIR ?? "",
        "fitch-mcp-adapter",
        "mcp-cache.json",
      );
      if (track && String(to) === cachePath) {
        replacements++;
      }
      originalRename(from, to);
    };
    syncBuiltinESMExports();
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
      h = await harness(Date.now(), resolve("dist/index.js"), servers);
      const cachePath = h.cachePath;
      await expect
        .poll(
          async () => {
            const stored = await readStoredCache(cachePath);
            return names.map((name) => stored.servers[name]?.tools?.[0]?.name);
          },
          { timeout: 15_000 },
        )
        .toEqual(["reload_identity", "noop", "echo"]);
      track = false;
      const stored = await readStoredCache(h.cachePath);
      expect(stored.servers.second?.prompts?.map((prompt) => prompt.name)).toEqual([
        "brief",
        "haiku",
      ]);
      expect(stored.servers.third?.resources).toMatchObject([
        { name: "large", uri: "test://large" },
      ]);
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
      await writeFile(
        h.configPath,
        JSON.stringify({
          mcpServers: servers,
          settings: { sampling: false, elicitation: false },
        }),
      );
      await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
      await setImmediate();
      const proxy = h.session.agent.state.tools.find((tool) => tool.name === "mcp");
      expect(proxy).toBeDefined();
      assert(proxy !== undefined);
      for (const name of names) {
        const result = await proxy.execute(`connect-${name}`, { action: "connect", server: name });
        expect(z.record(z.string(), z.unknown()).parse(result.details).error).toBeUndefined();
      }

      const cache = await readStoredCache(h.cachePath);
      for (const name of names) {
        const entry = cache.servers[name];
        assert(entry !== undefined);
        entry.tools = [{ name: "stale" }];
      }
      assert(cache.servers.second !== undefined);
      assert(cache.servers.third !== undefined);
      cache.servers.second.prompts = [{ name: "stale" }];
      cache.servers.third.resources = [{ name: "stale", uri: "test://stale" }];
      cache.servers.external = { futureFormat: true };
      await writeFile(`${h.cachePath}.replacement`, JSON.stringify(cache));
      await rename(`${h.cachePath}.replacement`, h.cachePath);

      let replacements = 0;
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === h.cachePath) {
          replacements++;
        }
        originalRename(from, to);
      };
      syncBuiltinESMExports();
      try {
        shutdown = true;
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        fs.renameSync = originalRename;
        syncBuiltinESMExports();
      }

      const stored = await readStoredCache(h.cachePath);
      for (const [name, expectedTool] of Object.entries(expectedTools)) {
        expect(stored.servers[name]?.tools?.map((tool) => tool.name)).toEqual([expectedTool]);
      }
      expect(stored.servers.second?.prompts?.map((prompt) => prompt.name)).toEqual([
        "brief",
        "haiku",
      ]);
      expect(stored.servers.third?.resources).toMatchObject([
        { name: "large", uri: "test://large" },
      ]);
      expect(stored.servers.external).toEqual({ futureFormat: true });
      expect(h.errors).toEqual([]);
      expect(replacements).toBe(1);
    } finally {
      if (!shutdown) {
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
      h.session.dispose();
    }
  }, 30_000);

  it("does not advertise future-dated metadata as a known capability", async () => {
    const h = await harness(Date.now() + 86400000);
    try {
      expect(h.session.getAllTools().map((tool) => tool.name)).not.toContain("demo_search");
      expect(h.session.getActiveToolNames()).toEqual(["mcp"]);
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
  });
});

const cardArguments = {
  title: "Collapsed call cards",
  team: "Pi",
  priority: 2,
  state: "Todo",
  assignee: "me",
  tail: "tail-marker",
};
const cardArgumentRows = [
  "{",
  '  "title": "Collapsed call cards",',
  '  "team": "Pi",',
  '  "priority": 2,',
  '  "state": "Todo",',
  '  "assignee": "me",',
  '  "tail": "tail-marker"',
  "}",
];
const cardResult = {
  content: [
    {
      type: "text" as const,
      text: Array.from({ length: 8 }, (_, index) => `result line ${index + 1}`).join("\n"),
    },
  ],
  details: { mode: "call", server: "demo", tool: "pinned" },
  isError: false,
};

const exportedSessionSchema = z.object({
  renderedTools: z.record(
    z.string(),
    z.object({
      callHtml: z.string(),
      resultHtmlCollapsed: z.string().optional(),
      resultHtmlExpanded: z.string().optional(),
    }),
  ),
});

/** The cards Pi pre-rendered into an exported page, by tool call id. */
async function exportedCards(path: string) {
  const page = new JSDOM(await readFile(path, "utf8"));
  const data = page.window.document.querySelector("#session-data")?.textContent ?? "";
  return exportedSessionSchema.parse(JSON.parse(Buffer.from(data, "base64").toString("utf8")))
    .renderedTools;
}

function htmlRows(html: string | undefined): string[] {
  return [...JSDOM.fragment(html ?? "").querySelectorAll(".ansi-line")].map((row) =>
    row.textContent.trimEnd(),
  );
}

describe("MCP tool cards through Pi's HTML export and terminal card", () => {
  it("exports the complete arguments of typed and gateway calls and both result forms", async () => {
    const h = await harness();
    try {
      initTheme("dark"); // Pi's CLI does this at startup in every mode.
      h.session.sessionManager.appendMessage(
        assistantMessage(
          [
            { type: "toolCall", id: "typed", name: "demo_pinned", arguments: cardArguments },
            {
              type: "toolCall",
              id: "gateway",
              name: "mcp",
              arguments: { tool: "pinned", server: "demo", args: cardArguments },
            },
          ],
          "toolUse",
        ),
      );
      h.session.sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: "typed",
        toolName: "demo_pinned",
        timestamp: Date.now(),
        ...cardResult,
      });

      const cards = await exportedCards(await h.session.exportToHtml(join(h.root, "export.html")));

      // An exported call has no expanded form, so it must hold every argument.
      expect(htmlRows(cards.typed?.callHtml)).toEqual(["demo_pinned", ...cardArgumentRows]);
      expect(htmlRows(cards.gateway?.callHtml)).toEqual([
        "mcp call pinned @ demo",
        ...cardArgumentRows,
      ]);
      expect(htmlRows(cards.typed?.resultHtmlCollapsed).at(-1)).toContain("to expand");
      expect(htmlRows(cards.typed?.resultHtmlExpanded).at(-1)).toBe("result line 8");
      expect(h.errors).toEqual([]);
    } finally {
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      h.session.dispose();
    }
  });

  it("keeps the collapsed call preview in Pi's terminal card until the card is expanded", async () => {
    const h = await harness();
    try {
      initTheme("dark");
      const tui = new TuiMainScreen(new ProcessTerminal());
      vi.spyOn(tui, "requestRender").mockImplementation(() => {
        // Exercise the card without drawing to the user's terminal.
      });
      const card = new ToolExecutionComponent(
        "demo_pinned",
        "typed",
        cardArguments,
        {},
        h.session.getToolDefinition("demo_pinned"),
        tui,
        h.root,
      );
      const shown = () => stripVTControlCharacters(card.render(100).join("\n"));
      const expectCollapsedCall = () => {
        const text = shown();
        expect(text).toContain('"team": "Pi",');
        expect(text).not.toContain("tail-marker");
      };

      card.setExpanded(false); // Pi sets the expanded state on every card before it first shows it.
      expectCollapsedCall();
      card.setArgsComplete();
      card.markExecutionStarted();
      expectCollapsedCall();
      card.updateResult(cardResult);
      expectCollapsedCall();
      card.setExpanded(true);
      expect(shown()).toContain('"tail": "tail-marker"');
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
    const search = (query: string) => h.run("mcp", { action: "search", query, server: "demo" });
    const resources = () => h.run("mcp", { action: "resources", server: "demo" });
    try {
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(matchedTools(await search("indigo"))).toEqual([]);
      expect(matchedTools(await search("advance"))).toEqual(["demo_advance"]);
      expect(add).toHaveBeenCalled();
      add.mockClear();
      expect(resultText(await h.run("demo_probe", { value: "first" }))).toContain("probe 0");
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(add).not.toHaveBeenCalled();
      expect(
        resultText(await h.run("mcp", { action: "call", server: "demo", tool: "probe", args: {} })),
      ).toContain("probe 0");
      expect(resourceUris(await resources())).toEqual(["fixture://old"]);
      expect(
        resultText(
          await h.run("mcp", { action: "read-resource", server: "demo", uri: "fixture://old" }),
        ),
      ).toContain("resource 0");
      expect(matchedTools(await search("saffron"))).toEqual(["demo_probe"]);
      expect(add).not.toHaveBeenCalled();

      expect(
        resultText(
          await h.run("mcp", { action: "call", server: "demo", tool: "advance", args: {} }),
        ),
      ).toContain("catalog updated");
      await expect
        .poll(async () => matchedTools(await search("quartz")), { timeout: 10000 })
        .toEqual(["demo_probe"]);
      expect(add).toHaveBeenCalled();
      await expect
        .poll(async () => resourceUris(await resources()), { timeout: 10000 })
        .toEqual(["fixture://new"]);
      expect(matchedTools(await search("saffron"))).toEqual([]);
      expect(matchedTools(await search("indigo"))).toEqual(["demo_hidden"]);
      expect(
        h.session.getAllTools().find((tool) => tool.name === "demo_probe")?.parameters,
      ).toMatchObject({ properties: { value: { description: "quartz" } } });
      expect(resultText(await h.run("demo_probe", { value: "second" }))).toContain("probe 1");
      expect(
        resultText(
          await h.run("mcp", { action: "read-resource", server: "demo", uri: "fixture://new" }),
        ),
      ).toContain("resource 1");

      expect(
        (await h.run("mcp", { action: "connect", server: "demo" })).details.error,
      ).toBeUndefined();
      expect(matchedTools(await search("quartz"))).toEqual(["demo_probe"]);
      expect(resourceUris(await resources())).toEqual(["fixture://new"]);

      const callsBeforeDenial = await readFile(h.callsPath, "utf8");
      await h.configure({
        ...h.definition,
        toolPrefix: "none",
        includeTools: ["probe", "hidden", "read_reference"],
        excludeTools: ["hidden"],
        exposeResources: false,
        approveTools: ["probe"],
      });
      expect(matchedTools(await search("quartz"))).toEqual(["probe"]);
      expect(matchedTools(await search("indigo"))).toEqual([]);
      expect(matchedTools(await search("advance"))).toEqual([]);
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
