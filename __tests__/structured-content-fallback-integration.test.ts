import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { firstText, proxyRuntimeState } from "./fixtures/proxy-runtime.ts";

let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

function textOf(result: Pick<AgentToolResult<unknown>, "content">): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("structuredContent and CallToolResult parity — direct tool executor", () => {
  it("surfaces structuredContent to the model when content is empty and returns full CallToolResult", async () => {
    const structured = { status: "available", summary: "## Notes" };
    const { state } = await proxyRuntimeState({
      result: { isError: false, content: [], structuredContent: structured },
      name: "get-summary",
    });
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "get-summary",
        prefixedName: "demo_get-summary",
        description: "Get summary",
        outputSchema: { type: "object" },
      },
    );
    const result = await executor(
      "id",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("id", state.owner.signal),
    );
    expect(firstText(result)).toBe(JSON.stringify(structured, null, 2));
    expect(result.content).toHaveLength(1);
    expect(result.details.resultRef).toEqual(expect.any(String));
    expect(textOf(result)).not.toContain("(empty result)");
    expect(result.structuredContent).toEqual({
      isError: false,
      content: [],
      structuredContent: structured,
    });
  });

  it("returns untruncated CallToolResult above 16 KiB detailsMaxBytes while bounding details and content, stripping _meta", async () => {
    const { state, setResult } = await proxyRuntimeState({
      result: {
        isError: true,
        content: [{ type: "text", text: "human failure", _meta: { block: "secret-block" } }],
        structuredContent: { failed: true },
        _meta: { private: "secret" },
      },
    });
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "tool",
        prefixedName: "demo_tool",
        description: "Tool",
        outputSchema: { type: "object" },
      },
    );
    const failed = await executor(
      "failed",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("failed", state.owner.signal),
    );
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual({
      isError: true,
      content: [{ type: "text", text: "human failure" }],
      structuredContent: { failed: true },
    });
    expect(textOf(failed)).toContain("human failure");
    expect(JSON.stringify(failed.structuredContent)).not.toContain("secret");

    state.config.settings = { outputGuard: { maxBytes: 1000, detailsMaxBytes: 100 } };
    const largeValue = "x".repeat(5000);
    setResult({
      content: [{ type: "text", text: largeValue, _meta: { private: "block-secret" } }],
      structuredContent: { large: largeValue },
      _meta: { private: "top-secret" },
    });
    const large = await executor(
      "large",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("large", state.owner.signal),
    );
    expect(large.structuredContent).toEqual({
      content: [{ type: "text", text: largeValue }],
      structuredContent: { large: largeValue },
    });
    expect(large.details.mcpResult).toMatchObject({ omitted: true });
    expect(large.details.outputGuard).toMatchObject({ truncated: true });
    expect(textOf(large)).toContain(large.details.resultRef);
  });

  it("returns CallToolResult for schema-less tools and rejects non-provider failures via isError without structuredContent", async () => {
    const { state } = await proxyRuntimeState({
      result: { isError: false, content: [] },
      name: "noop",
    });
    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );
    const result = await executor(
      "id",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("id", state.owner.signal),
    );
    expect(textOf(result)).toBe("(empty result)");
    expect(result.structuredContent).toEqual({ isError: false, content: [] });

    const uninitialized = createDirectToolExecutor(
      () => null,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );
    const missingState = await uninitialized(
      "missing",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("missing", state.owner.signal),
    );
    expect(missingState.isError).toBe(true);
    expect(missingState.structuredContent).toBeUndefined();
    expect(textOf(missingState)).toBe("MCP not initialized");
  });
});

describe("structuredContent fallback — proxy executeCall", () => {
  it("surfaces structuredContent to the model when content is empty", async () => {
    const structured = { status: "available", summary: "## Notes" };
    const { state } = await proxyRuntimeState({
      result: { isError: false, content: [], structuredContent: structured },
      name: "get-summary",
    });
    const result = await executeCall(state, {
      toolName: "demo_get-summary",
      args: {},
      serverOverride: "demo",
    });
    expect(textOf(result)).toContain(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { state } = await proxyRuntimeState({
      result: { isError: false, content: [] },
      name: "noop",
    });
    const result = await executeCall(state, {
      toolName: "demo_noop",
      args: {},
      serverOverride: "demo",
    });
    expect(textOf(result)).toContain("(empty result)");
  });
});
