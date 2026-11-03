import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateStatusBar } from "../init.ts";
import { formatMcpStatus } from "../utils.ts";
import type { McpSettings } from "../types.ts";
import { createActivationFixture } from "./fixtures/strict-activation-boundaries.ts";

let host: Awaited<ReturnType<typeof createActivationFixture>>;
beforeEach(async () => {
  host = await createActivationFixture();
});
afterEach(async () => {
  await host.dispose();
});

function createState(settings: Partial<McpSettings> = {}) {
  return host.state({
    ui: host.ui,
    config: { settings, mcpServers: { demo: { command: "demo" } } },
  });
}

async function connectedState(settings: Partial<McpSettings> = {}) {
  const wire = await host.wire();
  const state = createState(settings);
  state.config.mcpServers.demo = wire.definition;
  const connection = await state.manager.connect("demo", wire.definition);
  return { state, connection };
}

describe("formatMcpStatus", () => {
  it("returns undefined when the MCP footer is off", () => {
    expect(
      formatMcpStatus({ settings: { mcpFooterStatus: "off" } }, "connecting..."),
    ).toBeUndefined();
  });
});

describe("updateStatusBar", () => {
  it("shows enabled servers instead of active connections as the primary count", () => {
    updateStatusBar(createState({ mcpFooterStatus: "full" }));

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("does not count a needs-auth connection as connected", async () => {
    const { state, connection } = await connectedState({ mcpFooterStatus: "full" });
    connection.status = "needs-auth";

    updateStatusBar(state);

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("shows connected servers as secondary state", async () => {
    const { state } = await connectedState({ mcpFooterStatus: "full" });

    updateStatusBar(state);

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled (1 connected)");
  });

  it("keeps themed status text when a theme is available", () => {
    host.foreground.mockImplementation((_color, text) => `styled:${text}`);

    updateStatusBar(createState({ mcpFooterStatus: "full" }));

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "styled:🔌 MCP: 1 server enabled");
  });

  it("keeps the icon when explicitly enabled", () => {
    updateStatusBar(createState({ showStatusIcon: true, mcpFooterStatus: "full" }));

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled");
  });

  it("removes the icon while preserving themed connected and disabled suffixes", async () => {
    host.foreground.mockImplementation((_color, text) => `styled:${text}`);
    const { state } = await connectedState({ showStatusIcon: false, mcpFooterStatus: "full" });
    state.config.mcpServers.disabled = { command: "disabled", disabled: true };

    updateStatusBar(state);

    expect(host.ui.setStatus).toHaveBeenCalledWith(
      "mcp",
      "styled:MCP: 1 server enabled (1 connected) (1 disabled)",
    );
  });

  it("shows a compact connected/enabled footer by default", async () => {
    const { state } = await connectedState();

    updateStatusBar(state);

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", "MCP 1/1");
  });

  it("can clear the MCP footer status", () => {
    updateStatusBar(createState({ mcpFooterStatus: "off" }));

    expect(host.ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
  });
});
