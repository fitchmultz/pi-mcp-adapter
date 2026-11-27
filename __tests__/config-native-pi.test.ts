import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
} from "@earendil-works/pi-coding-agent";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for native Pi MCP session condition");
    }
    await delay(20);
  }
}

describe("native Pi project .pi/mcp.json support", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const tempRoots: string[] = [];

  function createWorkspace(): { root: string; home: string; agentDir: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-native-pi-"));
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
    vi.resetModules();
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

  it("translates stdio exposure, timeout, home expansion, and relative cwd against the project root", async () => {
    const { project } = createWorkspace();
    const nativePath = join(project, ".pi", "mcp.json");
    writeJson(nativePath, {
      autoEnableCodemode: false,
      mcpServers: {
        "koinonia-codex": {
          command: "uv",
          args: ["run", "koinonia-mcp", "~/data"],
          cwd: ".",
          exposure: "direct",
          timeout: 45,
          description: "Project knowledge base",
        },
        tildeBin: {
          type: "stdio",
          command: "~/bin/server",
          cwd: "~/work",
          exposure: "codemode-deferred",
        },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig(undefined, project);

    expect(config.mcpServers["koinonia-codex"]).toEqual({
      command: "uv",
      args: ["run", "koinonia-mcp", join(homedir(), "data")],
      cwd: resolve(project),
      description: "Project knowledge base",
      directTools: true,
      requestTimeoutMs: 45_000,
    });
    expect(config.mcpServers.tildeBin).toEqual({
      command: join(homedir(), "bin", "server"),
      cwd: join(homedir(), "work"),
      directTools: false,
    });
  });

  it("honors enabled: false, exposure: hidden, and toolExposure safely", async () => {
    const { project } = createWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        off: { command: "uv", enabled: false, exposure: "direct" },
        allHidden: { command: "uv", enabled: true, exposure: "hidden" },
        allowlist: {
          command: "uv",
          exposure: "hidden",
          toolExposure: {
            search: "direct",
            "read_*": "deferred",
            secret: "hidden",
          },
        },
        wildcardWithExactHidden: {
          command: "uv",
          exposure: "hidden",
          toolExposure: {
            "*": "codemode",
            delete_all: "hidden",
          },
        },
        orderedHiddenBeforeWildcard: {
          command: "uv",
          exposure: "hidden",
          toolExposure: {
            "delete_*": "hidden",
            "*": "codemode",
          },
        },
        conflictingExactVisible: {
          command: "uv",
          exposure: "direct",
          toolExposure: {
            "read_*": "hidden",
            read_public: "direct",
          },
        },
        conflictingPatternOrder: {
          command: "uv",
          exposure: "codemode",
          toolExposure: {
            "read_*": "codemode",
            "*": "hidden",
          },
        },
        selectiveDirect: {
          command: "uv",
          exposure: "deferred",
          toolExposure: {
            ping: "direct",
            "admin_*": "hidden",
          },
        },
        directMinusHidden: {
          command: "uv",
          exposure: "direct",
          toolExposure: {
            danger: "hidden",
            slow: "deferred",
          },
        },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const { isServerToolAllowed, isToolAllowed } = await import("../tool-names.ts");
    const config = loadMcpConfig(undefined, project);

    expect(config.mcpServers.off).toMatchObject({ command: "uv", disabled: true });
    expect(config.mcpServers.allHidden).toMatchObject({ command: "uv", disabled: true });
    expect(config.mcpServers.allowlist).toEqual({
      command: "uv",
      includeTools: ["search", "read_*"],
      excludeTools: ["secret"],
      directTools: ["search"],
    });
    expect(config.mcpServers.wildcardWithExactHidden).toEqual({
      command: "uv",
      includeTools: ["*"],
      excludeTools: ["delete_all"],
      directTools: false,
    });
    const wildcardDef = config.mcpServers.wildcardWithExactHidden;
    expect(
      isToolAllowed(
        "delete_all",
        "srv",
        "server",
        wildcardDef?.includeTools,
        wildcardDef?.excludeTools,
      ),
    ).toBe(false);
    expect(
      isToolAllowed(
        "search",
        "srv",
        "server",
        wildcardDef?.includeTools,
        wildcardDef?.excludeTools,
      ),
    ).toBe(true);
    expect(config.mcpServers.orderedHiddenBeforeWildcard).toEqual({
      command: "uv",
      includeTools: ["*"],
      excludeTools: ["delete_*"],
      directTools: false,
    });
    expect(config.mcpServers.conflictingExactVisible).toEqual({
      command: "uv",
      directTools: true,
      toolExposure: {
        "read_*": "hidden",
        read_public: "direct",
      },
    });
    const exactVisibleDef = config.mcpServers.conflictingExactVisible;
    if (!exactVisibleDef) {
      throw new Error("Expected conflictingExactVisible to translate cleanly");
    }
    expect(isServerToolAllowed("read_public", "srv", "server", exactVisibleDef)).toBe(true);
    expect(isServerToolAllowed("read_secret", "srv", "server", exactVisibleDef)).toBe(false);
    expect(isServerToolAllowed("write_doc", "srv", "server", exactVisibleDef)).toBe(true);
    expect(config.mcpServers.conflictingPatternOrder).toEqual({
      command: "uv",
      includeTools: ["read_*"],
      directTools: false,
    });
    expect(config.mcpServers.selectiveDirect).toEqual({
      command: "uv",
      excludeTools: ["admin_*"],
      directTools: ["ping"],
    });
    expect(config.mcpServers.directMinusHidden).toEqual({
      command: "uv",
      directTools: true,
      excludeTools: ["danger"],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("per-tool deferred overrides (slow)"),
    );
  });

  it("translates HTTP OAuth fields and isolates invalid entries from valid siblings", async () => {
    const { project } = createWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        remotePort: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Env": "${TOKEN}" },
          oauth: {
            clientId: "cid",
            clientSecret: "${SECRET}",
            callbackPort: 8765,
            clientRegistration: "dcr",
            scope: "read write",
          },
        },
        remoteCombinedCallback: {
          url: "http://localhost/oauth/callback",
          oauth: {
            callbackUrl: "http://localhost/oauth/callback",
            callbackPort: 9123,
            clientName: "Custom Client",
            authServerMetadataUrl:
              "https://auth.example.com/.well-known/oauth-authorization-server",
          },
        },
        remotePortlessCallback: {
          url: "https://mcp.example.com/portless",
          oauth: {
            callbackUrl: "http://localhost/oauth/callback",
          },
        },
        remoteCustomHeaderOnly: {
          url: "https://mcp.example.com/tenant",
          headers: { "X-Tenant": "acme" },
        },
        remoteStaticBearer: {
          url: "https://mcp.example.com/static",
          headers: { authorization: "Bearer ${STATIC_TOKEN}" },
        },
        badProviderAuth: {
          url: "https://mcp.example.com/provider",
          auth: { provider: "github" },
        },
        badSse: {
          type: "sse",
          url: "https://mcp.example.com/sse",
        },
        badEnabled: {
          command: "uv",
          enabled: "false",
        },
        badCimd: {
          url: "https://mcp.example.com/cimd",
          oauth: { clientId: "cid", clientRegistration: "cimd" },
        },
        badHeaderValue: {
          url: "https://mcp.example.com/bad-header",
          headers: { Authorization: 42 },
        },
        badEnvValue: {
          command: "uv",
          env: { API_KEY: 42 },
        },
        legacyAdapterDisabled: {
          command: "uv",
          disabled: true,
          directTools: true,
        },
        legacyAdapterSocket: {
          socket: "/tmp/legacy.sock",
        },
        legacyAdapterApproveTools: {
          command: "uv",
          approveTools: true,
        },
        legacyAdapterGrantType: {
          url: "https://mcp.example.com/client-creds",
          oauth: {
            grantType: "client_credentials",
            authorizationParams: { audience: "https://api.example.com" },
          },
        },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const { supportsOAuth } = await import("../mcp-oauth-runtime.ts");
    const config = loadMcpConfig(undefined, project);

    expect(Object.keys(config.mcpServers).sort()).toEqual([
      "remoteCombinedCallback",
      "remoteCustomHeaderOnly",
      "remotePort",
      "remotePortlessCallback",
      "remoteStaticBearer",
    ]);
    expect(config.mcpServers.remotePort).toEqual({
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
      headers: { "X-Env": "${TOKEN}" },
      oauth: {
        clientId: "cid",
        clientSecret: "${SECRET}",
        scope: "read write",
        redirectUri: "http://127.0.0.1:8765/callback",
        clientMetadataUrl: false,
      },
    });
    expect(config.mcpServers.remoteCombinedCallback).toEqual({
      url: "http://localhost/oauth/callback",
      auth: "oauth",
      oauth: {
        clientName: "Custom Client",
        redirectUri: "http://localhost:9123/oauth/callback",
      },
    });
    expect(config.mcpServers.remotePortlessCallback).toEqual({
      url: "https://mcp.example.com/portless",
      auth: "oauth",
      oauth: {},
    });
    expect(config.mcpServers.remoteCustomHeaderOnly).toEqual({
      url: "https://mcp.example.com/tenant",
      auth: "oauth",
      headers: { "X-Tenant": "acme" },
    });
    expect(config.mcpServers.remoteStaticBearer).toEqual({
      url: "https://mcp.example.com/static",
      headers: { authorization: "Bearer ${STATIC_TOKEN}" },
    });
    expect(supportsOAuth(config.mcpServers.remotePort ?? {})).toBe(true);
    expect(supportsOAuth(config.mcpServers.remoteCustomHeaderOnly ?? {})).toBe(true);
    expect(supportsOAuth(config.mcpServers.remoteStaticBearer ?? {})).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badProviderAuth"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badSse"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badEnabled"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badCimd"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badHeaderValue"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badEnvValue"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacyAdapterDisabled"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacyAdapterSocket"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacyAdapterApproveTools"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacyAdapterGrantType"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("oauth.authServerMetadataUrl"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("oauth.callbackUrl without a port"));
  });

  it("skips a legacy adapter-format .pi/mcp.json with top-level adapter keys instead of misinterpreting it", async () => {
    const { project } = createWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      settings: { idleTimeout: 5 },
      mcpServers: {
        legacy: { command: "uv" },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig(undefined, project);
    expect(config.mcpServers.legacy).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("top-level adapter-only fields"));
  });

  it("replaces lower-precedence definitions wholesale while merging override-only entries", async () => {
    const { agentDir, project } = createWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });
    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        globalStdio: { command: "global-cmd", directTools: true },
        globalDisabled: { command: "disabled-cmd", disabled: true },
        replacedStdio: {
          command: "node",
          args: ["old-server.js", "--legacy"],
          cwd: "/var/old-cwd",
          env: { SECRET: "keep-out" },
          disabled: true,
        },
        switched: {
          command: "old-stdio",
          args: ["--old"],
          cwd: "/var/old-cwd",
          env: { SECRET: "keep-out" },
        },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        globalStdio: { enabled: false },
        globalDisabled: { enabled: true, exposure: "direct" },
        replacedStdio: { command: "python3", exposure: "direct" },
        switched: { url: "https://switched.example/mcp" },
        orphanOverride: { enabled: false },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig(undefined, project);

    expect(config.mcpServers.globalStdio).toMatchObject({
      command: "global-cmd",
      disabled: true,
    });
    expect(config.mcpServers.globalDisabled).toMatchObject({
      command: "disabled-cmd",
      disabled: false,
      directTools: true,
    });
    expect(config.mcpServers.replacedStdio).toEqual({
      command: "python3",
      directTools: true,
    });
    expect(config.mcpServers.switched).toEqual({
      url: "https://switched.example/mcp",
    });
    expect(config.mcpServers.orphanOverride).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orphanOverride"));
  });

  it("enforces precedence (.mcp.json < .pi/mcp.json < .pi/fitch-mcp-adapter/mcp.json), trust gating, and read-only writes", async () => {
    const { project } = createWorkspace();
    const nativePath = join(project, ".pi", "mcp.json");
    const adapterProjectPath = join(project, ".pi", "fitch-mcp-adapter", "mcp.json");

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        layered: { command: "shared-project" },
        fromSharedOnly: { command: "shared-only" },
      },
    });
    const nativeContents = `${JSON.stringify(
      {
        mcpServers: {
          layered: { command: "native-pi", exposure: "direct" },
          nativeOnly: { command: "native-only" },
          nativeDisabled: { command: "native-disabled", enabled: false },
        },
      },
      null,
      2,
    )}\n`;
    mkdirSync(dirname(nativePath), { recursive: true });
    writeFileSync(nativePath, nativeContents, "utf-8");

    writeJson(adapterProjectPath, {
      mcpServers: {
        layered: { command: "adapter-project" },
      },
    });

    const {
      loadMcpConfig,
      getMcpDiscoverySummary,
      getServerProvenance,
      writeDirectToolsConfig,
      writeProjectServerDisabledOverride,
    } = await import("../config.ts");

    const trusted = loadMcpConfig(undefined, project, { includeProject: true });
    expect(trusted.mcpServers.layered).toMatchObject({ command: "adapter-project" });
    expect(trusted.mcpServers.fromSharedOnly).toMatchObject({ command: "shared-only" });
    expect(trusted.mcpServers.nativeOnly).toMatchObject({ command: "native-only" });
    expect(trusted.mcpServers.nativeDisabled).toMatchObject({
      command: "native-disabled",
      disabled: true,
    });

    const untrusted = loadMcpConfig(undefined, project, { includeProject: false });
    expect(untrusted.mcpServers).toEqual({});

    const summary = getMcpDiscoverySummary(undefined, project);
    expect(summary.sources).toContainEqual(
      expect.objectContaining({
        id: "native-pi-project",
        path: nativePath,
        exists: true,
        scope: "project",
        kind: "shared",
        serverCount: 3,
      }),
    );

    const provenance = getServerProvenance(undefined, project);
    expect(provenance.get("nativeOnly")).toEqual({
      path: adapterProjectPath,
      kind: "project",
    });

    writeDirectToolsConfig(new Map([["nativeOnly", true]]), provenance);
    writeProjectServerDisabledOverride(undefined, project, "nativeOnly", true);
    writeProjectServerDisabledOverride(undefined, project, "nativeDisabled", false);

    // Native .pi/mcp.json must never be mutated by adapter writes.
    expect(readFileSync(nativePath, "utf-8")).toBe(nativeContents);

    const afterWrites = loadMcpConfig(undefined, project);
    expect(afterWrites.mcpServers.nativeOnly).toMatchObject({
      command: "native-only",
      directTools: true,
      disabled: true,
    });
    expect(afterWrites.mcpServers.nativeDisabled).toMatchObject({
      command: "native-disabled",
      disabled: false,
    });
  });

  function readStartCount(logPath: string): number {
    if (!existsSync(logPath)) {
      return 0;
    }
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
  }

  it("bootstraps direct tools once from a trusted project .pi/mcp.json when replacing Pi's CLI builtin:mcp", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const startLog = join(root, "native-direct-starts.log");
    const disabledLog = join(root, "native-disabled-starts.log");
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        "native-direct": {
          command: process.execPath,
          args: [fixtureServer],
          cwd: ".",
          env: { MCP_START_LOG_FILE: startLog },
          exposure: "direct",
        },
        "native-disabled": {
          command: process.execPath,
          args: [fixtureServer],
          env: { MCP_START_LOG_FILE: disabledLog },
          enabled: false,
          exposure: "direct",
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
      await waitFor(() => session.getActiveToolNames().includes("mcp__native_direct__noop"));
      expect(session.getActiveToolNames()).toContain("mcp__native_direct__noop");
      expect(session.getAllTools().some((tool) => tool.name === "mcp")).toBe(true);
      expect(session.getActiveToolNames()).not.toContain("mcp__native_disabled__noop");
      expect(readStartCount(startLog)).toBe(1);
      expect(readStartCount(disabledLog)).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("skips project .pi/mcp.json when an inline SDK createMcpExtension() coexists so servers never start twice", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const startLog = join(root, "builtin-owner-starts.log");
    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        "control-global": {
          command: process.execPath,
          args: [fixtureServer],
          directTools: true,
        },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        "native-direct": {
          command: process.execPath,
          args: [fixtureServer],
          cwd: ".",
          env: { MCP_START_LOG_FILE: startLog },
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
      await waitFor(
        () =>
          session.getActiveToolNames().includes("mcp__control_global__noop") &&
          session.getActiveToolNames().includes("mcp__native_direct__noop"),
        8000,
      );
      expect(session.getActiveToolNames()).not.toContain("native_direct_noop");
      expect(session.getAllTools().map((tool) => tool.name)).not.toContain("native_direct_noop");
      expect(readStartCount(startLog)).toBe(1);
    } finally {
      session.dispose();
    }
  }, 15_000);

  it("skips project .pi/mcp.json in an untrusted real Pi session", async () => {
    initTheme();
    const { root, agentDir, project } = createWorkspace();
    const fixtureServer = resolve("__tests__/fixtures/tools-only-server.mjs");
    const startLog = join(root, "untrusted-starts.log");
    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        "control-global": {
          command: process.execPath,
          args: [fixtureServer],
          directTools: true,
        },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        "native-direct": {
          command: process.execPath,
          args: [fixtureServer],
          cwd: ".",
          env: { MCP_START_LOG_FILE: startLog },
          exposure: "direct",
        },
      },
    });

    const settingsManager = SettingsManager.inMemory();
    settingsManager.setProjectTrusted(false);
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
      await waitFor(() => session.getActiveToolNames().includes("mcp__control_global__noop"), 8000);
      expect(session.getActiveToolNames()).not.toContain("mcp__native_direct__noop");
      expect(readStartCount(startLog)).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it("loads global <agentDir>/mcp.json read-only, lets project .pi/mcp.json override global entries, and preserves CIMD + wildcard-hidden toolExposure", async () => {
    const { agentDir, home, project } = createWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });
    const globalNativePath = join(agentDir, "mcp.json");
    const globalNativePayload = {
      mcpServers: {
        globalDocs: {
          url: "https://docs.example.com/mcp",
          description: "Global company documentation",
          oauth: { clientRegistration: "cimd" },
          toolExposure: {
            "*": "hidden",
            search_docs: "direct",
            get_doc: "deferred",
          },
        },
        globalOnly: {
          command: "global-bin",
          description: "Global CLI server",
        },
        invalidOverride: {
          enabled: false,
        },
        badCimdSecret: {
          url: "https://bad-cimd.example.com/mcp",
          oauth: { clientRegistration: "cimd", clientSecret: "top-secret" },
        },
        badCimdPath: {
          url: "https://bad-cimd-path.example.com/mcp",
          oauth: {
            clientRegistration: "cimd",
            callbackUrl: "http://127.0.0.1:8765/custom-path",
          },
        },
      },
    };
    writeJson(globalNativePath, globalNativePayload);
    const beforeGlobalBytes = readFileSync(globalNativePath, "utf-8");

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        globalOnly: { command: "shared-lower-priority" },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        globalOnly: { enabled: false },
      },
    });

    const { loadMcpConfig, getMcpDiscoverySummary, getServerProvenance, writeDirectToolsConfig } =
      await import("../config.ts");
    const config = loadMcpConfig(undefined, project);

    expect(config.mcpServers.globalDocs).toEqual({
      url: "https://docs.example.com/mcp",
      description: "Global company documentation",
      auth: "oauth",
      oauth: { clientRegistration: "cimd" },
      includeTools: ["search_docs", "get_doc"],
      directTools: ["search_docs"],
    });
    expect(config.mcpServers.globalOnly).toEqual({
      command: "global-bin",
      description: "Global CLI server",
      disabled: true,
    });
    expect(config.mcpServers.invalidOverride).toBeUndefined();
    expect(config.mcpServers.badCimdSecret).toBeUndefined();
    expect(config.mcpServers.badCimdPath).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalidOverride"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badCimdSecret"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("badCimdPath"));

    // Coexistence option skips BOTH global and project native Pi configs.
    const skipped = loadMcpConfig(undefined, project, { includeNativePi: false });
    expect(skipped.mcpServers.globalDocs).toBeUndefined();
    expect(skipped.mcpServers.globalOnly).toEqual({ command: "shared-lower-priority" });

    const summary = getMcpDiscoverySummary(undefined, project);
    expect(summary.sources).toContainEqual(
      expect.objectContaining({
        id: "native-pi-global",
        path: globalNativePath,
        scope: "global",
        kind: "shared",
        serverCount: 2,
      }),
    );

    const provenance = getServerProvenance(undefined, project);
    writeDirectToolsConfig(new Map([["globalDocs", true]]), provenance);
    expect(readFileSync(globalNativePath, "utf-8")).toBe(beforeGlobalBytes);
    expect(
      JSON.parse(readFileSync(join(agentDir, "fitch-mcp-adapter", "mcp.json"), "utf-8")),
    ).toEqual({
      mcpServers: { globalDocs: { directTools: true } },
    });
  });

  it("matches Pi exposure/toolExposure precedence when project .pi/mcp.json overrides global <agentDir>/mcp.json", async () => {
    const { agentDir, project } = createWorkspace();
    writeJson(join(agentDir, "mcp.json"), {
      mcpServers: {
        docs: {
          url: "https://docs.example.com/mcp",
          exposure: "hidden",
          toolExposure: { search: "direct" },
        },
        allHidden: {
          url: "https://hidden.example.com/mcp",
          exposure: "hidden",
        },
        disabledGlobal: {
          url: "https://disabled.example.com/mcp",
          enabled: false,
        },
        scoped: {
          url: "https://scoped.example.com/mcp",
          exposure: "hidden",
          toolExposure: { search: "direct" },
        },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        docs: { exposure: "direct" },
        allHidden: { exposure: "direct" },
        disabledGlobal: { exposure: "direct" },
        scoped: { toolExposure: { ping: "direct" } },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig(undefined, project);

    expect(config.mcpServers.docs).toEqual({
      url: "https://docs.example.com/mcp",
      directTools: true,
    });
    expect(config.mcpServers.allHidden).toEqual({
      url: "https://hidden.example.com/mcp",
      directTools: true,
    });
    expect(config.mcpServers.disabledGlobal).toEqual({
      url: "https://disabled.example.com/mcp",
      directTools: true,
      disabled: true,
    });
    expect(config.mcpServers.scoped).toEqual({
      url: "https://scoped.example.com/mcp",
      includeTools: ["ping"],
      directTools: ["ping"],
    });
  });

  it("preserves global hidden exposure across adapter pins when project .pi/mcp.json overrides toolExposure", async () => {
    const { agentDir, project } = createWorkspace();
    writeJson(join(agentDir, "mcp.json"), {
      mcpServers: {
        scoped: {
          url: "https://scoped.example.com/mcp",
          exposure: "hidden",
          toolExposure: { search: "direct" },
        },
        pinnedDisabled: {
          url: "https://disabled.example.com/mcp",
          exposure: "hidden",
          toolExposure: { search: "direct" },
        },
        reEnabled: {
          url: "https://reenabled.example.com/mcp",
          enabled: false,
        },
      },
    });
    writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
      mcpServers: {
        scoped: { directTools: true },
        pinnedDisabled: { disabled: true },
        reEnabled: { directTools: true },
      },
    });
    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        scoped: { toolExposure: { ping: "direct" } },
        pinnedDisabled: { toolExposure: { ping: "direct" } },
        reEnabled: { enabled: true },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const { isServerToolAllowed } = await import("../tool-names.ts");
    const config = loadMcpConfig(undefined, project);

    const scoped = config.mcpServers.scoped;
    expect(scoped).toEqual({
      url: "https://scoped.example.com/mcp",
      includeTools: ["ping"],
      directTools: ["ping"],
    });
    if (!scoped) {
      throw new Error("Expected scoped server entry");
    }
    expect(isServerToolAllowed("ping", "scoped", "server", scoped)).toBe(true);
    expect(isServerToolAllowed("other", "scoped", "server", scoped)).toBe(false);
    expect(config.mcpServers.pinnedDisabled).toEqual({
      url: "https://disabled.example.com/mcp",
      includeTools: ["ping"],
      directTools: ["ping"],
      disabled: true,
    });
    expect(config.mcpServers.reEnabled).toEqual({
      url: "https://reenabled.example.com/mcp",
      directTools: true,
      disabled: false,
    });
  });
});
