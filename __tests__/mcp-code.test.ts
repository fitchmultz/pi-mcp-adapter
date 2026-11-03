import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { asObjectRecord } from "../mcp-output-values.ts";
import type { TextContent } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createMcpAdapter } from "../index.ts";
import { runMcpScript } from "../mcp-code.ts";
import { guardMcpOutput, resolveMcpOutputGuardOptions } from "../mcp-output-guard.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpSettings } from "../types.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
let manager: McpServerManager;
let state: McpExtensionState;

const anyNumber: unknown = expect.any(Number);
const memoryReportSchema = Type.Object({
  queuedGrowth: Type.Number(),
  details: Type.Object({
    outputGuard: Type.Object({
      originalBytes: Type.Number(),
      originalLines: Type.Number(),
      returnedBytes: Type.Number(),
    }),
  }),
  lines: Type.Object({ total: Type.Number(), expected: Type.Number() }),
});
function lastText(result: Awaited<ReturnType<typeof runMcpScript>>): string {
  const text = textBlocks(result).at(-1);
  assert.ok(text !== undefined, "Expected script text output");
  return text;
}
async function verifySavedOutput(path: unknown, contents: string): Promise<void> {
  assert.ok(typeof path === "string");
  expect(await readFile(path, "utf8")).toBe(contents);
}
function verifyUnsavedOutput(path: unknown): void {
  expect(path).toBeUndefined();
}
function textBlocks(result: Awaited<ReturnType<typeof runMcpScript>>): string[] {
  return result.content
    .filter(
      (block): block is TextContent =>
        block.type === "text" && !block.text.startsWith("[MCP result saved:"),
    )
    .map((block) => block.text);
}

describe("runMcpScript", () => {
  it("registers mcp_script by default", async () => {
    const registerTool = vi.fn<(tool: unknown) => void>();
    const native = await createTestExtensionContext("all", (pi) => {
      const register = pi.registerTool.bind(pi);
      vi.spyOn(pi, "registerTool").mockImplementation((tool) => {
        register(tool);
        registerTool(tool);
      });
      createMcpAdapter({ config: { settings: {}, mcpServers: {} } })(pi);
    });
    await native.dispose();
    const description: unknown = expect.stringContaining(
      "Compose MCP calls with trusted JavaScript",
    );
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mcp_script",
        description,
        promptSnippet:
          "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      }),
    );
  });

  it("skips mcp_script when scriptMode is false", async () => {
    const registerTool = vi.fn<(tool: unknown) => void>();
    const native = await createTestExtensionContext("all", (pi) => {
      const register = pi.registerTool.bind(pi);
      vi.spyOn(pi, "registerTool").mockImplementation((tool) => {
        register(tool);
        registerTool(tool);
      });
      createMcpAdapter({ config: { settings: { scriptMode: false }, mcpServers: {} } })(pi);
    });
    await native.dispose();
    expect(registerTool).toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp_script" }));
  });

  beforeAll(async () => {
    manager = new McpServerManager();
    await manager.connect("fixture", definition);
    state = createTestState({
      config: { settings: {}, mcpServers: { fixture: definition } },
      toolMetadata: new Map([
        [
          "fixture",
          [
            { name: "fixture_echo", originalName: "echo", description: "Echo a value" },
            { name: "fixture_fail", originalName: "fail", description: "Return an MCP tool error" },
            { name: "fixture_hang", originalName: "hang", description: "Never resolves" },
          ],
        ],
      ]),
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    });
  });

  afterAll(async () => {
    await state.owner.stop("test cleanup");
    await manager.closeAll();
  });

  it("uses script-local discovery guidance when a tool call misses", async () => {
    const result = await runMcpScript({
      state,
      code: 'return await tools.call("missing_tool", {});',
    });
    const payload: unknown = JSON.parse(lastText(result));

    const discoveryMessage: unknown = expect.stringContaining(
      'Use await tools.search({ query: "..." }) inside mcp_script.',
    );
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "tool_not_found",
        message: discoveryMessage,
      },
    });
    const payloadRecord = asObjectRecord(payload);
    const error = asObjectRecord(payloadRecord?.error);
    assert.ok(error);
    expect(error.message).not.toContain("mcp({ search:");
  });

  it("searches the script-visible tool catalog with pagination and server filtering", async () => {
    const result = await runMcpScript({
      state,
      code: 'return { first: await tools.search({ query: "fixture", limit: 1 }), second: await tools.search({ query: "fixture", limit: 1, offset: 1, server: "fixture" }), empty: await tools.search({ query: "" }) };',
    });

    expect(JSON.parse(lastText(result))).toEqual({
      first: {
        items: [
          {
            path: "fixture_echo",
            name: "echo",
            server: "fixture",
            description: "Echo a value",
            score: anyNumber,
          },
        ],
        total: 3,
        coverage: { complete: true, knownServers: ["fixture"], unknownServers: [] },
        hasMore: true,
        nextOffset: 1,
      },
      second: {
        items: [
          {
            path: "fixture_fail",
            name: "fail",
            server: "fixture",
            description: "Return an MCP tool error",
            score: anyNumber,
          },
        ],
        total: 3,
        coverage: { complete: true, knownServers: ["fixture"], unknownServers: [] },
        hasMore: true,
        nextOffset: 2,
      },
      empty: {
        items: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
        coverage: { complete: true, knownServers: ["fixture"], unknownServers: [] },
      },
    });
  });

  it("describes exact script-visible paths and suggests corrections without throwing", async () => {
    const result = await runMcpScript({
      state,
      code: 'return { found: await tools.describe({ path: "fixture_echo" }), missing: await tools.describe({ path: "fixture_ech" }) };',
    });

    expect(JSON.parse(lastText(result))).toEqual({
      found: {
        path: "fixture_echo",
        name: "echo",
        server: "fixture",
        description: "Echo a value",
      },
      missing: {
        path: "fixture_ech",
        error: {
          code: "tool_not_found",
          message: "Tool not found: fixture_ech",
          suggestions: ["fixture_echo"],
        },
      },
    });
  });

  it("records operation metadata and timing for search, describe, and calls", async () => {
    const result = await runMcpScript({
      state,
      code: 'await tools.search({ query: "fixture" }); await tools.describe({ path: "fixture_echo" }); await tools.describe({ path: "fixture_missing" }); return await tools.call("fixture_echo", { value: "traced" });',
    });

    expect(result.details).toMatchObject({
      calls: [
        { operation: "search", query: "fixture", ok: true, durationMs: anyNumber },
        { operation: "describe", path: "fixture_echo", ok: true, durationMs: anyNumber },
        {
          operation: "describe",
          path: "fixture_missing",
          ok: false,
          error: "tool_not_found",
          durationMs: anyNumber,
        },
        { operation: "call", path: "fixture_echo", ok: true, durationMs: anyNumber },
      ],
    });
  });

  it("calls exact paths and returns an invalid-path envelope without throwing", async () => {
    const result = await runMcpScript({
      state,
      code: 'return { success: await tools.call("fixture_echo", { value: "canonical" }), invalid: await tools.call("", {}) };',
    });

    expect(JSON.parse(lastText(result))).toMatchObject({
      success: {
        ok: true,
        data: { structuredContent: { echoed: "canonical" } },
      },
      invalid: {
        ok: false,
        error: {
          code: "invalid_tool_path",
          message: "tools.call(path, args) requires a non-empty tool path.",
        },
      },
    });
    expect(result.details).toMatchObject({ calls: [{ path: "fixture_echo", ok: true }] });
  });

  it("records approval-gate outcomes in the call trace", async () => {
    const gatedState = createTestState({
      ...state,
      config: { settings: { approveTools: ["echo"] }, mcpServers: { fixture: definition } },
      approvedToolCalls: new Map(),
    });

    const result = await runMcpScript({
      state: gatedState,
      code: 'return await tools.fixture_echo({ value: "blocked" });',
    });

    expect(JSON.parse(lastText(result))).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(result.details).toMatchObject({
      calls: [{ path: "fixture_echo", ok: false, error: "approval_required" }],
    });
  });

  it("calls a prefixed MCP tool through the flat tools proxy", async () => {
    const result = await runMcpScript({
      state,
      code: 'return await tools.fixture_echo({ value: "round trip" });',
    });

    expect(JSON.parse(lastText(result))).toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "round trip" }],
        structuredContent: { echoed: "round trip" },
      },
    });
  });

  it("lets scripts reduce raw MCP results larger than the model-facing details limit", async () => {
    const value = "x".repeat(1000);
    const limitedState = createTestState({
      ...state,
      config: {
        settings: { outputGuard: { detailsMaxBytes: 100 } },
        mcpServers: { fixture: definition },
      },
    });

    const result = await runMcpScript({
      state: limitedState,
      code: `const result = await tools.fixture_echo({ value: ${JSON.stringify(value)} }); return { omitted: result.data.omitted === true, echoed: result.data.structuredContent?.echoed };`,
    });

    expect(JSON.parse(lastText(result))).toEqual({ omitted: false, echoed: value });
  });

  it("preserves saved-result optional-field diagnostics and nullish window defaults", async () => {
    const result = await runMcpScript({
      state,
      code: `
        const call = await tools.fixture_echo({ value: "readable" });
        const invalid = await Promise.all([
          { path: 4 },
          { fields: [4] },
          { fields: null },
          { offset: "1" },
          { offset: NaN },
          { limit: 0 },
        ].map(input => tools.readResult({ ref: call.resultRef, ...input })));
        const valid = await tools.readResult({
          ref: call.resultRef, path: "/structuredContent/echoed", offset: null, limit: null,
        });
        return { invalid, valid };
      `,
    });
    const failure = (message: string) => ({
      content: [{ type: "text", text: message }],
      details: { error: "result_read_failed", message },
    });
    expect(JSON.parse(lastText(result))).toMatchObject({
      invalid: [
        failure("path must be an RFC 6901 JSON Pointer"),
        failure("fields must be an array of keys"),
        failure("fields must be an array of keys"),
        failure("offset must be a non-negative integer and limit a positive integer"),
        failure("offset must be a non-negative integer and limit a positive integer"),
        failure("offset must be a non-negative integer and limit a positive integer"),
      ],
      valid: {
        content: [{ type: "text", text: '"readable"' }],
        details: { offset: 0, nextOffset: null, totalCharacters: 10 },
      },
    });
    expect(result.details).not.toHaveProperty("error");
  });

  it("returns a failure envelope and lets the script continue", async () => {
    const result = await runMcpScript({
      state,
      code: "const failure = await tools.fixture_fail({}); return { failure, continued: true };",
    });

    const failureMessage: unknown = expect.stringContaining("fixture failure");
    expect(JSON.parse(lastText(result))).toMatchObject({
      continued: true,
      failure: {
        ok: false,
        error: { code: "tool_error", message: failureMessage },
      },
    });
    expect(result.details).toMatchObject({
      calls: [{ path: "fixture_fail", ok: false, error: "tool_error" }],
    });
    expect(result.details).not.toHaveProperty("error");
  });

  it("does not treat promise/serialization probes as tool calls", async () => {
    const result = await runMcpScript({ state, code: "return tools;" });

    expect(result.details).not.toHaveProperty("error");
    expect(result.details).not.toHaveProperty("calls");
  });

  it("keeps in-flight calls in the trace when the script times out", async () => {
    const result = await runMcpScript({
      state,
      code: 'await tools.fixture_echo({ value: "done" }); await tools.fixture_hang({});',
      timeoutMs: 300,
    });

    expect(result.details).toMatchObject({
      error: "timeout",
      calls: [
        { path: "fixture_echo", ok: true },
        {
          path: "fixture_hang",
          ok: false,
          error: "ambiguous_outcome",
          recovery: { action: "readback" },
        },
      ],
    });
  });

  it("aborts nested calls and releases in-flight accounting on caller cancellation", async () => {
    const controller = new AbortController();
    const pending = runMcpScript({
      state,
      code: "await tools.fixture_hang({});",
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await expect.poll(() => manager.getConnection("fixture")?.inFlight).toBe(1);
    controller.abort(new Error("caller cancelled"));
    const result = await pending;
    expect(result.details).toMatchObject({
      error: "aborted",
      calls: [
        {
          path: "fixture_hang",
          ok: false,
          error: "ambiguous_outcome",
          recovery: { action: "readback" },
        },
      ],
    });
    await expect.poll(() => manager.getConnection("fixture")?.inFlight).toBe(0);
  });

  it("returns promptly on early return and reports un-awaited dispatched calls as unknown", async () => {
    const start = Date.now();
    const result = await runMcpScript({
      state,
      code: 'tools.fixture_hang({}); return "early";',
      timeoutMs: 5_000,
    });

    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.details).not.toHaveProperty("error");
    expect(result.details).toMatchObject({
      calls: [
        {
          path: "fixture_hang",
          ok: false,
          error: "ambiguous_outcome",
          recovery: { action: "readback" },
        },
      ],
    });
  });

  it("terminates synchronous runaway code after an awaited tool call", async () => {
    const result = await runMcpScript({
      state,
      code: 'await tools.fixture_echo({ value: "x" }); while (true) {}',
      timeoutMs: 300,
    });

    expect(result.details).toMatchObject({
      error: "timeout",
      calls: [{ path: "fixture_echo", ok: true }],
    });
  });

  it("bounds synchronous runaway code and preserves partial emits", async () => {
    // Margin covers worker spawn latency on slow CI runners; the emit must land before the deadline.
    const result = await runMcpScript({
      state,
      code: 'emit("before timeout"); while (true) {}',
      timeoutMs: 250,
    });

    expect(textBlocks(result)[0]).toBe("before timeout");
    expect(result.details).toMatchObject({ error: "timeout", timeoutMs: 250 });
    expect(textBlocks(result).at(-1)).toBe("mcp_script timed out after 250ms");
  });

  it("orders emitted and captured console blocks before the return value", async () => {
    const result = await runMcpScript({
      state,
      code: 'emit("first"); console.log("second"); return "last";',
    });

    expect(textBlocks(result)).toEqual(["first", "[console.log] second", "last"]);
  });

  it("formats non-JSON values in emitted, returned, and console output", async () => {
    const result = await runMcpScript({
      state,
      code: `const cycle = {}; cycle.self = cycle;
      const value = { map: new Map([["key", 1]]), set: new Set(["value"]), cycle, fn: function named() {}, symbol: Symbol("token"), bigint: 1n };
      emit(value); console.log(new Map([["console", 2]])); return value;`,
    });

    for (const block of [textBlocks(result)[0], lastText(result)]) {
      expect(block).toContain("Map(1)");
      expect(block).toContain("Set(1)");
      expect(block).toContain("[Circular");
      expect(block).toContain("[Function: named]");
      expect(block).toContain("Symbol(token)");
      expect(block).toContain("1n");
    }
    expect(textBlocks(result)[1]).toContain("Map(1) { 'console' => 2 }");
  });

  it("does not format shared acyclic references as circular", async () => {
    const result = await runMcpScript({
      state,
      code: 'const shared = { id: "same" }; return { first: shared, second: shared };',
    });

    const block = lastText(result);
    expect(block).not.toContain("Circular");
    expect(JSON.parse(block)).toEqual({ first: { id: "same" }, second: { id: "same" } });
  });

  it("rejects tools enumeration with discovery guidance without exposing host globals", async () => {
    const result = await runMcpScript({
      state,
      code: `let message;
      try { Object.keys(tools); } catch (error) { message = error.message; }
      return { message, globals: [typeof require, typeof fetch, typeof process] };`,
    });

    const first = textBlocks(result)[0];
    assert.ok(first !== undefined);
    expect(JSON.parse(first)).toEqual({
      message: "tools is not enumerable — use tools.search({ query })",
      globals: ["undefined", "undefined", "undefined"],
    });
  });
});

describe("runMcpScript output", () => {
  const scriptState = (settings: McpSettings, outputDirectory: string) =>
    createTestState({
      config: { mcpServers: {}, settings },
      toolMetadata: new Map(),
      failureTracker: new Map(),
      completedUiSessions: [],
      outputDirectory,
    });

  it.each<McpSettings>([{ outputGuard: { maxBytes: 4096, maxLines: 40 } }, { outputGuard: false }])(
    "streams many emits into the same guarded result as the complete output (%j)",
    async (settings) => {
      const small = (index: number) =>
        `${index}: π 😀 ${"é".repeat(index % 7)}${index % 10 === 0 ? "\nsecond line" : ""}`;
      const values = [
        ...Array.from({ length: 20 }, (_, index) => small(index)),
        `${"a".repeat(3000)}${"😀".repeat(2000)}`,
        ...Array.from({ length: 280 }, (_, index) => small(index + 20)),
      ];
      const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
      const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-script-output-"));
      try {
        const result = await runMcpScript({
          state: scriptState(settings, outputDirectory),
          code: `${JSON.stringify(values)}.forEach((value, index) => { if (index === 10) emit(${JSON.stringify(image)}); emit(value); });`,
        });
        const blocks = [
          ...values.slice(0, 10).map((text) => ({ type: "text" as const, text })),
          image,
          ...values.slice(10).map((text) => ({ type: "text" as const, text })),
        ];
        const complete = await guardMcpOutput(
          blocks,
          resolveMcpOutputGuardOptions(settings, outputDirectory),
        );
        const path = asObjectRecord(result.details.outputGuard)?.fullOutputPath;
        const visible = (content: unknown, outputGuard: unknown, artifact?: unknown): unknown => {
          const json = JSON.stringify({ content, outputGuard });
          return JSON.parse(
            typeof artifact === "string" ? json.replaceAll(artifact, "<artifact>") : json,
          );
        };

        expect(visible(result.content, result.details.outputGuard, path)).toEqual(
          visible(complete.content, complete.outputGuard, complete.outputGuard?.fullOutputPath),
        );
        const verifyArtifact =
          settings.outputGuard === false ? verifyUnsavedOutput : verifySavedOutput;
        await verifyArtifact(path, values.join("\n"));
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "1 MiB emits larger in total than the host heap", length: 2 ** 20, count: 128 },
    { name: "a million single-character emits", length: 1, count: 1_000_000 },
  ])(
    "keeps host memory bounded while a script queues $name",
    async ({ length, count }) => {
      const outputDirectory = await mkdtemp(join(tmpdir(), "mcp-script-memory-"));
      try {
        const script = join(outputDirectory, "host.mjs");
        await writeFile(
          script,
          `
        import { createReadStream } from "node:fs";
        import { createInterface } from "node:readline";
        import { runMcpScript } from ${JSON.stringify(new URL("../mcp-code.ts", import.meta.url).href)};
        import { createTestState } from ${JSON.stringify(new URL("./test-state.ts", import.meta.url).href)};
        const state = createTestState({ outputDirectory: ${JSON.stringify(outputDirectory)} });
        const start = process.memoryUsage.rss();
        const pending = runMcpScript({ state, code: "const line = 'x'.repeat(${length}); for (let i = 0; i < ${count}; i++) emit(line);", timeoutMs: 60000 });
        // Hold the host event loop so the worker's output can only queue.
        let queuedGrowth = 0;
        for (const end = Date.now() + 2000; Date.now() < end && queuedGrowth < 128 * 2 ** 20;) queuedGrowth = Math.max(queuedGrowth, process.memoryUsage.rss() - start);
        const { details } = await pending;
        const expected = "x".repeat(${length});
        const lines = { total: 0, expected: 0 };
        for await (const line of createInterface({ input: createReadStream(details.outputGuard.fullOutputPath) })) {
          lines.total++;
          if (line === expected) lines.expected++;
        }
        console.log(JSON.stringify({ queuedGrowth, details, lines }));
      `,
        );
        const child = spawnSync(process.execPath, ["--max-old-space-size=64", script], {
          encoding: "utf8",
          timeout: 60_000,
        });

        expect(child.status, child.stderr).toBe(0);
        const report: unknown = JSON.parse(child.stdout);
        assert.ok(Value.Check(memoryReportSchema, report), "Invalid memory child report");
        expect(report.queuedGrowth).toBeLessThan(64 * 2 ** 20);
        expect(report.details).not.toHaveProperty("error");
        expect(report.details.outputGuard).toMatchObject({
          originalBytes: count * (length + 1) - 1,
          originalLines: count,
        });
        expect(report.details.outputGuard.returnedBytes).toBeLessThanOrEqual(50 * 1024);
        expect(report.lines).toEqual({ total: count, expected: count });
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("delivers output to a running Pi whose adapter predates output flow control", async () => {
    // Such a host starts the updated worker file with the workerData it always sent.
    const worker = new Worker(new URL("../mcp-script-worker.mjs", import.meta.url), {
      workerData: { code: `emit("a 😀"); console.log("b"); return "c";` },
      env: {},
    });
    const messages: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        worker.on("message", (message: unknown) => {
          messages.push(message);
          const type = asObjectRecord(message)?.type;
          if (type === "done" || type === "error") {
            resolve();
          }
        });
        worker.on("error", reject);
      });
    } finally {
      await worker.terminate();
    }

    expect(messages).toEqual([
      { type: "emit", block: { type: "text", text: "a 😀" } },
      { type: "emit", block: { type: "text", text: "[console.log] b" } },
      { type: "done", returnBlock: { type: "text", text: "c" } },
    ]);
  });
});
