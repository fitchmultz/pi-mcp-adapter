import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeDescribe, executeSearch } from "../proxy-modes.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "../tool-approval.ts";
import type { McpConfig, ToolMetadata } from "../types.ts";

const tool: ToolMetadata = {
  name: "demo_search-records",
  originalName: "search-records",
  description: "Search records",
};

let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

function firstText(result: Pick<AgentToolResult<unknown>, "content">): string {
  const block = result.content[0];
  assert.ok(block?.type === "text");
  return block.text;
}

async function createState(
  options: {
    approveTools?: boolean | string[];
    decision?: "Allow once" | "Allow for session" | "Deny";
    interactive?: boolean;
  } = {},
) {
  const select = vi
    .fn<typeof host.context.ui.select>()
    .mockResolvedValue(options.decision ?? "Allow once");
  const definition = {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./fixtures/strict-resource-runtime-approval.ts", import.meta.url)),
    ],
    ...(options.approveTools === undefined ? {} : { approveTools: options.approveTools }),
  };
  const state = createTestState({
    config: { mcpServers: { demo: definition } },
    toolMetadata: new Map([["demo", [tool]]]),
    ...(options.interactive === false ? {} : { ui: { ...host.context.ui, select } }),
  });
  onTestFinished(async () => {
    await state.manager.closeAll();
  });
  const connection = await state.manager.connect("demo", definition);
  const callTool = vi.spyOn(connection.client, "callTool");
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
        meta: {
          name: "docs_read_handbook",
          originalName: "read_handbook",
          description: "Read handbook",
          resourceUri: "docs://handbook",
        },
      },
    ];

    for (const { config, meta } of cases) {
      const serverName = Object.keys(config.mcpServers)[0];
      assert.ok(serverName !== undefined);
      expect(isToolCallApprovalRequired(config, serverName, meta)).toBe(true);
    }
  });

  it("fails closed headlessly with a structured approval_required result", async () => {
    const { state, callTool } = await createState({ approveTools: true, interactive: false });

    const result = await executeCall(state, tool.name, { query: "private" });

    expect(result.details).toEqual({
      mode: "call",
      error: "approval_required",
      server: "demo",
      tool: "search-records",
    });
    expect(firstText(result)).toContain("approval-gated");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("returns approval_denied without throwing or invoking proxy or direct tools", async () => {
    const proxy = await createState({ approveTools: true, decision: "Deny" });
    await expect(executeCall(proxy.state, tool.name, {})).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(proxy.callTool).not.toHaveBeenCalled();

    const direct = await createState({ approveTools: true, decision: "Deny" });
    const execute = createDirectToolExecutor(
      () => direct.state,
      () => null,
      {
        serverName: "demo",
        originalName: "search-records",
        prefixedName: "demo_search-records",
        description: "Search records",
      },
    );
    await expect(execute("call-1", {}, undefined, undefined, host.context)).resolves.toMatchObject({
      details: { error: "approval_denied", server: "demo", tool: "search-records" },
    });
    expect(direct.callTool).not.toHaveBeenCalled();
  });

  it("caches only Allow for session decisions", async () => {
    const session = await createState({ approveTools: true, decision: "Allow for session" });
    await ensureToolCallApproved(session.state, "demo", tool, {});
    await ensureToolCallApproved(session.state, "demo", tool, {});
    expect(session.select).toHaveBeenCalledTimes(1);
    expect(session.state.approvedToolCalls.has("demo\u0000search-records")).toBe(true);

    const once = await createState({ approveTools: true, decision: "Allow once" });
    await ensureToolCallApproved(once.state, "demo", tool, {});
    await ensureToolCallApproved(once.state, "demo", tool, {});
    expect(once.select).toHaveBeenCalledTimes(2);
    expect(once.state.approvedToolCalls.size).toBe(0);
  });

  it("propagates aborts while the approval dialog is open", async () => {
    const { state, select } = await createState({ approveTools: true });
    select.mockImplementation(
      () =>
        new Promise(() => {
          // The dialog stays pending until the operation's signal cancels it.
        }),
    );
    const controller = new AbortController();
    const reason = new Error("stopped");
    reason.name = "AbortError";

    const pending = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("marks gated tools in describe and search output without hiding them", async () => {
    const { state } = await createState({ approveTools: true });

    expect(JSON.parse(firstText(executeDescribe(state, tool.name)))).toMatchObject({
      name: "search-records",
      approvalRequired: true,
    });
    expect(firstText(executeSearch(state, "search", undefined, false))).toContain(
      "(requires approval)",
    );
  });
});
