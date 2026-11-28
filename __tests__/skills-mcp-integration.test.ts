import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  initTheme,
  loadSkillsFromDir,
  type ExtensionContext,
  type ExtensionUIContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "../index.ts";
import { getMetadataCachePath, loadMetadataCache } from "../metadata-cache.ts";
import { MCP_STATUS_EVENT, type McpConfig } from "../types.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";

const skillsFixture = fileURLToPath(new URL("./fixtures/skills-stdio-server.ts", import.meta.url));

interface StatusSnapshotSummary {
  readonly connectedCount?: number;
  readonly totalSkills?: number;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly status?: string;
    readonly skillCount?: number;
  }>;
}

function isStatusSnapshotSummary(value: unknown): value is StatusSnapshotSummary {
  return (
    value !== null &&
    typeof value === "object" &&
    "servers" in value &&
    Array.isArray(value.servers)
  );
}

function skillsServer(
  mode: "valid" | "mixed" | "no-skills" | "updated" | "controlled",
  extra: Record<string, unknown> = {},
) {
  return {
    command: process.execPath,
    args: [skillsFixture, mode],
    ...extra,
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listSkillDirNames(agentDir: string): string[] {
  const skillsRoot = join(agentDir, "mcp-skills");
  if (!existsSync(skillsRoot)) {
    return [];
  }
  const names: string[] = [];
  for (const runtimeId of readdirSync(skillsRoot)) {
    const runtimePath = join(skillsRoot, runtimeId);
    for (const serverDir of readdirSync(runtimePath)) {
      const serverPath = join(runtimePath, serverDir);
      for (const skillDir of readdirSync(serverPath)) {
        names.push(skillDir);
      }
    }
  }
  return names.sort();
}

describe("MCP Skills (SEP-2640) integration", () => {
  beforeAll(() => {
    initTheme();
  });
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempRoots: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  function createWorkspace(): { root: string; home: string; agentDir: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-skills-int-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return { root, home, agentDir, project };
  }

  async function mountAdapter(input: {
    cwd: string;
    config?: McpConfig;
    trusted?: boolean;
    sessionId?: string;
  }) {
    let currentCwd = input.cwd;
    let projectTrusted = input.trusted ?? true;
    const sessionId = input.sessionId;
    const notifications: Array<{ message: string; level: string }> = [];
    const reloadSpy = vi.fn<() => Promise<void>>(async () => Promise.resolve());
    const statuses: StatusSnapshotSummary[] = [];

    const fixture = await createTestExtensionContext(
      "builtin",
      createMcpAdapter(input.config ? { config: input.config } : {}),
    );
    fixture.api.events.on(MCP_STATUS_EVENT, (payload) => {
      if (isStatusSnapshotSummary(payload)) {
        statuses.push(payload);
      }
    });
    const baseCreate = fixture.runner.createContext.bind(fixture.runner);
    const uiNotify = vi.fn<ExtensionUIContext["notify"]>((message, level = "info") => {
      notifications.push({ message, level });
    });
    fixture.runner.setUIContext({ ...fixture.runner.getUIContext(), notify: uiNotify }, "tui");
    vi.spyOn(fixture.runner, "createContext").mockImplementation((): ExtensionContext => {
      const base = baseCreate();
      return {
        ...base,
        ...(sessionId !== undefined
          ? { sessionManager: { ...base.sessionManager, getSessionId: () => sessionId } }
          : {}),
        cwd: currentCwd,
        isProjectTrusted: () => projectTrusted,
        ui: { ...fixture.runner.getUIContext(), notify: uiNotify },
      };
    });

    cleanups.push(async () => {
      await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
      await fixture.dispose();
    });

    return {
      fixture,
      notifications,
      reloadSpy,
      statuses,
      setCwd(nextCwd: string) {
        currentCwd = nextCwd;
      },
      setTrusted(trusted: boolean) {
        projectTrusted = trusted;
      },
      async start(reason: SessionStartEvent["reason"] = "startup") {
        await fixture.runner.emit({ type: "session_start", reason });
      },
      async discover(reason: "startup" | "reload" = "startup") {
        return fixture.runner.emitResourcesDiscover(currentCwd, reason);
      },
      async callMcp(args: Record<string, unknown>) {
        const mcpTool = requireValue(fixture.runner.getToolDefinition("mcp"));
        return mcpTool.execute(
          "call-1",
          args,
          fixture.context.signal,
          undefined,
          fixture.runner.createToolContext("call-1", fixture.context.signal),
        );
      },
      async runMcpCommand(args: string) {
        const cmd = requireValue(fixture.runner.getCommand("mcp"));
        await cmd.handler(args, {
          ...fixture.runner.createCommandContext(),
          cwd: currentCwd,
          isProjectTrusted: () => projectTrusted,
          reload: reloadSpy,
          ui: { ...fixture.runner.getUIContext(), notify: uiNotify },
        });
      },
    };
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("auto-exposes verified skills with private permissions into resources_discover and status", async () => {
    const ws = createWorkspace();
    const host = await mountAdapter({
      cwd: ws.project,
      config: {
        mcpServers: {
          alpha: skillsServer("valid", { lifecycle: "eager" }),
          plain: skillsServer("no-skills", { lifecycle: "eager" }),
        },
      },
    });

    await host.start();
    const discovered = await host.discover();
    expect(discovered.skillPaths).toHaveLength(2);

    const alphaDir = requireValue(
      discovered.skillPaths.find((entry) => entry.path.endsWith("/alpha-skill")),
    ).path;
    const loaded = loadSkillsFromDir({ dir: alphaDir, source: "mcp" });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills.map((skill) => skill.name)).toEqual(["alpha-skill"]);
    expect(statSync(alphaDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(alphaDir, "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(alphaDir, "references", "guide.md"), "utf8")).toContain(
      "Use verified skills.",
    );

    const latestStatus = requireValue(host.statuses.at(-1));
    expect(latestStatus.totalSkills).toBe(2);
    expect(latestStatus.servers.find((s) => s.name === "alpha")?.skillCount).toBe(2);
    expect(latestStatus.servers.find((s) => s.name === "plain")?.skillCount).toBeUndefined();

    const gatewayStatus = await host.callMcp({ action: "status" });
    const statusText = gatewayStatus.content.find((block) => block.type === "text")?.text ?? "";
    expect(statusText).toContain("2 skills");
  });

  it("respects global settings.exposeSkills and per-server exposeSkills toggles", async () => {
    const ws = createWorkspace();
    const disabledGlobally = await mountAdapter({
      cwd: ws.project,
      config: {
        settings: { exposeSkills: false },
        mcpServers: { alpha: skillsServer("valid", { lifecycle: "eager" }) },
      },
    });
    await disabledGlobally.start();
    expect((await disabledGlobally.discover()).skillPaths).toEqual([]);

    const perServer = await mountAdapter({
      cwd: ws.project,
      config: {
        mcpServers: {
          hidden: skillsServer("valid", { lifecycle: "eager", exposeSkills: false }),
          shown: skillsServer("updated", { lifecycle: "eager", exposeSkills: true }),
        },
      },
    });
    await perServer.start();
    const result = await perServer.discover();
    expect(result.skillPaths.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/\/gamma-skill$/),
    ]);
  });

  it("blocks project server skills until project is trusted while keeping global server skills", async () => {
    const ws = createWorkspace();
    writeJson(join(ws.agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: { globalSkills: skillsServer("updated", { lifecycle: "eager" }) },
    });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { projectSkills: skillsServer("valid", { lifecycle: "eager" }) },
    });

    const host = await mountAdapter({ cwd: ws.project, trusted: false });
    await host.start();
    const untrustedDiscovered = await host.discover();
    expect(untrustedDiscovered.skillPaths.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/\/gamma-skill$/),
    ]);

    host.setTrusted(true);
    await host.start("reload");
    const trustedDiscovered = await host.discover("reload");
    expect(trustedDiscovered.skillPaths).toHaveLength(3);
  });

  it("rejects dynamic, SkillVerificationError, and traversal skills without breaking valid siblings", async () => {
    const ws = createWorkspace();
    const host = await mountAdapter({
      cwd: ws.project,
      config: { mcpServers: { mixed: skillsServer("mixed", { lifecycle: "eager" }) } },
    });
    await host.start();
    const discovered = await host.discover();
    expect(discovered.skillPaths.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/\/valid-skill$/),
    ]);
    const ping = await host.callMcp({ action: "call", server: "mixed", tool: "ping" });
    expect(ping.isError).not.toBe(true);
    expect(ping.content[0]).toMatchObject({ type: "text", text: "pong:mixed" });
  });

  it("keeps lazy servers disconnected despite cached skills, notifies on lazy discovery, and waits on eager startup during resources_discover", async () => {
    const ws = createWorkspace();
    const otherProject = join(ws.root, "other-project");
    const eagerProject = join(ws.root, "eager-project");
    mkdirSync(otherProject, { recursive: true });
    mkdirSync(eagerProject, { recursive: true });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { lazySkills: skillsServer("valid") },
    });
    writeJson(join(eagerProject, ".mcp.json"), {
      mcpServers: { eagerSkills: skillsServer("valid", { lifecycle: "eager" }) },
    });

    const firstHost = await mountAdapter({ cwd: ws.project, trusted: true });
    await firstHost.start();
    expect((await firstHost.discover()).skillPaths).toEqual([]);

    await firstHost.callMcp({ action: "connect", server: "lazySkills" });
    expect(firstHost.notifications.some((n) => n.message.includes("/reload"))).toBe(true);

    await firstHost.runMcpCommand("reconnect lazySkills");
    expect(firstHost.reloadSpy).toHaveBeenCalledTimes(1);

    const cache = requireValue(loadMetadataCache(true));
    expect(cache.servers.lazySkills?.skills?.map((s) => s.name).sort()).toEqual([
      "alpha-skill",
      "beta-skill",
    ]);
    expect(existsSync(getMetadataCachePath())).toBe(true);
    await firstHost.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Next fresh session: lazy server with cached skills stays disconnected at startup.
    const secondHost = await mountAdapter({ cwd: ws.project, trusted: true });
    await secondHost.start();
    expect((await secondHost.discover()).skillPaths).toEqual([]);
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);
    const freshStatus = requireValue(secondHost.statuses.at(-1));
    expect(freshStatus.connectedCount).toBe(0);
    expect(freshStatus.servers.find((s) => s.name === "lazySkills")?.status).toBe("cached");

    // Reconciling into the project on cwd change also keeps the lazy cached-skills server disconnected.
    const reconcileHost = await mountAdapter({ cwd: otherProject, trusted: true });
    await reconcileHost.start();
    await reconcileHost.discover();
    reconcileHost.setCwd(ws.project);
    await reconcileHost.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "switch to project with cached skills" },
      { cwd: ws.project },
    );
    const reconcileStatus = requireValue(reconcileHost.statuses.at(-1));
    expect(reconcileStatus.connectedCount).toBe(0);
    expect(reconcileStatus.servers.find((s) => s.name === "lazySkills")?.status).toBe("cached");
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);
    await reconcileHost.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Connecting on demand still discovers and materializes verified skills.
    await secondHost.callMcp({ action: "connect", server: "lazySkills" });
    expect(secondHost.notifications.some((n) => n.message.includes("/reload"))).toBe(true);
    expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill"]);
    await secondHost.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Eager servers still synchronize startup skill discovery with resources_discover.
    const eagerHost = await mountAdapter({ cwd: eagerProject, trusted: true });
    const startPromise = eagerHost.start();
    const discovered = await eagerHost.discover();
    await startPromise;
    expect(discovered.skillPaths).toHaveLength(2);
  });

  it("preserves on-demand lazy skills across /reload without reconnecting and drops them on config change or /new", async () => {
    const ws = createWorkspace();
    const otherProject = join(ws.root, "other-project");
    mkdirSync(otherProject, { recursive: true });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { lazySkills: skillsServer("valid") },
    });

    const sessionId = "reload-e2e-session";
    const firstHost = await mountAdapter({ cwd: ws.project, trusted: true, sessionId });
    await firstHost.start();
    expect((await firstHost.discover()).skillPaths).toEqual([]);

    await firstHost.callMcp({ action: "connect", server: "lazySkills" });
    expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill"]);
    await firstHost.fixture.runner.emit({ type: "session_shutdown", reason: "reload" });
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);

    // Simulated Pi /reload with a fresh adapter instance: skills return without reconnecting lazySkills.
    const reloadedHost = await mountAdapter({ cwd: ws.project, trusted: true, sessionId });
    const startPromise = reloadedHost.start("reload");
    const discovered = await reloadedHost.discover("reload");
    await startPromise;
    expect(discovered.skillPaths).toHaveLength(2);
    expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill"]);
    expect(reloadedHost.statuses.at(-1)?.connectedCount).toBe(0);
    expect(reloadedHost.statuses.at(-1)?.servers.find((s) => s.name === "lazySkills")?.status).toBe(
      "cached",
    );

    // Consecutive /reload preserves carried-over skills; switching cwd drops them.
    await reloadedHost.fixture.runner.emit({ type: "session_shutdown", reason: "reload" });
    const secondReloadHost = await mountAdapter({ cwd: ws.project, trusted: true, sessionId });
    await secondReloadHost.start("reload");
    expect((await secondReloadHost.discover("reload")).skillPaths).toHaveLength(2);
    secondReloadHost.setCwd(otherProject);
    await secondReloadHost.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "leave project" },
      { cwd: otherProject },
    );
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);

    // Re-connect then reload with changed server config invalidates carry-over; /new also clears it.
    secondReloadHost.setCwd(ws.project);
    await secondReloadHost.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "return" },
      { cwd: ws.project },
    );
    await secondReloadHost.callMcp({ action: "connect", server: "lazySkills" });
    await secondReloadHost.fixture.runner.emit({ type: "session_shutdown", reason: "reload" });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { lazySkills: skillsServer("updated") },
    });
    const changedHost = await mountAdapter({ cwd: ws.project, trusted: true, sessionId });
    await changedHost.start("reload");
    expect((await changedHost.discover("reload")).skillPaths).toEqual([]);
    await changedHost.callMcp({ action: "connect", server: "lazySkills" });
    await changedHost.fixture.runner.emit({ type: "session_shutdown", reason: "new" });
    const newSessionHost = await mountAdapter({ cwd: ws.project, trusted: true, sessionId });
    await newSessionHost.start("new");
    expect((await newSessionHost.discover()).skillPaths).toEqual([]);
  });

  it("cleans up materialized skill directories on cwd change and session shutdown", async () => {
    const ws = createWorkspace();
    const projectB = join(ws.root, "project-b");
    mkdirSync(projectB, { recursive: true });
    writeJson(join(ws.agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: { globalSkills: skillsServer("updated", { lifecycle: "eager" }) },
    });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { projSkills: skillsServer("valid", { lifecycle: "eager" }) },
    });

    const host = await mountAdapter({ cwd: ws.project, trusted: true });
    await host.start();
    await host.discover();
    expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill", "gamma-skill"]);

    host.setCwd(projectB);
    await host.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "switch dir" },
      { cwd: projectB },
    );
    expect(listSkillDirNames(ws.agentDir)).toEqual(["gamma-skill"]);

    await host.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);
  });

  it("preserves verified skills on disk and cache when skills/list fails during resources/list_changed", async () => {
    const ws = createWorkspace();
    const host = await mountAdapter({
      cwd: ws.project,
      config: { mcpServers: { live: skillsServer("controlled", { lifecycle: "eager" }) } },
    });
    await host.start();
    await host.discover();
    expect(listSkillDirNames(ws.agentDir)).toEqual(["v1-skill"]);
    expect(loadMetadataCache(true)?.servers.live?.skills?.map((entry) => entry.name)).toEqual([
      "v1-skill",
    ]);

    await host.callMcp({
      action: "call",
      server: "live",
      tool: "set_refresh_mode",
      args: { failList: true },
    });
    await host.callMcp({ action: "call", server: "live", tool: "emit_list_changed", args: {} });

    const statsSchema = z.object({ started: z.number(), completed: z.number() });
    await expect
      .poll(async () => {
        const res = await host.callMcp({
          action: "call",
          server: "live",
          tool: "get_refresh_stats",
          args: {},
        });
        const text = res.content[0]?.type === "text" ? res.content[0].text : "{}";
        return statsSchema.parse(JSON.parse(text)).completed;
      })
      .toBeGreaterThanOrEqual(2);
    await delay(80);
    expect(listSkillDirNames(ws.agentDir)).toEqual(["v1-skill"]);
    expect(loadMetadataCache(true)?.servers.live?.skills?.map((entry) => entry.name)).toEqual([
      "v1-skill",
    ]);
  });

  it("drops stale overlapping resources/list_changed skills refreshes when a newer generation commits", async () => {
    const ws = createWorkspace();
    const host = await mountAdapter({
      cwd: ws.project,
      config: { mcpServers: { live: skillsServer("controlled", { lifecycle: "eager" }) } },
    });
    await host.start();
    await host.discover();
    expect(listSkillDirNames(ws.agentDir)).toEqual(["v1-skill"]);

    const statsSchema = z.object({ started: z.number(), completed: z.number() });
    const readStats = async () => {
      const res = await host.callMcp({
        action: "call",
        server: "live",
        tool: "get_refresh_stats",
        args: {},
      });
      const text = res.content[0]?.type === "text" ? res.content[0].text : "{}";
      return statsSchema.parse(JSON.parse(text));
    };

    await host.callMcp({
      action: "call",
      server: "live",
      tool: "set_refresh_mode",
      args: { skillName: "v2-skill", delayMs: 650 },
    });
    await host.callMcp({ action: "call", server: "live", tool: "emit_list_changed", args: {} });
    await expect.poll(async () => (await readStats()).started).toBeGreaterThanOrEqual(2);

    await host.callMcp({
      action: "call",
      server: "live",
      tool: "set_refresh_mode",
      args: { skillName: "v3-skill", delayMs: 0 },
    });
    await host.callMcp({ action: "call", server: "live", tool: "emit_list_changed", args: {} });
    await expect.poll(() => listSkillDirNames(ws.agentDir)).toEqual(["v3-skill"]);
    await expect.poll(async () => (await readStats()).completed).toBeGreaterThanOrEqual(3);
    await delay(80);
    expect(listSkillDirNames(ws.agentDir)).toEqual(["v3-skill"]);
    expect(loadMetadataCache(true)?.servers.live?.skills?.map((entry) => entry.name)).toEqual([
      "v3-skill",
    ]);
  });

  it("prunes dead-PID skill directories, skips redundant re-materialization, and isolates storage errors from tool calls", async () => {
    const ws = createWorkspace();
    const deadDir = join(ws.agentDir, "mcp-skills", "999999-crashed-session");
    const liveSiblingDir = join(ws.agentDir, "mcp-skills", `${process.pid}-sibling-session`);
    mkdirSync(deadDir, { recursive: true });
    mkdirSync(liveSiblingDir, { recursive: true });
    writeFileSync(join(deadDir, "stale.txt"), "stale", "utf8");

    const host = await mountAdapter({
      cwd: ws.project,
      config: {
        settings: {},
        mcpServers: {
          live: skillsServer("controlled", { lifecycle: "eager" }),
        },
      },
    });

    await host.start();
    const discovery = await host.discover();
    expect(discovery.skillPaths).toHaveLength(1);
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(liveSiblingDir)).toBe(true);

    // Subsequent tool calls with unchanged skill bundles do not rewrite skill files on disk.
    const skillDir = requireValue(discovery.skillPaths[0]).path;
    const skillMdPath = join(skillDir, "SKILL.md");
    const sentinel = join(dirname(skillDir), ".no-rewrite-sentinel");
    writeFileSync(sentinel, "keep", "utf8");
    const callRes = await host.callMcp({
      action: "call",
      server: "live",
      tool: "get_refresh_stats",
      args: {},
    });
    expect(callRes.isError).not.toBe(true);
    expect(existsSync(skillMdPath)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);

    // Storage errors (e.g. <agentDir>/mcp-skills blocked by a file) must not fail syncConnectedServerSkills.
    const { syncConnectedServerSkills } = await import("../mcp-skills-store.ts");
    const { createTestState } = await import("./test-state.ts");
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const blockedState = createTestState({
      config: { mcpServers: { live: { command: process.execPath, args: [] } } },
    });
    rmSync(join(ws.agentDir, "mcp-skills"), { recursive: true, force: true });
    writeFileSync(join(ws.agentDir, "mcp-skills"), "not-a-directory", "utf8");
    syncConnectedServerSkills(blockedState, "live", {
      client: new Client({ name: "test", version: "1" }),
      transport: InMemoryTransport.createLinkedPair()[0],
      definition: { command: process.execPath, args: [] },
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status: "connected",
      verifiedSkillBundles: [
        {
          dirName: "blocked-skill",
          metadata: {
            name: "blocked-skill",
            description: "Blocked",
            uri: "skill://blocked-skill/SKILL.md",
          },
          files: [{ relativeSegments: ["SKILL.md"], content: Buffer.from("invalid") }],
        },
      ],
    });
    expect(blockedState.skillMetadata?.size ?? 0).toBe(0);

    // Even if a throwing serverClosedListener is registered, manager close() and closeAll() settle cleanly.
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setServerClosedListener(() => {
      throw new Error("simulated EPERM during cleanup");
    });
    await expect(manager.close("live")).resolves.toBeUndefined();
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });

  it("refuses a skill whose SKILL.md alone exceeds SKILL_LIMITS.bytes", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { SkillsExtension, skillEntry } = await import("@modelcontextprotocol/server/ext/skills");
    const { discoverServerSkills } = await import("../mcp-skills.ts");
    const { logger } = await import("../logger.ts");

    const server = new McpServer({ name: "skills-oversized", version: "1.0.0" });
    server.registerTool(
      "ping",
      { description: "Health ping tool", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text" as const, text: "pong:oversized-main" }] }),
    );
    const prefix = "---\nname: oversized-skill\ndescription: Too large.\n---\n";
    const oversized = `${prefix}${"a".repeat(16 * 1024 * 1024 + 64 - Buffer.byteLength(prefix, "utf8"))}`;
    const skill = await skillEntry("oversized-skill", { "SKILL.md": oversized });
    new SkillsExtension({
      source: {
        list: async () => ({ skills: [skill] }),
        get: async (uri) => (uri === skill.uri ? skill : undefined),
        read: async (uri) =>
          uri === skill.uri ? { text: oversized, mimeType: "text/markdown" } : undefined,
      },
    }).attach(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const warnSpy = vi.spyOn(logger, "warn");
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const discovered = await discoverServerSkills({
        serverName: "oversized",
        client,
        exposeSkills: true,
      });
      expect(discovered).toEqual({ supported: true, rejectedCount: 1, skills: [] });
      expect(
        warnSpy.mock.calls.some(
          ([message]) =>
            typeof message === "string" && message.includes("Skill exceeds maximum byte size"),
        ),
      ).toBe(true);
      const ping = await client.callTool({ name: "ping", arguments: {} });
      expect(ping.content).toEqual([{ type: "text", text: "pong:oversized-main" }]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("preserves cached skills when startup skills/list fails transiently", async () => {
    const ws = createWorkspace();
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { ctrl: skillsServer("controlled", { lifecycle: "eager" }) },
    });

    const firstHost = await mountAdapter({ cwd: ws.project, trusted: true });
    await firstHost.start();
    await firstHost.discover();
    expect(loadMetadataCache(true)?.servers.ctrl?.skills?.map((s) => s.name)).toEqual(["v1-skill"]);
    await firstHost.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });

    process.env.PI_MCP_TEST_FAIL_SKILLS_LIST = "1";
    try {
      const secondHost = await mountAdapter({ cwd: ws.project, trusted: true });
      await secondHost.start();
      await secondHost.discover();
      expect(secondHost.statuses.at(-1)?.connectedCount).toBe(1);
      expect(loadMetadataCache(true)?.servers.ctrl?.skills?.map((s) => s.name)).toEqual([
        "v1-skill",
      ]);
    } finally {
      delete process.env.PI_MCP_TEST_FAIL_SKILLS_LIST;
    }
  });

  it("sets pendingReload and notifies once late state arrives after startup grace timeout", async () => {
    const ws = createWorkspace();
    const { HostSkillsTracker, getActiveSkillPaths } = await import("../mcp-skills-store.ts");
    const { discoverServerSkills } = await import("../mcp-skills.ts");
    const { createTestState } = await import("./test-state.ts");

    const tracker = new HostSkillsTracker();
    const hostCtx = await createTestExtensionContext();
    const pendingInit = Promise.withResolvers<never>();
    const initial = await tracker.discover({
      readHostState: () => ({
        initPromise: pendingInit.promise,
        startPromise: null,
        state: null,
      }),
      ctx: { ...hostCtx.context, cwd: ws.project, isProjectTrusted: () => true },
    });
    expect(initial).toBeUndefined();

    const definition = skillsServer("valid", { lifecycle: "eager" });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    const lateState = createTestState({
      config: { mcpServers: { late: definition } },
      projectTrusted: true,
      cwd: ws.project,
      ui: { ...hostCtx.context.ui, notify },
    });
    const connection = await lateState.manager.connect("late", definition);
    const skillResult = await discoverServerSkills({
      serverName: "late",
      client: connection.client,
      exposeSkills: true,
    });
    expect(skillResult.skills.length).toBeGreaterThan(0);
    connection.skills = skillResult.skills.map((bundle) => bundle.metadata);
    connection.verifiedSkillBundles = skillResult.skills;

    try {
      tracker.handleStateUpdate(lateState);
      expect(tracker.consumePendingReload()).toBe(true);
      expect(notify).toHaveBeenCalledWith(
        "MCP verified skills updated — run /reload to refresh Pi skills.",
        "info",
      );
      expect(
        getActiveSkillPaths(lateState)
          .map((dirPath) => dirPath.split("/").at(-1) ?? "")
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["alpha-skill", "beta-skill"]);
    } finally {
      await lateState.manager.closeAll();
      await hostCtx.dispose();
    }
  });

  it("publishes committed resources and templates before a newer failing refresh preempts in-flight skills discovery", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { SkillsExtension, skillEntry } = await import("@modelcontextprotocol/server/ext/skills");
    const ConnectionRuntime = await import("../connection-runtime.ts");
    const { ConnectionCallbacks } = await import("../connection-callbacks.ts");
    const { ConnectionLifecycle } = await import("../connection-lifecycle.ts");

    const v1Main = "---\nname: v1-skill\ndescription: Version 1 skill.\n---\nBody.\n";
    const v1Skill = await skillEntry("v1-skill", { "SKILL.md": v1Main });
    const skillFiles = new Map<string, { text: string; mimeType: string }>([
      [v1Skill.uri, { text: v1Main, mimeType: "text/markdown" }],
    ]);
    const skillsStarted = Promise.withResolvers<boolean>();
    const skillsGate = Promise.withResolvers<boolean>();
    const failedTemplateAttempt = Promise.withResolvers<boolean>();
    let resources = [{ name: "r1", uri: "docs://v1" }];
    let templates = [{ name: "t1", uriTemplate: "docs://v1/{id}" }];
    let failTemplates = false;

    const server = new McpServer({ name: "skills-list-changed-race", version: "1.0.0" });
    new SkillsExtension({
      source: {
        list: async () => {
          skillsStarted.resolve(true);
          await skillsGate.promise;
          return { skills: [v1Skill] };
        },
        get: async (uri) => (uri === v1Skill.uri ? v1Skill : undefined),
        read: async (uri) => skillFiles.get(uri),
      },
    }).attach(server);
    server.server.registerCapabilities({ tools: {}, resources: { listChanged: true } });
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    server.server.setRequestHandler("resources/list", () => ({ resources }));
    server.server.setRequestHandler("resources/templates/list", () => {
      if (failTemplates) {
        failedTemplateAttempt.resolve(true);
        throw new Error("simulated templates failure");
      }
      return { resourceTemplates: templates };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const published: Array<{
      readonly serverName: string;
      readonly reason: string;
      readonly resources: readonly string[];
      readonly templates: readonly string[];
      readonly skills: readonly string[];
    }> = [];
    const invalidatePrior = vi.fn<() => void>();
    const callbackRef: { current?: InstanceType<typeof ConnectionCallbacks> } = {};
    const lifecycle = new ConnectionLifecycle(
      async (_name, def) => {
        const currentCallbacks = requireValue(callbackRef.current);
        const client = currentCallbacks.createClient("ctrl", def, ConnectionRuntime);
        await client.connect(clientTransport);
        return {
          client,
          transport: clientTransport,
          definition: def,
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          lastUsedAt: Date.now(),
          status: "connected",
        };
      },
      () => Promise.resolve(),
      {
        publish: (conn) => callbackRef.current?.publish(conn),
        activateSubscription: (name, conn) => callbackRef.current?.activateSubscription(name, conn),
        close: (name) => callbackRef.current?.clearServer(name),
        closeAll: () => callbackRef.current?.clear(),
        invalidatePrior,
      },
    );
    const callbacks = new ConnectionCallbacks(lifecycle);
    callbackRef.current = callbacks;
    await server.connect(serverTransport);

    try {
      const connection = await lifecycle.connect("ctrl", {
        url: "https://skills-refresh.invalid/mcp",
        auth: false,
      });
      callbacks.metadataListChangedListener = (serverName, reason) => {
        published.push({
          serverName,
          reason,
          resources: connection.resources.map((entry) => entry.uri),
          templates: (connection.resourceTemplates ?? []).map((entry) => entry.uriTemplate),
          skills: (connection.skills ?? []).map((entry) => entry.name),
        });
      };

      await server.server.sendResourceListChanged();
      await skillsStarted.promise;

      expect(published).toEqual([
        {
          serverName: "ctrl",
          reason: "resources-list-changed",
          resources: ["docs://v1"],
          templates: ["docs://v1/{id}"],
          skills: [],
        },
      ]);

      failTemplates = true;
      resources = [{ name: "r2", uri: "docs://v2" }];
      templates = [{ name: "t2", uriTemplate: "docs://v2/{id}" }];
      await server.server.sendResourceListChanged();
      await failedTemplateAttempt.promise;
      await delay(25);

      skillsGate.resolve(true);
      await delay(25);

      expect(published).toHaveLength(1);
      expect(connection.skills).toBeUndefined();
      expect(connection.resources.map((entry) => entry.uri)).toEqual(["docs://v1"]);
      expect((connection.resourceTemplates ?? []).map((entry) => entry.uriTemplate)).toEqual([
        "docs://v1/{id}",
      ]);
    } finally {
      skillsGate.resolve(true);
      await Promise.allSettled([lifecycle.closeAll(), server.close()]);
    }
  });

  it("skips the startup skills grace wait when resolved config disables skills or has only lazy servers", async () => {
    const ws = createWorkspace();
    const { HostSkillsTracker } = await import("../mcp-skills-store.ts");
    const hostCtx = await createTestExtensionContext();

    try {
      const pendingInit = Promise.withResolvers<never>();
      const tracker = new HostSkillsTracker();

      const globalStartMs = Date.now();
      const globalDisabled = await tracker.discover({
        readHostState: () => ({
          initPromise: pendingInit.promise,
          startPromise: null,
          state: null,
          config: {
            settings: { exposeSkills: false },
            mcpServers: { slow: { command: process.execPath, args: [], lifecycle: "eager" } },
          },
        }),
        ctx: { ...hostCtx.context, cwd: ws.project, isProjectTrusted: () => true },
      });
      expect(globalDisabled).toBeUndefined();
      expect(Date.now() - globalStartMs).toBeLessThan(500);

      tracker.reset();
      const perServerStartMs = Date.now();
      const perServerDisabled = await tracker.discover({
        readHostState: () => ({
          initPromise: pendingInit.promise,
          startPromise: null,
          state: null,
          config: {
            mcpServers: {
              slow: {
                command: process.execPath,
                args: [],
                lifecycle: "eager",
                exposeSkills: false,
              },
            },
          },
        }),
        ctx: { ...hostCtx.context, cwd: ws.project, isProjectTrusted: () => true },
      });
      expect(perServerDisabled).toBeUndefined();
      expect(Date.now() - perServerStartMs).toBeLessThan(500);

      tracker.reset();
      const lazyOnlyStartMs = Date.now();
      const lazyOnly = await tracker.discover({
        readHostState: () => ({
          initPromise: pendingInit.promise,
          startPromise: null,
          state: null,
          config: {
            mcpServers: {
              slow: { command: process.execPath, args: [], lifecycle: "lazy", exposeSkills: true },
            },
          },
        }),
        ctx: { ...hostCtx.context, cwd: ws.project, isProjectTrusted: () => true },
      });
      expect(lazyOnly).toBeUndefined();
      expect(Date.now() - lazyOnlyStartMs).toBeLessThan(500);

      tracker.reset();
      const lazyKeepAliveStartMs = Date.now();
      const lazyKeepAliveOnly = await tracker.discover({
        readHostState: () => ({
          initPromise: pendingInit.promise,
          startPromise: null,
          state: null,
          config: {
            mcpServers: {
              slow: {
                command: process.execPath,
                args: [],
                lifecycle: "lazy-keep-alive",
                exposeSkills: true,
              },
            },
          },
        }),
        ctx: { ...hostCtx.context, cwd: ws.project, isProjectTrusted: () => true },
      });
      expect(lazyKeepAliveOnly).toBeUndefined();
      expect(Date.now() - lazyKeepAliveStartMs).toBeLessThan(500);
    } finally {
      await hostCtx.dispose();
    }
  });

  it("announces live skills enabled in place via reconcile and preserves updated exposeSkills for list_changed", async () => {
    const ws = createWorkspace();
    const projectB = join(ws.root, "project-b");
    mkdirSync(projectB, { recursive: true });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: {
        ctrl: skillsServer("controlled", {
          lifecycle: "eager",
          cwd: ws.project,
          exposeSkills: false,
        }),
      },
    });
    writeJson(join(projectB, ".mcp.json"), {
      mcpServers: {
        ctrl: skillsServer("controlled", {
          lifecycle: "eager",
          cwd: ws.project,
          exposeSkills: true,
        }),
      },
    });

    const host = await mountAdapter({ cwd: ws.project, trusted: true });
    await host.start();
    const initial = await host.discover();
    expect(initial.skillPaths).toEqual([]);
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);

    const statsSchema = z.object({ started: z.number(), completed: z.number() });
    const readStats = async () => {
      const res = await host.callMcp({
        action: "call",
        server: "ctrl",
        tool: "get_refresh_stats",
        args: {},
      });
      const text = res.content[0]?.type === "text" ? res.content[0].text : "{}";
      return statsSchema.parse(JSON.parse(text));
    };
    expect((await readStats()).started).toBe(0);

    host.setCwd(projectB);
    await host.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "enable skills in place" },
      { cwd: projectB },
    );

    expect(listSkillDirNames(ws.agentDir)).toEqual(["v1-skill"]);
    expect((await readStats()).started).toBe(1);
    expect(host.notifications).toContainEqual({
      level: "info",
      message: "MCP verified skills updated — run /reload to refresh Pi skills.",
    });

    await host.callMcp({
      action: "call",
      server: "ctrl",
      tool: "set_refresh_mode",
      args: { skillName: "v2-skill" },
    });
    await host.callMcp({ action: "call", server: "ctrl", tool: "emit_list_changed", args: {} });
    await expect.poll(() => listSkillDirNames(ws.agentDir)).toEqual(["v2-skill"]);
  });

  it("memoizes untrusted-project skill provenance across repeated metadata syncs", async () => {
    const ws = createWorkspace();
    const globalConfigPath = join(ws.agentDir, "fitch-mcp-adapter", "mcp.json");
    const globalDef = skillsServer("valid", { lifecycle: "eager" });
    writeJson(globalConfigPath, { mcpServers: { globalSkills: globalDef } });
    writeJson(join(ws.project, ".mcp.json"), { mcpServers: {} });

    const { discoverServerSkills } = await import("../mcp-skills.ts");
    const { syncConnectedServerSkills } = await import("../mcp-skills-store.ts");
    const { createTestState } = await import("./test-state.ts");
    const hostCtx = await createTestExtensionContext();
    const state = createTestState({
      config: { mcpServers: { globalSkills: globalDef } },
      projectTrusted: false,
      cwd: ws.project,
      ui: hostCtx.context.ui,
    });

    try {
      const connection = await state.manager.connect("globalSkills", globalDef);
      const discovered = await discoverServerSkills({
        serverName: "globalSkills",
        client: connection.client,
        exposeSkills: true,
      });
      connection.skills = discovered.skills.map((bundle) => bundle.metadata);
      connection.verifiedSkillBundles = discovered.skills;

      syncConnectedServerSkills(state, "globalSkills", connection);
      expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill"]);

      // Remove global server from disk; repeated sync hits memoized provenance without disk reads.
      writeJson(globalConfigPath, { mcpServers: {} });
      syncConnectedServerSkills(state, "globalSkills", connection);
      expect(listSkillDirNames(ws.agentDir)).toEqual(["alpha-skill", "beta-skill"]);

      // Replacing state.config invalidates the memo and picks up the disk removal.
      state.config = { mcpServers: { globalSkills: globalDef } };
      syncConnectedServerSkills(state, "globalSkills", connection);
      expect(listSkillDirNames(ws.agentDir)).toEqual([]);
    } finally {
      await state.manager.closeAll();
      await hostCtx.dispose();
    }
  });

  it("keeps newly materialized project skills after untrusted startup when reconcile moves to a trusted project", async () => {
    const ws = createWorkspace();
    const projectB = join(ws.root, "trusted-project-b");
    mkdirSync(projectB, { recursive: true });
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: {
        demo: skillsServer("controlled", {
          lifecycle: "eager",
          cwd: ws.project,
          exposeSkills: false,
        }),
      },
    });
    writeJson(join(projectB, ".mcp.json"), {
      mcpServers: {
        demo: skillsServer("controlled", {
          lifecycle: "eager",
          cwd: ws.project,
          exposeSkills: true,
        }),
      },
    });

    const host = await mountAdapter({ cwd: ws.project, trusted: false });
    await host.start();
    expect((await host.discover()).skillPaths).toEqual([]);
    expect(listSkillDirNames(ws.agentDir)).toEqual([]);

    host.setTrusted(true);
    host.setCwd(projectB);
    await host.fixture.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "switch to trusted project" },
      { cwd: projectB },
    );

    expect(listSkillDirNames(ws.agentDir)).toEqual(["v1-skill"]);
    expect(host.notifications).toContainEqual({
      level: "info",
      message: "MCP verified skills updated — run /reload to refresh Pi skills.",
    });
  });

  it("treats skills/list MethodNotFound as unsupported and logs failures via debug without warning", async () => {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { SkillsExtension } = await import("@modelcontextprotocol/server/ext/skills");
    const { discoverServerSkills } = await import("../mcp-skills.ts");
    const { logger } = await import("../logger.ts");

    const warnSpy = vi.spyOn(logger, "warn");
    const debugSpy = vi.spyOn(logger, "debug");

    const unsupportedServer = new McpServer({ name: "atlas-like", version: "1.0.0" });
    unsupportedServer.server.registerCapabilities({
      extensions: { "io.modelcontextprotocol/skills": {} },
    });
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const clientA = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([
      unsupportedServer.connect(serverTransportA),
      clientA.connect(clientTransportA),
    ]);
    try {
      const result = await discoverServerSkills({
        serverName: "atlas",
        client: clientA,
        exposeSkills: true,
      });
      expect(result).toEqual({ supported: false, skills: [], rejectedCount: 0 });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("MCP: skills/list unsupported for atlas:"),
      );
    } finally {
      await Promise.all([clientA.close(), unsupportedServer.close()]);
    }

    debugSpy.mockClear();
    const failingServer = new McpServer({ name: "broken-skills", version: "1.0.0" });
    new SkillsExtension({
      source: {
        list: async () => {
          throw new Error("skills backend unavailable");
        },
        get: async () => {
          return;
        },
        read: async () => {
          return;
        },
      },
    }).attach(failingServer);
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    const clientB = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([failingServer.connect(serverTransportB), clientB.connect(clientTransportB)]);
    try {
      const result = await discoverServerSkills({
        serverName: "broken",
        client: clientB,
        exposeSkills: true,
      });
      expect(result).toEqual({ supported: true, failed: true, skills: [], rejectedCount: 1 });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("MCP: skills/list failed for broken:"),
      );
    } finally {
      await Promise.all([clientB.close(), failingServer.close()]);
    }
  });

  it("suppresses raw console warnings from host runtime while a TUI session is active", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "pi-mcp-tui-logger-"));
    const { logger } = await import("../logger.ts");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      return;
    });
    const host = await mountAdapter({ cwd: workdir, config: { mcpServers: {} } });
    try {
      await host.start();
      logger.warn("MCP: skills/list failed for atlas: Method not found");
      expect(warnSpy).not.toHaveBeenCalled();

      await host.fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
      logger.warn("MCP: post-shutdown warning");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
