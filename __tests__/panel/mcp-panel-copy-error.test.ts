import { afterEach, describe, expect, it, vi } from "vitest";
import { noop } from "./helpers.ts";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ copyToClipboard: mocks.copyToClipboard }));

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("mcp-panel failure copy", () => {
  afterEach(() => vi.clearAllMocks());

  it("copies a sanitized selected failure reason and shows a notice", async () => {
    const { createMcpPanel } = await import("../../mcp-panel.ts");
    const { computeServerHash } = await import("../../metadata-cache.ts");
    const config = { mcpServers: { demo: { command: "node", args: ["server.js"] } } };
    const cache = {
      version: 1 as const,
      servers: {
        demo: {
          configHash: computeServerHash(config.mcpServers.demo),
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
      },
    };
    const panel = createMcpPanel({
      config,
      cache,
      provenance: new Map(),
      callbacks: {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "failed",
        getFailureMessage: () =>
          "connection failed\n\x1b]8;;https://secret.invalid\x07details\x1b]8;;\x07",
        refreshCacheAfterReconnect: () => null,
      },
      tui: { requestRender: noop },
      done: noop,
    });

    panel.handleInput("\x19");
    await flush();

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("connection failed details");
    const output = stripAnsi(panel.render(80).join("\n"));
    expect(output).toContain("Copied error");
    expect(output).not.toContain("https://secret.invalid");
    panel.dispose();
  });

  it("does nothing when the selected server has no failure reason", async () => {
    const { createMcpPanel } = await import("../../mcp-panel.ts");
    const config = { mcpServers: { demo: { command: "node" } } };
    const panel = createMcpPanel({
      config,
      cache: null,
      provenance: new Map(),
      callbacks: {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        getFailureMessage: () => null,
        refreshCacheAfterReconnect: () => null,
      },
      tui: { requestRender: noop },
      done: noop,
    });

    panel.handleInput("\x19");
    await flush();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    panel.dispose();
  });
});
