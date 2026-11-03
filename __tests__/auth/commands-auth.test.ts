import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { authenticate, removeAuth } from "../../mcp-auth-flow.ts";
import { authenticateServer, logoutServer, openMcpAuthPanel } from "../../commands.ts";
import { createPanelHost } from "../fixtures/panel-host.ts";
import { createTestState } from "../test-state.ts";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn<typeof authenticate>(),
  removeAuth: vi.fn<typeof removeAuth>(),
}));

vi.mock(import("../../mcp-auth-flow.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  authenticate: mocks.authenticate,
  removeAuth: mocks.removeAuth,
}));

let host: Awaited<ReturnType<typeof createPanelHost>>;
const originalMcpAuthUrl = process.env.MCP_AUTH_URL;
beforeAll(() => initTheme());
beforeEach(async () => {
  host = await createPanelHost();
  mocks.authenticate.mockReset();
  mocks.removeAuth.mockReset();
});
afterEach(async () => {
  await host.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalMcpAuthUrl === undefined) {
    delete process.env.MCP_AUTH_URL;
  } else {
    process.env.MCP_AUTH_URL = originalMcpAuthUrl;
  }
});

describe("authenticateServer", () => {
  it("does not open an empty auth panel for disabled-only OAuth config", async () => {
    const { ui } = host.context;
    const custom = vi.spyOn(ui, "custom");
    await openMcpAuthPanel(
      createTestState({
        programmaticConfig: false,
        config: {
          mcpServers: {
            disabled: { url: "https://example.test/mcp", auth: "oauth", disabled: true },
          },
        },
      }),
      host.context,
    );

    expect(ui.notify).toHaveBeenCalledWith(
      "No OAuth-capable MCP servers are configured.",
      "warning",
    );
    expect(custom).not.toHaveBeenCalled();
  });

  it("interpolates the server URL before OAuth authentication", async () => {
    vi.stubEnv("MCP_AUTH_URL", "https://mcp.sentry.dev/mcp");
    mocks.authenticate.mockResolvedValueOnce("authenticated");
    const definition = { url: "${MCP_AUTH_URL}", auth: "oauth" as const };
    const controller = new AbortController();
    const callback: unknown = expect.any(Function);
    const result = await authenticateServer({
      serverName: "sentry",
      config: { mcpServers: { sentry: definition } },
      ctx: { ...host.context, signal: controller.signal },
    });

    expect(result.ok).toBe(true);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "sentry",
      "https://mcp.sentry.dev/mcp",
      definition,
      { onAuthorizationUrl: callback, signal: controller.signal },
    );
  });

  it("fails OAuth authentication before requests when URL variables are missing", async () => {
    delete process.env.MCP_AUTH_URL;
    const { ui } = host.context;
    const result = await authenticateServer({
      serverName: "sentry",
      config: { mcpServers: { sentry: { url: "https://${MCP_AUTH_URL}/mcp", auth: "oauth" } } },
      ctx: host.context,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Missing environment variable in MCP server URL: MCP_AUTH_URL");
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      'Failed to authenticate "sentry": Missing environment variable in MCP server URL: MCP_AUTH_URL',
      "error",
    );
  });

  it("reports credential removal failures without escaping the logout command boundary", async () => {
    mocks.removeAuth.mockRejectedValueOnce(
      new Error("simulated secure credential store unavailable"),
    );
    const state = createTestState({
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
    });
    const close = vi.spyOn(state.manager, "close");
    const result = await logoutServer("sentry", state, host.context);

    expect(result).toEqual({ ok: false, message: "simulated secure credential store unavailable" });
    expect(close).not.toHaveBeenCalled();
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      'Failed to clear OAuth credentials for "sentry": simulated secure credential store unavailable',
      "error",
    );
  });

  it("reports a close failure accurately after credentials were removed", async () => {
    const state = createTestState({
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
    });
    vi.spyOn(state.manager, "close").mockRejectedValueOnce(new Error("close failed"));
    const result = await logoutServer("sentry", state, host.context);

    expect(result).toEqual({ ok: false, message: "close failed" });
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      'OAuth credentials were cleared for "sentry", but its connection could not be closed: close failed',
      "error",
    );
  });

  it("surfaces the exact OAuth URL through UI notification", async () => {
    const authorizationUrl =
      "https://auth.example.com/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp";
    const callback: unknown = expect.any(Function);
    mocks.authenticate.mockImplementationOnce(async (_name, _url, _definition, options) => {
      await options?.onAuthorizationUrl?.(authorizationUrl);
      return "authenticated";
    });
    const result = await authenticateServer({
      serverName: "sentry",
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
      ctx: host.context,
    });

    expect(result.ok).toBe(true);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "sentry",
      "https://mcp.sentry.dev/mcp",
      { url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
      { onAuthorizationUrl: callback },
    );
    expect(host.context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(authorizationUrl),
      "info",
    );
  });
});
