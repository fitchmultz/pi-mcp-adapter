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
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  readonly totalSkills?: number;
  readonly servers: ReadonlyArray<{ readonly name: string; readonly skillCount?: number }>;
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
  mode: "valid" | "mixed" | "no-skills" | "updated",
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

  async function mountAdapter(input: { cwd: string; config?: McpConfig; trusted?: boolean }) {
    let currentCwd = input.cwd;
    let projectTrusted = input.trusted ?? true;
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
    vi.spyOn(fixture.runner, "createContext").mockImplementation((): ExtensionContext => ({
      ...baseCreate(),
      cwd: currentCwd,
      isProjectTrusted: () => projectTrusted,
      ui: { ...fixture.runner.getUIContext(), notify: uiNotify },
    }));

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

  it("waits on startup init during resources_discover, notifies on lazy discovery, and reloads cached skills", async () => {
    const ws = createWorkspace();
    writeJson(join(ws.project, ".mcp.json"), {
      mcpServers: { lazySkills: skillsServer("valid") },
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

    // Next fresh session: start startup concurrently with resources_discover; cached skill server bootstraps!
    const secondHost = await mountAdapter({ cwd: ws.project, trusted: true });
    const startPromise = secondHost.start();
    const discovered = await secondHost.discover();
    await startPromise;
    expect(discovered.skillPaths).toHaveLength(2);
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
});
