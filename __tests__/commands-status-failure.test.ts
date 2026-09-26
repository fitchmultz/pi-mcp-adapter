import { describe, expect, it, vi } from "vitest";

vi.mock("../init.ts", () => ({
  getFailureAgeSeconds: vi.fn(() => 7),
  getFailureMessage: vi.fn(() => "stderr says\n\x1b]8;;https://secret.invalid/status\x07server failed\x1b]8;;\x07"),
  clearFailure: vi.fn(),
  lazyConnect: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  recordFailure: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

describe("MCP status failure reasons", () => {
  it("includes the bounded failure reason as a safe single-line status", async () => {
    const { showStatus } = await import("../commands.ts");
    const ui = { notify: vi.fn() };
    await showStatus({
      config: { mcpServers: { demo: { command: "node" } } },
      manager: { getConnection: () => undefined },
      toolMetadata: new Map(),
      failureTracker: new Map([["demo", Date.now()]]),
    } as any, { hasUI: true, ui } as any);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("demo: failed 7s ago — stderr says server failed"),
      "info",
    );
    expect(ui.notify.mock.calls[0]![0]).not.toContain("https://secret.invalid/status");
  });

  it("reports real tool and resource counts while leaving cold catalogs undiscovered", async () => {
    const { getFailureAgeSeconds } = await import("../init.ts");
    vi.mocked(getFailureAgeSeconds).mockReturnValueOnce(null).mockReturnValueOnce(null);
    const { showStatus, showTools } = await import("../commands.ts");
    const ui = { notify: vi.fn() };
    const state = {
      config: { mcpServers: { docs: { command: "node" }, cold: { command: "node" } } },
      manager: { getConnection: () => undefined },
      toolMetadata: new Map([["docs", [
        { name: "docs_search", originalName: "search", description: "Search" },
        { name: "docs_read_guide", originalName: "read_guide", description: "Guide", resourceUri: "docs://guide" },
      ]]]),
    };
    await showStatus(state as any, { hasUI: true, ui } as any);
    const status = ui.notify.mock.calls[0]![0];
    expect(status).toContain("docs: cached (1 tool, 1 resource, cached)");
    expect(status).toContain("cold: not connected (undiscovered)");
    expect(status).not.toContain("0 tools");
    await showTools(state as any, { hasUI: true, ui } as any);
    expect(ui.notify.mock.calls[1]![0]).toContain("docs_search");
    expect(ui.notify.mock.calls[1]![0]).toContain("Total: 1 tool");
    expect(ui.notify.mock.calls[1]![0]).not.toContain("docs_read_guide");
    state.toolMetadata.clear();
    await showTools(state as any, { hasUI: true, ui } as any);
    expect(ui.notify.mock.calls[2]![0]).toBe("No MCP tools discovered. Use mcp_search to discover tools.");
  });

  it("sanitizes captured diagnostics in reconnect notifications", async () => {
    const { reconnectServer } = await import("../commands.ts");
    const ui = { notify: vi.fn() };
    await reconnectServer({
      config: { settings: {}, mcpServers: { demo: { command: "node" } } },
      manager: {
        close: vi.fn(async () => {}),
        connect: vi.fn(async () => {
          throw new Error("stderr \x1b]52;c;clipboard-secret\x07server failed");
        }),
      },
    } as any, { hasUI: true, ui } as any, "demo");

    expect(ui.notify).toHaveBeenCalledWith("MCP: Failed to reconnect to demo: stderr server failed", "error");
    expect(ui.notify.mock.calls[0]![0]).not.toContain("clipboard-secret");
  });
});
