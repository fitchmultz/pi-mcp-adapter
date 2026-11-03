import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";
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
const state = createTestState({
  manager,
  config: { mcpServers: { demo: { url: "https://example.test/mcp", auth: "oauth" } } },
});

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
  const ctx = { ...native, ui: { ...native.ui, custom } };
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
  manager.fail = true;
  await assert.rejects(openMcpPanel({ state, pi: extension, ctx }), (error) => error === failure);
  assert.equal(tui?.hasOverlay(), false);
  assert.equal(disposed, 3);
  console.log("NATIVE_PANEL_LIFECYCLE_PASS");
} finally {
  mode.stop();
  await state.owner.stop();
  await manager.closeAll();
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}
