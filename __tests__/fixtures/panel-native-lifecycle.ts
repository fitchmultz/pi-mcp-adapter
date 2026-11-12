import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { openMcpAuthPanel, openMcpPanel, openMcpSetup } from "../../commands.ts";
import { computeServerHash, getMetadataCachePath } from "../../metadata-cache.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
import type { ServerEntry } from "../../types.ts";
import { createTestState } from "../test-state.ts";

const failure = new Error("native panel factory failed");
class FailingManager extends McpServerManager {
  fail = false;
  override getConnection(name: string): ServerConnection | undefined {
    if (this.fail) {
      throw failure;
    }
    return super.getConnection(name);
  }
}

const directory = await mkdtemp(join(tmpdir(), "pi-mcp-native-panel-"));
process.env.PI_CODING_AGENT_DIR = directory;
let api: ExtensionAPI | undefined;
const runtime = await createAgentSessionRuntime(
  async (options) => {
    const services = await createAgentSessionServices({
      ...options,
      settingsManager: SettingsManager.inMemory({ quietStartup: true }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (extension) => {
            api = extension;
          },
        ],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      noTools: "all",
    });
    return { ...created, services, diagnostics: services.diagnostics };
  },
  { cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) },
);
const mode = new InteractiveMode(runtime, { tuiMode: "regular" });
const manager = new FailingManager();
const definition: ServerEntry = { url: "https://example.test/mcp", auth: "oauth" };
const state = createTestState({
  manager,
  metadataCacheEnabled: true,
  config: { mcpServers: { demo: definition } },
});
const events: string[] = [];

try {
  await mode.init();
  assert(api !== undefined);
  const extension = api;
  const native = runtime.session.extensionRunner.createContext();
  assert.equal(native.mode, "tui");
  assert.equal(native.hasUI, true);
  const nativeCustom = native.ui.custom.bind(native.ui);
  let tui: TUI | undefined;
  let panel: Awaited<ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>> | undefined;
  let shown: PromiseWithResolvers<void> = Promise.withResolvers();
  let disposed = 0;
  function custom<T>(
    factory: Parameters<typeof native.ui.custom<T>>[0],
    options?: Parameters<typeof native.ui.custom<T>>[1],
  ): Promise<T> {
    return nativeCustom<T>(
      async (hostTui, theme, keys, done) => {
        tui = hostTui;
        panel = await factory(hostTui, theme, keys, done);
        const dispose = panel.dispose?.bind(panel);
        panel.dispose = () => {
          disposed++;
          events.push("disposed");
          dispose?.();
        };
        return panel;
      },
      {
        ...options,
        onHandle: (handle) => {
          options?.onHandle?.(handle);
          shown.resolve();
        },
      },
    );
  }
  const notify: typeof native.ui.notify = (message, type) => {
    events.push(`${String(type)}: ${message}`);
    native.ui.notify(message, type);
  };
  const ctx = { ...native, ui: { ...native.ui, custom, notify } };
  const panels = [
    () => openMcpPanel({ state, pi: extension, ctx }),
    () => openMcpSetup({ state, pi: extension, ctx }),
    () => openMcpAuthPanel(state, ctx),
  ];
  // These are real native custom promises and overlays, not the lightweight panel-host fixture.
  for (const open of panels) {
    shown = Promise.withResolvers();
    const opening = open();
    await shown.promise;
    assert(tui !== undefined);
    assert(tui.hasOverlay());
    assert(panel?.handleInput !== undefined);
    panel.handleInput("\x03");
    assert.deepEqual(await opening, { configChanged: false });
    assert.equal(tui.hasOverlay(), false);
  }
  assert.equal(disposed, 3);

  // Saving persists the pin and finishes live refresh, with its visible notice, before close.
  const projectConfig = join(directory, ".mcp.json");
  const cachePath = getMetadataCachePath();
  await mkdir(dirname(cachePath), { recursive: true });
  const cachedServer = {
    configHash: computeServerHash(definition),
    cachedAt: Date.now(),
    tools: [{ name: "echo", description: "Echo input" }],
    resources: [],
  };
  await writeFile(cachePath, JSON.stringify({ version: 2, servers: { demo: cachedServer } }));
  for (const refreshFails of [false, true]) {
    await writeFile(projectConfig, JSON.stringify({ mcpServers: { demo: definition } }));
    events.length = 0;
    const refreshStarted = Promise.withResolvers<null>();
    const releaseRefresh = Promise.withResolvers<null>();
    shown = Promise.withResolvers();
    const saving = openMcpPanel({
      state,
      pi: extension,
      ctx,
      onDirectToolsConfigChanged: async () => {
        events.push("refresh");
        refreshStarted.resolve(null);
        await releaseRefresh.promise;
        if (refreshFails) {
          throw new Error("held refresh failed");
        }
      },
    });
    await shown.promise;
    assert(tui !== undefined);
    assert(tui.hasOverlay());
    assert(panel?.handleInput !== undefined);
    panel.handleInput(" ");
    panel.handleInput("\x13");
    await refreshStarted.promise;
    // Key repeats and cancellation cannot overtake a save already awaiting live refresh.
    panel.handleInput("\x13");
    panel.handleInput("\x03");
    panel.handleInput("\x1b");
    assert(tui.hasOverlay());
    assert.deepEqual(JSON.parse(await readFile(projectConfig, "utf8")), {
      mcpServers: { demo: { ...definition, directTools: true } },
    });
    releaseRefresh.resolve(null);
    assert.deepEqual(await saving, { configChanged: refreshFails });
    assert.equal(tui.hasOverlay(), false);
    assert.deepEqual(events, [
      "refresh",
      refreshFails
        ? "error: Direct tools updated, but live refresh failed: held refresh failed"
        : "info: Direct tools updated for this session.",
      "disposed",
    ]);
  }
  assert.equal(disposed, 5);

  // A real held config sidecar must not be reported as a persisted update.
  const configLock = new DatabaseSync(`${projectConfig}.lock.sqlite`);
  try {
    configLock.exec("BEGIN EXCLUSIVE");
    await writeFile(projectConfig, JSON.stringify({ mcpServers: { demo: definition } }));
    const before = await readFile(projectConfig, "utf8");
    events.length = 0;
    shown = Promise.withResolvers();
    const blockedSave = openMcpPanel({
      state,
      pi: extension,
      ctx,
      onDirectToolsConfigChanged: () => {
        events.push("refresh");
      },
    });
    await shown.promise;
    assert(panel?.handleInput !== undefined);
    panel.handleInput(" ");
    panel.handleInput("\x13");
    assert.deepEqual(await blockedSave, { configChanged: false });
    assert.equal(await readFile(projectConfig, "utf8"), before);
    assert.equal(tui?.hasOverlay(), false);
    assert.equal(events.length, 2);
    assert.match(events[0] ?? "", /^error: Failed to save direct tools: Storage lock is busy:/);
    assert.equal(events[1], "disposed");

    // An earlier successful file remains saved if a later file is blocked.
    const globalConfig = join(directory, "fitch-mcp-adapter", "mcp.json");
    await writeFile(globalConfig, JSON.stringify({ mcpServers: { first: definition } }));
    state.config = { mcpServers: { first: definition, demo: definition } };
    await writeFile(
      cachePath,
      JSON.stringify({ version: 2, servers: { first: cachedServer, demo: cachedServer } }),
    );
    events.length = 0;
    shown = Promise.withResolvers();
    const partialSave = openMcpPanel({
      state,
      pi: extension,
      ctx,
      onDirectToolsConfigChanged: () => {
        events.push("refresh");
      },
    });
    await shown.promise;
    panel.handleInput(" ");
    panel.handleInput("\x1b[B");
    panel.handleInput(" ");
    panel.handleInput("\x13");
    assert.deepEqual(await partialSave, { configChanged: true });
    assert.deepEqual(JSON.parse(await readFile(globalConfig, "utf8")), {
      mcpServers: { first: { ...definition, directTools: true } },
    });
    assert.equal(await readFile(projectConfig, "utf8"), before);
    assert.equal(events.length, 2);
    assert.match(
      events[0] ?? "",
      /^error: Some direct tools were saved, but remaining changes failed: Storage lock is busy:/,
    );
    assert.equal(events[1], "disposed");
    assert.equal(tui.hasOverlay(), false);
  } finally {
    configLock.close();
    state.config = { mcpServers: { demo: definition } };
  }
  assert.equal(disposed, 7);

  manager.fail = true;
  await assert.rejects(openMcpPanel({ state, pi: extension, ctx }), (error) => error === failure);
  assert.equal(tui.hasOverlay(), false);
  assert.equal(disposed, 7);
  console.log("NATIVE_PANEL_LIFECYCLE_PASS");
} finally {
  mode.stop();
  await state.owner.stop();
  await manager.closeAll();
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}
