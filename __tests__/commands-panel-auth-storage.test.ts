import { afterEach, describe, expect, it, vi } from "vitest";
import { openMcpAuthPanel, openMcpPanel } from "../commands.ts";

const previousAuthStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

afterEach(() => {
  if (previousAuthStore === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
  else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousAuthStore;
});

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createPanelHarness() {
  let rendered = "";
  const ui = {
    notify: vi.fn(),
    custom: vi.fn((factory: any) => {
      const panel = factory({ requestRender() {} }, undefined, undefined, () => {});
      rendered = stripAnsi(panel.render(100).join("\n"));
      panel.handleInput("\x03");
    }),
  };
  return { ui, getRendered: () => rendered };
}

function createState() {
  return {
    programmaticConfig: false,
    config: {
      mcpServers: {
        oauth: { url: "https://example.test/mcp", auth: "oauth" },
      },
    },
    authStorageOptions: {},
    manager: { getConnection: () => undefined },
    failureTracker: new Map(),
    failureMessages: new Map(),
  } as any;
}

describe("MCP panels with unavailable OAuth credential storage", () => {
  it.each([openMcpPanel, (state: any, _pi: any, ctx: any) => openMcpAuthPanel(state, ctx)])("does not inspect browser credentials for CAA status", async openPanel => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    const state = createState();
    state.config.mcpServers.oauth.oauth = { crossAppAccess: { idpUrl: "https://idp.example", clientId: "idp", idToken: "!exit 99" } };
    const { ui, getRendered } = createPanelHarness();
    await openPanel(state, {} as any, { hasUI: true, mode: "tui", isProjectTrusted: () => true, cwd: "/tmp", ui } as any);
    expect(getRendered()).not.toContain("needs auth");
    expect(getRendered()).not.toContain("OAuth credential store unavailable");
    expect(getRendered()).not.toContain("failed");
  });
  it.each([
    ["/mcp", (state: any, ctx: any) => openMcpPanel(state, {} as any, ctx)],
    ["/mcp-auth", (state: any, ctx: any) => openMcpAuthPanel(state, ctx)],
  ])("opens %s without throwing and presents the failure reason", async (_command, openPanel) => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    const { ui, getRendered } = createPanelHarness();

    await expect(openPanel(
      createState(),
      { hasUI: true, mode: "tui", isProjectTrusted: () => true, cwd: "/tmp", ui } as any,
    )).resolves.toEqual({ configChanged: false });

    expect(getRendered()).toContain("failed");
    expect(getRendered()).not.toContain("needs auth");
    expect(getRendered()).toContain("OAuth credential store unavailable");
  });
});
