import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";

// The proxy and direct tool paths used to be copy-pasted, and had already drifted:
// only the proxy passed rawMcpResult, so direct tool results silently lost
// details.mcpResult. Both now share runToolCall; this pins that they agree.

const MCP_RESULT = {
  isError: false,
  content: [{ type: "text", text: "hello" }],
  structuredContent: { greeting: "hello" },
};

function connectedState() {
  return {
    config: {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "node", args: ["server.js"] } },
    },
    manager: {
      getConnection: vi.fn(() => ({
        status: "connected",
        client: { callTool: vi.fn(async () => MCP_RESULT) },
        tools: [],
        resources: [],
      })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      close: vi.fn(async () => undefined),
      getRequestOptions: vi.fn(() => undefined),
    },
    toolMetadata: new Map([
      ["demo", [{ name: "demo_echo", originalName: "echo", description: "Echo tool" }]],
    ]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui: undefined,
  } as any;
}

describe("proxy and direct tool call parity", () => {
  it("returns the same details from both paths, including details.mcpResult", async () => {
    const proxy = await executeCall(connectedState(), "demo_echo", { x: 1 });

    const direct = await createDirectToolExecutor(() => connectedState(), () => null, {
      serverName: "demo",
      originalName: "echo",
      prefixedName: "demo_echo",
      description: "Echo tool",
    })("call-1", { x: 1 }, undefined, undefined, {} as any);

    // The raw MCP result reaches the caller on both paths. mcp_script reads this.
    expect(direct.details.mcpResult).toEqual(MCP_RESULT);
    expect(proxy.details.mcpResult).toEqual(MCP_RESULT);

    // `mode` is the only field the proxy adds; everything else must match.
    expect(proxy.details).toEqual({ mode: "call", ...direct.details });
    expect(direct.content).toEqual(proxy.content);
  });
});
