import assert from "node:assert/strict";
import { createTestState } from "./test-state.ts";
import { firstText } from "./fixtures/proxy-runtime.ts";
import { describe, expect, it } from "vitest";
import { executeUiMessages } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiMessageHistory } from "../ui-message-history.ts";
import { readMcpResult } from "../mcp-output-guard.ts";

function completedSession(state: McpExtensionState) {
  const session = state.completedUiSessions[0];
  assert.ok(session);
  return session;
}
function resultRef(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

async function deliveryText(
  result: Awaited<ReturnType<typeof executeUiMessages>>,
): Promise<string> {
  const ref = result.details.resultRef;
  return typeof ref === "string" ? await readFile(ref, "utf8") : firstText(result);
}

function createState(prompts: string[]): McpExtensionState {
  return createTestState({
    completedUiSessions: [
      {
        serverName: "interactive-visualizer",
        toolName: "show_visualization",
        completedAt: new Date("2026-03-12T16:00:00Z"),
        reason: "done",
        messages: {
          prompts,
          notifications: [],
          intents: [],
          contexts: [],
        },
      },
    ],
  });
}

describe("executeUiMessages", () => {
  it.each(["inline", "paged"])(
    "delivers disk-backed %s sessions only once to concurrent callers",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "mcp-ui-concurrent-"));
      try {
        const history = createUiMessageHistory(root);
        history.append("prompts", "deliver once");
        history.append("notifications", "one receipt");
        const historyRef = resultRef(history.messages.historyRef);
        const state = createState([]);
        state.outputDirectory = root;
        state.config = {
          mcpServers: {},
          settings: { outputGuard: mode === "paged" ? { maxBytes: 1000, detailsMaxBytes: 1 } : {} },
        };
        completedSession(state).messages = history.messages;
        const [delivered, empty] = await Promise.all([
          executeUiMessages(state),
          executeUiMessages(state),
        ]);
        expect([delivered.details.sessions, empty.details.sessions]).toEqual([1, 0]);
        expect(delivered.details.cleared).toBe(true);
        expect(firstText(empty)).toBe("No UI session messages available.");
        const ref = delivered.details.resultRef;
        expect(typeof ref === "string").toBe(mode === "paged");
        const text = await deliveryText(delivered);
        expect(text).toContain("deliver once");
        expect(text).toContain("one receipt");
        const retainedRef = typeof ref === "string" ? ref : historyRef;
        expect((await stat(retainedRef)).mode & 0o777).toBe(0o600);
        const retained = await readFile(retainedRef, "utf8");
        const page = await readMcpResult(
          { ref: retainedRef, limit: 30 },
          { outputDirectory: root },
        );
        expect(page.details).toMatchObject({ nextOffset: 30 });
        expect(firstText(page)).toBe(retained.slice(0, 30));
        expect(state.completedUiSessions).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["inline", "paged"])(
    "leaves sessions completed during %s I/O for the next queued caller",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "mcp-ui-arrival-"));
      try {
        const history = createUiMessageHistory(root);
        history.append("prompts", "first session");
        const state = createState([]);
        state.outputDirectory = root;
        state.config = {
          mcpServers: {},
          settings: { outputGuard: mode === "paged" ? { maxBytes: 1000, detailsMaxBytes: 1 } : {} },
        };
        completedSession(state).messages = history.messages;
        const first = executeUiMessages(state);
        state.completedUiSessions.push(completedSession(createState(["arrived during I/O"])));
        const next = executeUiMessages(state);
        const [delivered, arrived] = await Promise.all([first, next]);
        expect([delivered.details.sessions, arrived.details.sessions]).toEqual([1, 1]);
        expect(await deliveryText(delivered)).toContain("first session");
        expect(await deliveryText(delivered)).not.toContain("arrived during I/O");
        expect(await deliveryText(arrived)).toContain("arrived during I/O");
        expect(state.completedUiSessions).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["inline", "empty"],
    ["inline", "valid-prefix"],
    ["paged", "empty"],
    ["paged", "valid-prefix"],
  ])("retains %s sessions when accepted history is truncated to %s", async (mode, truncation) => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-truncated-"));
    try {
      const history = createUiMessageHistory(root);
      history.append("prompts", "accepted first");
      history.append("prompts", "accepted second");
      const historyRef = history.messages.historyRef;
      assert.ok(historyRef !== undefined && historyRef.length > 0);
      const original = await readFile(historyRef, "utf8");
      const state = createState([]);
      state.outputDirectory = root;
      state.config = {
        mcpServers: {},
        settings: { outputGuard: mode === "paged" ? { maxBytes: 1000, detailsMaxBytes: 1 } : {} },
      };
      completedSession(state).messages = history.messages;
      await writeFile(
        historyRef,
        truncation === "empty" ? "" : String(original.split("\n")[0]) + "\n",
      );
      const [failed, queuedFailure] = await Promise.all([
        executeUiMessages(state),
        executeUiMessages(state),
      ]);
      expect(failed).toMatchObject({
        isError: true,
        details: { error: "ui_history_delivery_failed", cleared: false },
      });
      expect(queuedFailure).toMatchObject({
        isError: true,
        details: { error: "ui_history_delivery_failed", cleared: false },
      });
      expect(state.completedUiSessions).toHaveLength(1);
      await writeFile(historyRef, original);
      const recovered = await executeUiMessages(state);
      expect(recovered.details.cleared).toBe(true);
      const delivered =
        typeof recovered.details.resultRef === "string" && recovered.details.resultRef.length > 0
          ? await readFile(resultRef(recovered.details.resultRef), "utf8")
          : recovered.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      expect(delivered).toContain("accepted first");
      expect(delivered).toContain("accepted second");
      expect(state.completedUiSessions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps small disk-backed histories inline with category order and private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-history-"));
    try {
      const history = createUiMessageHistory(root);
      history.append("prompts", "first");
      history.append("notifications", "notice");
      history.append("intents", { intent: "navigate", params: { to: "/home" } });
      history.append("prompts", "second");
      const historyRef = history.messages.historyRef;
      assert.ok(historyRef !== undefined && historyRef.length > 0);
      const state = createState([]);
      state.outputDirectory = root;
      completedSession(state).messages = history.messages;
      const result = await executeUiMessages(state);
      expect(result.details).toMatchObject({
        prompts: ["first", "second"],
        intents: [{ intent: "navigate", params: { to: "/home" } }],
        cleared: true,
      });
      const text = firstText(result);
      expect(text.indexOf("### Prompts")).toBeLessThan(text.indexOf("### Intents"));
      expect(text.indexOf("### Intents")).toBeLessThan(text.indexOf("### Notifications"));
      expect((await stat(historyRef)).mode & 0o777).toBe(0o600);
      expect(history.messages.prompts).toEqual([]);
      expect(state.completedUiSessions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "streams 10,000 retained events and pages the complete receipt without draining on failed delivery",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-ui-large-"));
      try {
        const history = createUiMessageHistory(root);
        for (let i = 0; i < 10_000; i++) {
          history.append("prompts", `event-${i} ${"x".repeat(100)}`);
        }
        expect(history.messages.historyCount).toBe(10_000);
        expect(history.messages.prompts).toHaveLength(0);
        expect(history.messages.historyBytes).toBeGreaterThan(1_000_000);
        const state = createState([]);
        completedSession(state).messages = history.messages;
        const blocked = join(root, "not-a-directory");
        await writeFile(blocked, "blocked");
        state.outputDirectory = blocked;
        const failed = await executeUiMessages(state);
        expect(failed).toMatchObject({ isError: true, details: { cleared: false } });
        expect(state.completedUiSessions).toHaveLength(1);
        state.outputDirectory = root;
        const delivered = await executeUiMessages(state);
        expect(delivered.details.cleared).toBe(true);
        expect(state.completedUiSessions).toEqual([]);
        const ref = resultRef(delivered.details.resultRef);
        const full = await readFile(ref, "utf8");
        expect(full.match(/\n- event-/g)).toHaveLength(10_000);
        expect(full).toContain("event-9999 ");
        const page = await readMcpResult({ ref, limit: 500 }, { outputDirectory: root });
        expect(page.details).toMatchObject({ nextOffset: 500 });
        expect(page.content[0]).toEqual({ type: "text", text: full.slice(0, 500) });
        expect(delivered.details.historyRefs).toEqual([history.messages.historyRef]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      // The same 10,000 real flushes take over 90s on APFS; do not skip durability work.
    },
    process.platform === "darwin" ? 180_000 : 60_000,
  );

  it("retains failed history writes in memory and truthfully reports recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-failure-"));
    try {
      const blocked = join(root, "blocked");
      await writeFile(blocked, "file");
      const history = createUiMessageHistory(blocked);
      expect(history.append("prompts", "recover me")).toContain("remain in memory");
      expect(history.append("notifications", "also recover")).toContain("remain in memory");
      const state = createState([]);
      completedSession(state).messages = history.messages;
      const recovered = await executeUiMessages(state);
      expect(recovered.details.prompts).toEqual(["recover me"]);
      expect(firstText(recovered)).toContain("History persistence warning");
      expect(state.completedUiSessions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes canonical handoff prompts into structured intents", async () => {
    const state = createState([
      'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[{"id":"a1","kind":"pin","text":"Check this"}]}',
    ]);

    const result = await executeUiMessages(state);
    expect(firstText(result)).toContain("visualization_annotations_submitted");
    expect(firstText(result)).not.toContain("### Prompts:\n- visualization_annotations_submitted");
    expect(result.details).toMatchObject({
      intents: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      handoffs: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      cleared: true,
    });
    expect(state.completedUiSessions).toEqual([]);
  });

  it("preserves ordinary prompts as prompts", async () => {
    const state = createState(["Please analyze this flow"]);
    const result = await executeUiMessages(state);
    expect(firstText(result)).toContain("### Prompts:\n- Please analyze this flow");
    expect(result.details).toMatchObject({
      prompts: ["Please analyze this flow"],
      intents: [],
    });
  });

  it("returns submitted model context updates", async () => {
    const state = createState([]);
    completedSession(state).messages.contexts.push({
      payload: { content: [{ type: "text", text: "Selected node A" }] },
      summary: '{"content":[{"type":"text","text":"Selected node A"}]}',
      truncated: false,
    });

    const result = await executeUiMessages(state);

    expect(firstText(result)).toContain(
      '### Context updates:\n- {"content":[{"type":"text","text":"Selected node A"}]}',
    );
    expect(result.details).toMatchObject({
      contexts: [
        {
          payload: { content: [{ type: "text", text: "Selected node A" }] },
          truncated: false,
        },
      ],
      cleared: true,
    });
  });
});
