import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { McpHostRuntime } from "../host-runtime.ts";
import {
  loadMcpConfig,
  getProjectConfigPath,
  getProjectNativePiConfigPath,
  getProjectPiConfigPath,
  writeDirectToolsConfig,
} from "../config.ts";
import type { UiServerHandle } from "../ui-server-contracts.ts";
import { createLifecycleHost, requireValue } from "./fixtures/extension-lifecycle.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readStartCount(logPath: string): number {
  if (!existsSync(logPath)) {
    return 0;
  }
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for host parity condition");
    }
    await delay(20);
  }
}

describe("Pi 1.6.1+ host parity (MCP-212)", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const tempRoots: string[] = [];

  function createWorkspace(): { root: string; home: string; agentDir: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-host-parity-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_DIRECT_TOOLS;
    return { root, home, agentDir, project };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
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
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consumes pi.getMcpServers() and reconciles mcp_servers_change add/update/remove without disrupting config servers", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const keepStartLog = join(root, "file-keep-starts.log");
    const fileOverrideLog = join(root, "file-override-starts.log");
    const extOverrideLog = join(root, "ext-override-starts.log");
    const extInitLog = join(root, "ext-init-starts.log");
    const extLateLog = join(root, "ext-late-starts.log");

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        "file-keep": {
          command: process.execPath,
          args: [fixtureServer],
          cwd: root,
          env: { MCP_START_LOG_FILE: keepStartLog },
          lifecycle: "keep-alive",
        },
        overridden: {
          command: process.execPath,
          args: [fixtureServer],
          cwd: root,
          env: { MCP_START_LOG_FILE: fileOverrideLog },
          lifecycle: "eager",
          directTools: true,
        },
      },
    });

    let peerApi: ExtensionAPI | undefined;
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      extensionFactories: [
        { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
        {
          name: "peer-mcp-registrar",
          factory: (pi) => {
            peerApi = pi;
            pi.registerMcpServer("ext-init", {
              command: process.execPath,
              args: [fixtureServer],
              cwd: root,
              env: { MCP_START_LOG_FILE: extInitLog },
              exposure: "direct",
            });
            pi.registerMcpServer("overridden", {
              command: process.execPath,
              args: [fixtureServer],
              cwd: root,
              env: { MCP_START_LOG_FILE: extOverrideLog },
              exposure: "direct",
            });
          },
        },
      ],
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project, join(root, "sessions")),
      settingsManager,
      modelRuntime,
    });
    const runnerErrors: ExtensionError[] = [];
    session.extensionRunner.onError((error) => {
      runnerErrors.push(error);
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: session.extensionRunner.getUIContext(),
      });
      await waitFor(
        () =>
          session.getActiveToolNames().includes("ext_init_noop") &&
          session.getActiveToolNames().includes("overridden_noop") &&
          readStartCount(keepStartLog) === 1,
      );
      expect(runnerErrors).toEqual([]);
      expect(readStartCount(extInitLog)).toBe(1);
      // File config takes precedence over extension registration with the same name.
      expect(readStartCount(fileOverrideLog)).toBe(1);
      expect(readStartCount(extOverrideLog)).toBe(0);

      const api = requireValue(peerApi);
      // Add a new extension server mid-session.
      api.registerMcpServer("ext-late", {
        command: process.execPath,
        args: [fixtureServer],
        cwd: root,
        env: { MCP_START_LOG_FILE: extLateLog },
        exposure: "deferred",
      });
      await waitFor(() => session.getAllTools().some((tool) => tool.name === "ext_late_noop"));
      expect(session.getAllTools().find((tool) => tool.name === "ext_late_noop")?.exposure).toBe(
        "deferred",
      );
      expect(readStartCount(extLateLog)).toBe(1);
      expect(readStartCount(keepStartLog)).toBe(1);

      // Update the registered extension server to direct exposure.
      api.registerMcpServer("ext-late", {
        command: process.execPath,
        args: [fixtureServer],
        cwd: root,
        env: { MCP_START_LOG_FILE: extLateLog },
        exposure: "direct",
      });
      await waitFor(() => session.getActiveToolNames().includes("ext_late_noop"));
      expect(readStartCount(keepStartLog)).toBe(1);

      // Unregister the extension server and verify its tool is withdrawn while config servers stay up.
      api.unregisterMcpServer("ext-late");
      await waitFor(
        () =>
          session.getAllTools().find((tool) => tool.name === "ext_late_noop")?.exposure ===
          "hidden",
      );
      expect(readStartCount(keepStartLog)).toBe(1);
      expect(runnerErrors).toEqual([]);
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("skips global <agentDir>/mcp.json when inline createMcpExtension() coexists so global servers never start twice", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const globalStartLog = join(root, "global-native-starts.log");
    writeJson(join(agentDir, "mcp.json"), {
      mcpServers: {
        "global-native": {
          command: process.execPath,
          args: [fixtureServer],
          env: { MCP_START_LOG_FILE: globalStartLog },
          exposure: "direct",
        },
      },
    });

    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      extensionFactories: [createMcpExtension()],
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project, join(root, "sessions")),
      settingsManager,
      modelRuntime,
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: session.extensionRunner.getUIContext(),
      });
      await waitFor(() => session.getActiveToolNames().includes("mcp__global_native__noop"));
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain("global_native_noop");
      expect(readStartCount(globalStartLog)).toBe(1);
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("registers a fallback pi.registerToolRenderer for unregistered MCP tools while deferring to next()", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        linear: { url: "https://mcp.linear.example.test/mcp" },
      },
    });
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      extensionFactories: [
        { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
      ],
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project, join(root, "sessions")),
      settingsManager,
      modelRuntime,
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: session.extensionRunner.getUIContext(),
      });

      const noBase = (): undefined => {
        return;
      };
      const nativeFallback = session.extensionRunner.resolveToolRenderers(
        "mcp__github__list_issues",
        noBase,
      );
      expect(nativeFallback?.renderCall).toBeTypeOf("function");
      expect(nativeFallback?.renderResult).toBeTypeOf("function");

      const prefixFallback = session.extensionRunner.resolveToolRenderers(
        "linear_list_issues",
        noBase,
      );
      expect(prefixFallback?.renderCall).toBeTypeOf("function");
      expect(prefixFallback?.renderResult).toBeTypeOf("function");

      const baseRenderer = { renderCall: () => new Text("custom-base", 0, 0) };
      expect(
        session.extensionRunner.resolveToolRenderers(
          "mcp__github__list_issues",
          () => baseRenderer,
        ),
      ).toBe(baseRenderer);

      expect(session.extensionRunner.resolveToolRenderers("bash", noBase)).toBeUndefined();
      expect(
        session.extensionRunner.resolveToolRenderers("custom_non_mcp_tool", noBase),
      ).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it("defers tool-surface mutations during working_session_save and reports active blockers truthfully", async () => {
    const { project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const fixture = await createTestExtensionContext("builtin");
    const registerToolSpy = vi.spyOn(fixture.api, "registerTool");
    const registerCommandSpy = vi.spyOn(fixture.api, "registerCommand");
    const setActiveToolsSpy = vi.spyOn(fixture.api, "setActiveTools");
    const runtime = new McpHostRuntime(fixture.api, {
      config: {
        mcpServers: {
          demo: {
            command: process.execPath,
            args: [fixtureServer],
            lifecycle: "eager",
            directTools: true,
          },
        },
      },
    });
    runtime.install();
    try {
      const saveCallbacks = fixture.resourceLoader
        .getExtensions()
        .extensions.flatMap((ext) => ext.handlers.get("working_session_save") ?? []);
      expect(saveCallbacks).toHaveLength(1);
      const onSave = requireValue(saveCallbacks[0]);

      const startCallbacks = fixture.resourceLoader
        .getExtensions()
        .extensions.flatMap((ext) => ext.handlers.get("session_start") ?? []);
      await requireValue(startCallbacks[0])(
        { type: "session_start", reason: "startup" },
        { ...fixture.context, cwd: project },
      );
      await waitFor(
        () => runtime.state !== null && fixture.api.getActiveTools().includes("demo_noop"),
      );
      const state = requireValue(runtime.state);
      const connection = requireValue(state.manager.getConnection("demo"));

      // Idle save reports no blockers.
      const idleHold = new AbortController();
      expect(
        await onSave(
          { type: "working_session_save", boundary: "settled", signal: idleHold.signal },
          fixture.context,
        ),
      ).toEqual({ blockers: [] });

      // Tool-surface and prompt-command updates while saving are deferred until the hold signal aborts.
      registerToolSpy.mockClear();
      registerCommandSpy.mockClear();
      setActiveToolsSpy.mockClear();
      state.toolMetadata.set("demo", [
        { name: "demo_noop", originalName: "noop", description: "Noop" },
        { name: "demo_added", originalName: "added", description: "Added during save" },
      ]);
      state.promptMetadata.set("demo", [
        {
          serverName: "demo",
          originalName: "added",
          commandName: "mcp__demo__added",
          description: "Added prompt during save",
          arguments: [],
        },
      ]);
      state.promptMetadataLive.add("demo");
      await state.onToolMetadataUpdated?.("demo", "tools-list-changed");
      expect(registerToolSpy).not.toHaveBeenCalled();
      expect(registerCommandSpy).not.toHaveBeenCalled();
      expect(setActiveToolsSpy).not.toHaveBeenCalled();

      idleHold.abort();
      expect(registerToolSpy).toHaveBeenCalled();
      const addedPromptCall = registerCommandSpy.mock.calls.find(
        ([commandName]) => commandName === "mcp__demo__added",
      );
      expect(addedPromptCall?.[1].description).toContain("Added prompt during save");
      expect(fixture.api.getActiveTools()).toContain("demo_added");

      // Active in-flight requests and scripts are reported as blockers.
      state.manager.incrementInFlight(connection);
      state.activeScripts = 1;
      const busyHold = new AbortController();
      try {
        const readiness = await onSave(
          { type: "working_session_save", boundary: "turn", signal: busyHold.signal },
          fixture.context,
        );
        expect(readiness).toEqual({
          blockers: ["MCP requests to demo are in progress", "MCP script execution is in progress"],
        });
      } finally {
        state.manager.decrementInFlight(connection);
        state.activeScripts = 0;
        busyHold.abort();
      }
    } finally {
      await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
      await fixture.dispose();
    }
  });

  it("walks up to the nearest project/git root, prefers explicit cwd files, and stops at .git and home boundaries", () => {
    const { root, home } = createWorkspace();
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "app", "src");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeJson(join(repo, ".mcp.json"), {
      mcpServers: {
        repoShared: { command: "repo-shared", cwd: "./scripts" },
      },
    });
    writeJson(join(repo, ".pi", "mcp.json"), {
      mcpServers: {
        repoNative: { command: "repo-native", cwd: "./scripts" },
      },
    });
    writeJson(join(repo, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        repoPi: { command: "repo-pi", cwd: "./tools" },
      },
    });

    expect(getProjectConfigPath(nested)).toBe(resolve(repo, ".mcp.json"));
    expect(getProjectNativePiConfigPath(nested)).toBe(resolve(repo, ".pi", "mcp.json"));
    expect(getProjectPiConfigPath(nested)).toBe(
      resolve(repo, ".pi", "fitch-mcp-adapter", "mcp.json"),
    );

    const fromNested = loadMcpConfig(undefined, nested);
    expect(fromNested.mcpServers.repoShared).toEqual({
      command: "repo-shared",
      cwd: resolve(repo, "scripts"),
    });
    expect(fromNested.mcpServers.repoNative).toEqual({
      command: "repo-native",
      cwd: resolve(repo, "scripts"),
    });
    expect(fromNested.mcpServers.repoPi).toEqual({
      command: "repo-pi",
      cwd: resolve(repo, "tools"),
    });

    // Explicit file in cwd wins over ancestor file.
    writeJson(join(nested, ".mcp.json"), {
      mcpServers: {
        cwdOverride: { command: "cwd-only" },
      },
    });
    const fromOverride = loadMcpConfig(undefined, nested);
    expect(fromOverride.mcpServers.cwdOverride).toEqual({ command: "cwd-only" });
    expect(fromOverride.mcpServers.repoShared).toBeUndefined();

    // Nested git repository stops the walk and does not inherit the outer repo's .mcp.json.
    const nestedRepo = join(repo, "subrepo");
    mkdirSync(join(nestedRepo, ".git"), { recursive: true });
    expect(loadMcpConfig(undefined, nestedRepo).mcpServers.repoShared).toBeUndefined();

    // Home directory boundary prevents picking up ~/.mcp.json from ~/scratch/sub.
    writeJson(join(home, ".mcp.json"), {
      mcpServers: { homeLeak: { command: "should-not-load" } },
    });
    const homeChild = join(home, "scratch", "sub");
    mkdirSync(homeChild, { recursive: true });
    expect(loadMcpConfig(undefined, homeChild).mcpServers.homeLeak).toBeUndefined();

    // Outside any Git repository, ancestor configs (e.g., /tmp/.mcp.json) are never read or targeted.
    const nonGitOuter = join(root, "non-git-outer");
    const nonGitNested = join(nonGitOuter, "project", "sub");
    mkdirSync(nonGitNested, { recursive: true });
    writeJson(join(nonGitOuter, ".mcp.json"), {
      mcpServers: { outerLeak: { command: "should-not-load" } },
    });
    expect(loadMcpConfig(undefined, nonGitNested).mcpServers.outerLeak).toBeUndefined();
    expect(getProjectConfigPath(nonGitNested)).toBe(resolve(nonGitNested, ".mcp.json"));
    expect(getProjectPiConfigPath(nonGitNested)).toBe(
      resolve(nonGitNested, ".pi", "fitch-mcp-adapter", "mcp.json"),
    );
  });

  it("reconciles change_dir non-destructively, syncs slash command cwd, cleans stale prompts, and never mutates shared .mcp.json", async () => {
    const { root, agentDir } = createWorkspace();
    const toolsServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const promptsServer = resolve("__tests__/fixtures/prompts-server.mjs");
    const globalKeepLog = join(root, "global-keep.log");
    const cwdBoundLog = join(root, "cwd-bound.log");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const projectC = join(root, "project-c");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(projectC, { recursive: true });

    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        "global-keep": {
          command: process.execPath,
          args: [toolsServer],
          cwd: root,
          env: { MCP_START_LOG_FILE: globalKeepLog },
          lifecycle: "keep-alive",
        },
        "cwd-bound": {
          command: process.execPath,
          args: [toolsServer],
          env: { MCP_START_LOG_FILE: cwdBoundLog },
          lifecycle: "eager",
        },
      },
    });
    const projectASharedPath = join(projectA, ".mcp.json");
    writeJson(projectASharedPath, {
      mcpServers: {
        "proj-a": {
          command: process.execPath,
          args: [promptsServer],
          lifecycle: "eager",
        },
      },
    });
    const projectASharedBefore = readFileSync(projectASharedPath, "utf-8");

    writeJson(join(projectB, ".mcp.json"), {
      mcpServers: {
        "proj-b": {
          command: process.execPath,
          args: [promptsServer],
          lifecycle: "eager",
        },
      },
    });
    writeJson(join(projectC, ".mcp.json"), {
      mcpServers: {
        "proj-c": {
          url: "https://project-c.example.test/mcp",
        },
      },
    });

    // Even if a caller supplies a direct `.mcp.json` provenance, writeDirectToolsConfig redirects
    // to `.pi/fitch-mcp-adapter/mcp.json` and leaves shared `.mcp.json` untouched.
    writeDirectToolsConfig(
      new Map([["proj-a", true]]),
      new Map([["proj-a", { path: projectASharedPath, kind: "project" }]]),
    );
    expect(readFileSync(projectASharedPath, "utf-8")).toBe(projectASharedBefore);
    expect(
      JSON.parse(readFileSync(join(projectA, ".pi", "fitch-mcp-adapter", "mcp.json"), "utf-8")),
    ).toEqual({ mcpServers: { "proj-a": { directTools: true } } });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    try {
      await host.handlers.get("session_start")({}, { cwd: projectA });
      await waitFor(
        () =>
          runtime.state?.manager.getConnection("global-keep")?.status === "connected" &&
          runtime.state.manager.getConnection("cwd-bound")?.status === "connected" &&
          runtime.state.manager.getConnection("proj-a")?.status === "connected",
      );

      const state = requireValue(runtime.state);
      const initialOwner = requireValue(runtime.owner);
      const globalConnection = requireValue(state.manager.getConnection("global-keep"));
      const closeUi = vi.fn<UiServerHandle["close"]>();
      const noop = () => {
        /* stub UI server method */
      };
      state.uiServer = {
        serverName: "global-keep",
        toolName: "noop",
        sessionToken: "tok",
        port: 0,
        url: "http://127.0.0.1:0/",
        close: closeUi,
        sendToolInput: noop,
        sendToolResult: noop,
        sendResultPatch: noop,
        sendToolCancelled: noop,
        sendHostContext: noop,
        getSessionMessages: () => ({
          prompts: [],
          intents: [],
          notifications: [],
          contexts: [],
        }),
        takeModelContext: () => {
          return;
        },
        getStreamSummary: () => {
          return;
        },
      };
      state.approvedToolCalls.set("global-keep\u0000noop", true);
      state.approvedToolCalls.set("proj-a\u0000noop", true);

      expect(readStartCount(globalKeepLog)).toBe(1);
      expect(readStartCount(cwdBoundLog)).toBe(1);
      expect(host.runner.getCommand("mcp__proj_a__brief")).toBeDefined();

      // Switch working directory to projectB via before_agent_start.
      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      await waitFor(() => state.manager.getConnection("proj-b")?.status === "connected");

      // Global server keeps the exact same connection, approval, owner, and open UI server.
      expect(runtime.owner).toBe(initialOwner);
      expect(initialOwner.isActive()).toBe(true);
      expect(state.manager.getConnection("global-keep")).toBe(globalConnection);
      expect(readStartCount(globalKeepLog)).toBe(1);
      expect(state.approvedToolCalls.get("global-keep\u0000noop")).toBe(true);
      expect(closeUi).not.toHaveBeenCalled();
      expect(state.uiServer).not.toBeNull();

      // Cwd-sensitive stdio server reconnected in projectB; projectA server disconnected & cleaned.
      expect(readStartCount(cwdBoundLog)).toBe(2);
      expect(state.manager.getConnection("proj-a")).toBeUndefined();
      expect(state.approvedToolCalls.has("proj-a\u0000noop")).toBe(false);
      expect(host.runner.getCommand("mcp__proj_b__brief")).toBeDefined();

      // Stale project-a prompt command reports unavailable instead of trying to reconnect proj-a.
      const staleNotices: Array<[string, string | undefined]> = [];
      await host.command("mcp__proj_a__brief").handler("topic=test", {
        cwd: projectB,
        hasUI: true,
        ui: {
          notify: (message, level) => {
            staleNotices.push([message, level]);
          },
        },
      });
      expect(staleNotices).toContainEqual([
        expect.stringContaining("no longer available"),
        "error",
      ]);

      // Running `/mcp status` after moving to projectC syncs cwd immediately before showing status.
      const statusNotices: string[] = [];
      await host.command("mcp").handler("status", {
        cwd: projectC,
        hasUI: true,
        mode: "print",
        ui: {
          notify: (message) => {
            statusNotices.push(message);
          },
        },
      });
      expect(state.config.mcpServers["proj-c"]).toBeDefined();
      expect(state.config.mcpServers["proj-b"]).toBeUndefined();
      expect(statusNotices.join("\n")).toContain("proj-c");
    } finally {
      await host.dispose();
    }
  }, 15_000);

  it("updates sampling and elicitation policy on change_dir and skips mcp_servers_change in programmatic mode", async () => {
    const { root } = createWorkspace();
    const projectAllow = join(root, "allow-policy");
    const projectDeny = join(root, "deny-policy");
    mkdirSync(projectAllow, { recursive: true });
    mkdirSync(projectDeny, { recursive: true });
    writeJson(join(projectAllow, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { sampling: true, elicitation: true },
      mcpServers: {},
    });
    writeJson(join(projectDeny, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { sampling: false, elicitation: false },
      mcpServers: {},
    });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    const programmaticHost = await createLifecycleHost();
    const programmaticRuntime = new McpHostRuntime(programmaticHost.api, {
      config: { mcpServers: {} },
    });
    programmaticRuntime.install();
    try {
      // Programmatic config mode does not subscribe to mcp_servers_change, leaving Pi's warning intact.
      expect(host.runner.hasHandlers("mcp_servers_change")).toBe(true);
      expect(programmaticHost.runner.hasHandlers("mcp_servers_change")).toBe(false);

      await host.handlers.get("session_start")({}, { cwd: projectAllow, hasUI: true, mode: "tui" });
      await waitFor(() => runtime.state !== null);
      const state = requireValue(runtime.state);
      const setSampling = vi.spyOn(state.manager, "setSamplingConfig");
      const setElicitation = vi.spyOn(state.manager, "setElicitationConfig");

      await host.handlers.emitBeforeAgentStart({ cwd: projectDeny, hasUI: true, mode: "tui" });
      expect(setSampling.mock.lastCall).toEqual([undefined]);
      expect(setElicitation.mock.lastCall).toEqual([undefined]);

      await host.handlers.emitBeforeAgentStart({ cwd: projectAllow, hasUI: true, mode: "tui" });
      expect(setSampling).toHaveBeenLastCalledWith(expect.objectContaining({ autoApprove: false }));
      expect(setElicitation).toHaveBeenLastCalledWith(expect.objectContaining({ allowUrl: true }));
    } finally {
      await host.dispose();
      await programmaticHost.dispose();
    }
  });

  it("unfreezes and re-syncs direct tools on change_dir when two projects both set freezeDirectTools", async () => {
    const { root } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const projectA = join(root, "freeze-a");
    const projectB = join(root, "freeze-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeJson(join(projectA, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { freezeDirectTools: true },
      mcpServers: {
        "proj-a": { command: process.execPath, args: [fixtureServer], directTools: true },
      },
    });
    writeJson(join(projectB, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { freezeDirectTools: true },
      mcpServers: {
        "proj-b": { command: process.execPath, args: [fixtureServer], directTools: true },
      },
    });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    try {
      await host.handlers.get("session_start")({}, { cwd: projectA });
      await waitFor(
        () => host.api.getActiveTools().includes("proj_a_noop") && runtime.directToolsFrozen,
      );

      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      await waitFor(() => host.api.getActiveTools().includes("proj_b_noop"));
      expect(host.api.getActiveTools()).not.toContain("proj_a_noop");
      expect(runtime.directToolsFrozen).toBe(true);
    } finally {
      await host.dispose();
    }
  }, 15_000);

  it("rebinds the lazy MCP traceWriter to the new project cwd after change_dir reconcile", async () => {
    const { root } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const projectA = join(root, "trace-a");
    const projectB = join(root, "trace-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeJson(join(projectA, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { trace: { enabled: true } },
      mcpServers: {
        "proj-a": { command: process.execPath, args: [fixtureServer], lifecycle: "eager" },
      },
    });
    writeJson(join(projectB, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      settings: { trace: { enabled: true } },
      mcpServers: {
        "proj-b": { command: process.execPath, args: [fixtureServer], lifecycle: "eager" },
      },
    });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    try {
      await host.handlers.get("session_start")({}, { cwd: projectA });
      await waitFor(() => runtime.state?.manager.getConnection("proj-a")?.status === "connected");
      const tracesA = join(projectA, ".pi", "fitch-mcp-adapter", "traces");
      const tracesB = join(projectB, ".pi", "fitch-mcp-adapter", "traces");
      await waitFor(() => existsSync(tracesA) && readdirSync(tracesA).length > 0);
      expect(existsSync(tracesB)).toBe(false);

      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      await waitFor(() => runtime.state?.manager.getConnection("proj-b")?.status === "connected");
      await waitFor(() => existsSync(tracesB) && readdirSync(tracesB).length > 0);
      const traceBFile = join(tracesB, readdirSync(tracesB)[0] ?? "");
      await waitFor(() => readFileSync(traceBFile, "utf-8").includes('"server":"proj-b"'));
    } finally {
      await host.dispose();
    }
  }, 15_000);

  it("persists /mcp direct-tool pins for extension-registered servers across reconciles", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    let peerApi: ExtensionAPI | undefined;
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      extensionFactories: [
        { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
        {
          name: "peer-mcp-pin",
          factory: (pi) => {
            peerApi = pi;
            pi.registerMcpServer("ext-pin", {
              command: process.execPath,
              args: [fixtureServer],
              cwd: root,
              exposure: "deferred",
            });
          },
        },
      ],
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project, join(root, "sessions")),
      settingsManager,
      modelRuntime,
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: session.extensionRunner.getUIContext(),
      });
      await waitFor(() => session.getAllTools().some((tool) => tool.name === "ext_pin_noop"));
      expect(session.getActiveToolNames()).not.toContain("ext_pin_noop");

      const command = requireValue(session.extensionRunner.getCommand("mcp"));
      const baseContext = session.extensionRunner.createCommandContext();
      const tui = new TuiMainScreen(new ProcessTerminal());
      vi.spyOn(tui, "requestRender").mockImplementation(() => {
        /* Exercise panel callbacks without writing to stdout. */
      });
      const keybindings = new KeybindingsManager();
      await command.handler("", {
        ...baseContext,
        hasUI: true,
        mode: "tui",
        isProjectTrusted: () => true,
        ui: {
          ...baseContext.ui,
          custom: (factory) =>
            new Promise((resolvePanel) => {
              const component = factory(tui, baseContext.ui.theme, keybindings, resolvePanel);
              if ("handleInput" in component && typeof component.handleInput === "function") {
                component.handleInput(" ");
                component.handleInput("\x13");
              }
            }),
        },
      });

      const persistedPath = join(agentDir, "fitch-mcp-adapter", "mcp.json");
      expect(existsSync(persistedPath)).toBe(true);
      expect(JSON.parse(readFileSync(persistedPath, "utf-8"))).toEqual({
        mcpServers: { "ext-pin": { directTools: true } },
      });
      await waitFor(() => session.getActiveToolNames().includes("ext_pin_noop"));

      // Trigger a live mcp_servers_change reconcile and verify the persisted pin survives.
      requireValue(peerApi).registerMcpServer("ext-other", {
        command: process.execPath,
        args: [fixtureServer],
        cwd: root,
        exposure: "deferred",
      });
      await waitFor(() => session.getAllTools().some((tool) => tool.name === "ext_other_noop"));
      expect(session.getActiveToolNames()).toContain("ext_pin_noop");

      // Unregistering the pinned extension server prunes its orphan directTools stub cleanly
      // and never bleeds onto a same-name server in another project.
      requireValue(peerApi).unregisterMcpServer("ext-pin");
      await waitFor(
        () =>
          session.getAllTools().find((tool) => tool.name === "ext_pin_noop")?.exposure === "hidden",
      );
      expect(loadMcpConfig(undefined, project).mcpServers["ext-pin"]).toBeUndefined();

      const otherProject = join(root, "other-project");
      mkdirSync(otherProject, { recursive: true });
      writeJson(join(otherProject, ".mcp.json"), {
        mcpServers: {
          "ext-pin": { command: process.execPath, args: [fixtureServer] },
        },
      });
      const otherConfig = loadMcpConfig(undefined, otherProject);
      expect(otherConfig.mcpServers["ext-pin"]?.directTools).toBeUndefined();

      // Removing a pinned .mcp.json server also drops its orphan .pi/fitch-mcp-adapter/mcp.json pin.
      writeDirectToolsConfig(
        new Map([["ext-pin", true]]),
        new Map([["ext-pin", { path: join(otherProject, ".mcp.json"), kind: "project" }]]),
      );
      expect(loadMcpConfig(undefined, otherProject).mcpServers["ext-pin"]?.directTools).toBe(true);
      writeJson(join(otherProject, ".mcp.json"), { mcpServers: {} });
      expect(loadMcpConfig(undefined, otherProject).mcpServers["ext-pin"]).toBeUndefined();
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("keeps previous cwd/config when manager.close rejects during change_dir so the next turn retries cleanly", async () => {
    const { root } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const projectA = join(root, "retry-a");
    const projectB = join(root, "retry-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeJson(join(projectA, ".mcp.json"), {
      mcpServers: {
        "proj-a": { command: process.execPath, args: [fixtureServer], lifecycle: "eager" },
      },
    });
    writeJson(join(projectB, ".mcp.json"), {
      mcpServers: {
        "proj-b": { command: process.execPath, args: [fixtureServer], lifecycle: "eager" },
      },
    });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    try {
      await host.handlers.get("session_start")({}, { cwd: projectA });
      await waitFor(() => runtime.state?.manager.getConnection("proj-a")?.status === "connected");
      const state = requireValue(runtime.state);

      // Simulate a failing manager.close() on the first change_dir attempt.
      const runnerErrors: ExtensionError[] = [];
      host.runner.onError((error) => {
        runnerErrors.push(error);
      });
      const closeSpy = vi
        .spyOn(state.manager, "close")
        .mockRejectedValueOnce(new Error("cleanup failed"));
      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      expect(runnerErrors.some((entry) => entry.error.includes("cleanup failed"))).toBe(true);

      // State and runtime stay on projectA (no half-applied projectB config).
      expect(state.config.mcpServers["proj-a"]).toBeDefined();
      expect(state.config.mcpServers["proj-b"]).toBeUndefined();
      expect(runtime.config.mcpServers["proj-a"]).toBeDefined();
      expect(runtime.config.mcpServers["proj-b"]).toBeUndefined();

      // The next turn in projectB retries reconcile cleanly and connects proj-b.
      closeSpy.mockRestore();
      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      await waitFor(() => state.manager.getConnection("proj-b")?.status === "connected");
      expect(state.config.mcpServers["proj-b"]).toBeDefined();
      expect(state.config.mcpServers["proj-a"]).toBeUndefined();
      expect(state.manager.getConnection("proj-a")).toBeUndefined();
    } finally {
      await host.dispose();
    }
  }, 15_000);

  it("clears UI tool consent and closes owned UI server before clearing state when a same-name server is replaced", async () => {
    const { root } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const projectA = join(root, "consent-a");
    const projectB = join(root, "consent-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeJson(join(projectA, ".mcp.json"), {
      mcpServers: {
        docs: {
          command: process.execPath,
          args: [fixtureServer],
          cwd: projectA,
          lifecycle: "eager",
        },
      },
    });
    writeJson(join(projectB, ".mcp.json"), {
      mcpServers: {
        docs: {
          command: process.execPath,
          args: [fixtureServer],
          cwd: projectB,
          lifecycle: "eager",
        },
      },
    });

    const host = await createLifecycleHost();
    const runtime = new McpHostRuntime(host.api, {});
    runtime.install();
    try {
      await host.handlers.get("session_start")({}, { cwd: projectA });
      await waitFor(() => runtime.state?.manager.getConnection("docs")?.status === "connected");
      const state = requireValue(runtime.state);

      state.consentManager.registerDecision("docs", true);
      expect(state.consentManager.requiresPrompt("docs")).toBe(false);

      let handleStillActiveDuringClose = false;
      const noop = () => {
        /* stub UI server method */
      };
      const uiHandle: UiServerHandle = {
        serverName: "docs",
        toolName: "noop",
        sessionToken: "tok",
        port: 0,
        url: "http://127.0.0.1:0/",
        close: vi.fn<UiServerHandle["close"]>(() => {
          handleStillActiveDuringClose = state.uiServer === uiHandle;
        }),
        sendToolInput: noop,
        sendToolResult: noop,
        sendResultPatch: noop,
        sendToolCancelled: noop,
        sendHostContext: noop,
        getSessionMessages: () => ({
          prompts: [],
          intents: [],
          notifications: [],
          contexts: [],
        }),
        takeModelContext: () => {
          return;
        },
        getStreamSummary: () => {
          return;
        },
      };
      state.uiServer = uiHandle;
      state.pendingUiModelContext = {
        serverName: "docs",
        toolName: "noop",
        context: { summary: "stale project A context", truncated: false },
      };

      await host.handlers.emitBeforeAgentStart({ cwd: projectB });
      await waitFor(() => state.manager.getConnection("docs")?.status === "connected");

      expect(state.consentManager.requiresPrompt("docs")).toBe(true);
      expect(uiHandle.close).toHaveBeenCalledWith("server_reconfigured");
      expect(handleStillActiveDuringClose).toBe(true);
      expect(state.uiServer).toBeNull();
      expect(state.pendingUiModelContext).toBeUndefined();
    } finally {
      await host.dispose();
    }
  }, 15_000);

  it("honors adapter-format toolExposure direct, deferred, codemode, and hidden values", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const catalogServer = resolve("__tests__/fixtures/search-catalog-server.mjs");
    const phasePath = join(root, "phase-flag");
    const callsPath = join(root, "calls.log");
    writeFileSync(phasePath, "1", "utf-8");

    writeJson(join(project, ".pi", "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        alpha: {
          command: process.execPath,
          args: [catalogServer, phasePath, callsPath],
          toolExposure: {
            probe: "direct",
            advance: "codemode",
            hidden: "hidden",
          },
        },
        beta: {
          command: process.execPath,
          args: [catalogServer, phasePath, callsPath],
          lifecycle: "eager",
          directTools: true,
          toolExposure: {
            probe: "deferred",
            advance: "codemode",
            hidden: "hidden",
          },
        },
      },
    });

    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      extensionFactories: [
        { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
      ],
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project, join(root, "sessions")),
      settingsManager,
      modelRuntime,
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: session.extensionRunner.getUIContext(),
      });
      await waitFor(
        () =>
          session.getActiveToolNames().includes("alpha_probe") &&
          session.getAllTools().some((tool) => tool.name === "beta_probe"),
      );

      // alpha: probe is direct (active), advance is codemode, hidden is excluded.
      expect(session.getActiveToolNames()).toContain("alpha_probe");
      expect(session.getActiveToolNames()).not.toContain("alpha_advance");
      expect(session.getAllTools().find((tool) => tool.name === "alpha_advance")?.exposure).toBe(
        "codemode",
      );
      expect(session.getAllTools().find((tool) => tool.name === "alpha_hidden")).toBeUndefined();

      // beta: toolExposure overrides directTools: true for deferred and codemode tools.
      expect(session.getActiveToolNames()).not.toContain("beta_probe");
      expect(session.getActiveToolNames()).not.toContain("beta_advance");
      expect(session.getAllTools().find((tool) => tool.name === "beta_probe")?.exposure).toBe(
        "deferred",
      );
      expect(session.getAllTools().find((tool) => tool.name === "beta_advance")?.exposure).toBe(
        "codemode",
      );
      expect(session.getAllTools().find((tool) => tool.name === "beta_hidden")).toBeUndefined();
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("wholesale-replaces extension-registered servers when hostConfigDiscovery defines a same-name transport", async () => {
    const { home, agentDir, project } = createWorkspace();
    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      settings: { hostConfigDiscovery: "on" },
      mcpServers: {},
    });
    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        shared: { command: "cursor-cmd", args: ["--from-cursor"] },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        shared: { description: "Project override" },
      },
    });
    vi.resetModules();
    try {
      const { loadMcpConfigWithBase: loadFresh } = await import("../config.ts");
      const { translateRegisteredMcpServers: translateFresh } =
        await import("../config-native-pi.ts");
      const baseConfig = translateFresh(
        [
          {
            name: "shared",
            config: {
              command: "ext-cmd",
              timeout: 45,
              description: "Extension server",
              toolExposure: { "*": "hidden", allowed: "direct" },
            },
            extensionPath: "/ext/peer.ts",
          },
        ],
        project,
      );

      const loaded = loadFresh(undefined, project, { includeProject: true }, baseConfig);
      expect(loaded.mcpServers.shared).toEqual({
        command: "cursor-cmd",
        args: ["--from-cursor"],
        description: "Project override",
      });
    } finally {
      vi.resetModules();
    }
  });
});
