import { describe, expect, it } from "vitest";
import { executeUiMessages } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiMessageHistory } from "../ui-message-history.ts";
import { readMcpResult } from "../mcp-output-guard.ts";

function createState(prompts: string[]): McpExtensionState {
  return {
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
  } as unknown as McpExtensionState;
}

describe("executeUiMessages", () => {
  it("keeps small disk-backed histories inline with category order and private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-history-"));
    try {
      const history = createUiMessageHistory(root);
      history.append("prompts", "first");
      history.append("notifications", "notice");
      history.append("intents", { intent: "navigate", params: { to: "/home" } });
      history.append("prompts", "second");
      const state = createState([]);
      state.outputDirectory = root;
      state.completedUiSessions[0]!.messages = history.messages;
      const result = await executeUiMessages(state);
      expect(result.details).toMatchObject({ prompts: ["first", "second"], intents: [{ intent: "navigate", params: { to: "/home" } }], cleared: true });
      const block = result.content[0]!;
      const text = block.type === "text" ? block.text : "";
      expect(text.indexOf("### Prompts")).toBeLessThan(text.indexOf("### Intents"));
      expect(text.indexOf("### Intents")).toBeLessThan(text.indexOf("### Notifications"));
      expect((await stat(history.messages.historyRef!)).mode & 0o777).toBe(0o600);
      expect(history.messages.prompts).toEqual([]);
      expect(state.completedUiSessions).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("streams 10,000 retained events and pages the complete receipt without draining on failed delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-large-"));
    try {
      const history = createUiMessageHistory(root);
      for (let i = 0; i < 10_000; i++) history.append("prompts", `event-${i} ${"x".repeat(100)}`);
      expect(history.messages.historyCount).toBe(10_000);
      expect(history.messages.prompts).toHaveLength(0);
      expect(history.messages.historyBytes).toBeGreaterThan(1_000_000);
      const state = createState([]);
      state.completedUiSessions[0]!.messages = history.messages;
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
      const ref = delivered.details.resultRef as string;
      const full = await readFile(ref, "utf8");
      expect(full.match(/\n- event-/g)).toHaveLength(10_000);
      expect(full).toContain("event-9999 ");
      const page = await readMcpResult({ ref, limit: 500 }, { outputDirectory: root });
      expect(page.details).toMatchObject({ nextOffset: 500 });
      expect(page.content[0]).toEqual({ type: "text", text: full.slice(0, 500) });
      expect(delivered.details.historyRefs).toEqual([history.messages.historyRef]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("retains failed history writes in memory and truthfully reports recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-failure-"));
    try {
      const blocked = join(root, "blocked"); await writeFile(blocked, "file");
      const history = createUiMessageHistory(blocked);
      expect(history.append("prompts", "recover me")).toContain("remain in memory");
      expect(history.append("notifications", "also recover")).toContain("remain in memory");
      const state = createState([]);
      state.completedUiSessions[0]!.messages = history.messages;
      const recovered = await executeUiMessages(state);
      expect(recovered.details.prompts).toEqual(["recover me"]);
      expect(recovered.content[0]).toMatchObject({ text: expect.stringContaining("History persistence warning") });
      expect(state.completedUiSessions).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("normalizes canonical handoff prompts into structured intents", async () => {
    const state = createState([
      'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[{"id":"a1","kind":"pin","text":"Check this"}]}',
    ]);

    const result = await executeUiMessages(state);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("visualization_annotations_submitted"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.not.stringContaining("### Prompts:\n- visualization_annotations_submitted"),
    });
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
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("### Prompts:\n- Please analyze this flow"),
    });
    expect(result.details).toMatchObject({
      prompts: ["Please analyze this flow"],
      intents: [],
    });
  });

  it("returns submitted model context updates", async () => {
    const state = createState([]);
    state.completedUiSessions[0]!.messages.contexts.push({
      payload: { content: [{ type: "text", text: "Selected node A" }] },
      summary: '{"content":[{"type":"text","text":"Selected node A"}]}',
      truncated: false,
    });

    const result = await executeUiMessages(state);

    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("### Context updates:\n- {\"content\":[{\"type\":\"text\",\"text\":\"Selected node A\"}]}"),
    });
    expect(result.details).toMatchObject({
      contexts: [{
        payload: { content: [{ type: "text", text: "Selected node A" }] },
        truncated: false,
      }],
      cleared: true,
    });
  });
});
