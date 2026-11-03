import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { initializeMcp } from "../../init.ts";
import { createMcpRuntimeOwner } from "../../runtime-owner.ts";
import type { McpExtensionState } from "../../state.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { createTestState } from "../test-state.ts";
import {
  createCallbackHttpFixture,
  type CallbackFixtureOptions,
  type CallbackHttpFixture,
} from "../runtime/fixtures/callback-http.ts";

/** Native host, isolated config storage, and owned MCP connection cleanup. */
export async function createActivationFixture(): Promise<ReturnType<typeof bindActivationFixture>> {
  return bindActivationFixture(await createTestExtensionContext());
}

function bindActivationFixture(native: Awaited<ReturnType<typeof createTestExtensionContext>>) {
  const directory = native.context.cwd;
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  initTheme();
  const foreground = vi.spyOn(Theme.prototype, "fg").mockImplementation((_color, text) => text);
  const ui = {
    ...native.context.ui,
    notify: vi.fn<typeof native.context.ui.notify>(),
    setStatus: vi.fn<typeof native.context.ui.setStatus>(),
  };
  native.runner.setUIContext(ui, "tui");
  const owners: McpExtensionState["owner"][] = [];
  const states: McpExtensionState[] = [];
  const wires: CallbackHttpFixture[] = [];
  return {
    ...native,
    directory,
    ui,
    foreground,
    state(overrides: Partial<McpExtensionState> = {}): McpExtensionState {
      const state = createTestState(overrides);
      states.push(state);
      return state;
    },
    async initialize(
      options: Parameters<typeof initializeMcp>[3] = {},
    ): Promise<McpExtensionState> {
      const owner = createMcpRuntimeOwner();
      owners.push(owner);
      return await initializeMcp(native.api, native.context, owner, options);
    },
    async wire(options: CallbackFixtureOptions = {}): Promise<CallbackHttpFixture> {
      const wire = await createCallbackHttpFixture(directory, options);
      wires.push(wire);
      return wire;
    },
    async dispose(): Promise<void> {
      for (const wire of wires) {
        wire.release();
      }
      for (const owner of owners) {
        await owner.stop("test cleanup");
      }
      for (const state of states) {
        await state.owner.stop("test cleanup");
        await state.manager.closeAll();
      }
      for (const wire of wires) {
        await wire.close();
      }
      await native.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    },
  };
}
