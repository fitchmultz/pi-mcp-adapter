import { describe, it, expect } from "vitest";
import { createUiModelContextUpdate, parseUiPromptHandoff, type UiSessionMessages } from "../types.ts";

describe("UiSessionMessages", () => {
  describe("model context", () => {
    it("can store bounded model context updates", () => {
      const update = createUiModelContextUpdate({ content: [{ type: "text", text: "selection" }] });
      const messages: UiSessionMessages = {
        prompts: [],
        notifications: [],
        intents: [],
        contexts: update ? [update] : [],
      };

      expect(messages.contexts).toHaveLength(1);
      expect(messages.contexts[0]).toMatchObject({ truncated: false });
      expect(messages.contexts[0]!.summary).toContain("selection");
    });
  });

  describe("named handoff envelopes", () => {
    it("parses canonical intent-newline-json payloads", () => {
      expect(
        parseUiPromptHandoff('visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[]}')
      ).toEqual({
        intent: "visualization_annotations_submitted",
        params: { visualizationId: "flow", annotations: [] },
        raw: 'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[]}',
      });
    });

    it("ignores free-form prompts", () => {
      expect(parseUiPromptHandoff("Please analyze this chart")).toBeUndefined();
      expect(parseUiPromptHandoff("visualization_annotations_submitted {}")).toBeUndefined();
    });
  });
});
