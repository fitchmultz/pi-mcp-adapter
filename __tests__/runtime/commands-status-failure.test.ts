import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { reconnectServer, showStatus, showTools } from "../../commands.ts";
import { clearFailure } from "../../init.ts";
import { createPanelHost } from "../fixtures/panel-host.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";
import { createTestState } from "../test-state.ts";

let host: Awaited<ReturnType<typeof createPanelHost>>;
const states: ReturnType<typeof createTestState>[] = [];
beforeAll(() => initTheme());
beforeEach(async () => {
  host = await createPanelHost();
});
afterEach(async () => {
  for (const state of states.splice(0)) {
    for (const name of state.failureTracker.keys()) {
      clearFailure(state, name);
    }
    await state.owner.stop();
  }
  await host.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MCP status failure reasons", () => {
  it("includes the bounded failure reason as a safe single-line status", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = createTestState({
      config: { mcpServers: { demo: { command: "node" } } },
      failureTracker: new Map([["demo", Date.now() - 7000]]),
      failureMessages: new Map([
        ["demo", "stderr says\n\x1b]8;;https://secret.invalid/status\x07server failed\x1b]8;;\x07"],
      ]),
    });
    states.push(state);
    const { ui } = host.context;
    await showStatus(state, host.context);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("demo: failed 7s ago — stderr says server failed"),
      "info",
    );
    expect(requireValue(vi.mocked(ui.notify).mock.calls[0])[0]).not.toContain(
      "https://secret.invalid/status",
    );
  });

  it("reports real tool and resource counts while leaving cold catalogs undiscovered", async () => {
    const state = createTestState({
      config: { mcpServers: { docs: { command: "node" }, cold: { command: "node" } } },
      toolMetadata: new Map([
        [
          "docs",
          [
            { name: "docs_search", originalName: "search", description: "Search" },
            {
              name: "docs_read_guide",
              originalName: "read_guide",
              description: "Guide",
              resourceUri: "docs://guide",
            },
          ],
        ],
      ]),
    });
    states.push(state);
    const { ui } = host.context;
    await showStatus(state, host.context);
    const status = requireValue(vi.mocked(ui.notify).mock.calls[0])[0];
    expect(status).toContain("docs: cached (1 tool, 1 resource, cached)");
    expect(status).toContain("cold: not connected (undiscovered)");
    expect(status).not.toContain("0 tools");
    await showTools(state, host.context);
    const tools = requireValue(vi.mocked(ui.notify).mock.calls[1])[0];
    expect(tools).toContain("docs_search");
    expect(tools).toContain("Total: 1 tool");
    expect(tools).not.toContain("docs_read_guide");
    state.toolMetadata.clear();
    await showTools(state, host.context);
    expect(requireValue(vi.mocked(ui.notify).mock.calls[2])[0]).toBe(
      'No MCP tools discovered. Connect a server with mcp({ action: "connect" }).',
    );
  });

  it("sanitizes captured diagnostics in reconnect notifications", async () => {
    const state = createTestState({
      config: { settings: {}, mcpServers: { demo: { command: "node" } } },
    });
    states.push(state);
    vi.spyOn(state.manager, "connect").mockRejectedValueOnce(
      new Error("stderr \x1b]52;c;clipboard-secret\x07server failed"),
    );
    await reconnectServer(state, host.context, "demo");

    expect(host.context.ui.notify).toHaveBeenCalledWith(
      "MCP: Failed to reconnect to demo: stderr server failed",
      "error",
    );
    expect(requireValue(vi.mocked(host.context.ui.notify).mock.calls[0])[0]).not.toContain(
      "clipboard-secret",
    );
  });
});
