import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeDescribe, executeSearch } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "../tool-approval.ts";
import type { McpConfig, ToolMetadata } from "../types.ts";

const tool: ToolMetadata = {
  name: "demo_search-records",
  originalName: "search-records",
  description: "Search records",
};

function createState(options: {
  approveTools?: boolean | string[];
  decision?: "Allow once" | "Allow for session" | "Deny";
  interactive?: boolean;
} = {}) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
  const select = vi.fn().mockResolvedValue(options.decision ?? "Allow once");
  const connection = {
    status: "connected",
    client: { callTool },
    tools: [{ name: "search-records", description: "Search records" }],
    resources: [],
    prompts: [],
  };
  const state = {
    config: {
      mcpServers: {
        demo: {
          command: "demo",
          ...(options.approveTools === undefined ? {} : { approveTools: options.approveTools }),
        },
      },
    },
    toolMetadata: new Map([["demo", [tool]]]),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    approvedToolCalls: new Map<string, true>(),
    manager: {
      getConnection: () => connection,
      getRequestOptions: () => undefined,
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    failureMessages: new Map(),
    ...(options.interactive === false ? {} : { ui: { select } }),
  } as unknown as McpExtensionState;
  return { state, callTool, select };
}

describe("tool approval", () => {
  it("matches original, prefixed, normalized, and read_* resource tool names", () => {
    const cases: Array<{ config: McpConfig; meta: ToolMetadata }> = [
      {
        config: { mcpServers: { demo: { approveTools: ["search_records"] } } },
        meta: tool,
      },
      {
        config: { mcpServers: { demo: { approveTools: ["demo_search_records"] } } },
        meta: tool,
      },
      {
        config: { mcpServers: { "docs-mcp": {} }, settings: { approveTools: ["docs_read_*"] } },
        meta: { name: "docs_read_handbook", originalName: "read_handbook", description: "Read handbook", resourceUri: "docs://handbook" },
      },
    ];

    for (const { config, meta } of cases) {
      expect(isToolCallApprovalRequired(config, Object.keys(config.mcpServers)[0], meta)).toBe(true);
    }
  });

  it("fails closed headlessly with a structured approval_required result", async () => {
    const { state, callTool } = createState({ approveTools: true, interactive: false });

    const result = await executeCall(state, tool.name, { query: "private" });

    expect(result.details).toEqual({
      mode: "call",
      error: "approval_required",
      server: "demo",
      tool: "search-records",
    });
    expect(result.content[0].text).toContain("approval-gated");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns approval_denied without throwing or invoking proxy or direct tools", async () => {
    const proxy = createState({ approveTools: true, decision: "Deny" });
    await expect(executeCall(proxy.state, tool.name, {})).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(proxy.callTool).not.toHaveBeenCalled();

    const direct = createState({ approveTools: true, decision: "Deny" });
    const execute = createDirectToolExecutor(() => direct.state, () => null, {
      serverName: "demo",
      originalName: "search-records",
      prefixedName: "demo_search-records",
      description: "Search records",
    });
    await expect(execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(direct.callTool).not.toHaveBeenCalled();
  });

  it("caches only Allow for session decisions", async () => {
    const session = createState({ approveTools: true, decision: "Allow for session" });
    await ensureToolCallApproved(session.state, "demo", tool, {}, undefined);
    await ensureToolCallApproved(session.state, "demo", tool, {}, undefined);
    expect(session.select).toHaveBeenCalledTimes(1);
    expect(session.state.approvedToolCalls.has("demo\u0000search-records")).toBe(true);

    const once = createState({ approveTools: true, decision: "Allow once" });
    await ensureToolCallApproved(once.state, "demo", tool, {}, undefined);
    await ensureToolCallApproved(once.state, "demo", tool, {}, undefined);
    expect(once.select).toHaveBeenCalledTimes(2);
    expect(once.state.approvedToolCalls.size).toBe(0);
  });

  it("propagates aborts while the approval dialog is open", async () => {
    const { state, select } = createState({ approveTools: true });
    select.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error("stopped");
    reason.name = "AbortError";

    const pending = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("marks gated tools in describe and search output without hiding them", () => {
    const { state } = createState({ approveTools: true });

    expect(executeDescribe(state, tool.name).content[0].text).toContain("search-records (requires approval)");
    expect(executeSearch(state, "search", undefined, false).content[0].text).toContain("(requires approval)");
  });
});
