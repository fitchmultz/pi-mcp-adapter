import { describe, expect, it } from "vitest";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildToolMetadata } from "../tool-metadata.ts";
import type { McpTool } from "../types.ts";

const metadataCases: Array<[string, McpTool["_meta"]]> = [
  ["absent metadata", undefined],
  // @ts-expect-error SDK tool metadata is an optional record, never null.
  ["null metadata", null],
  ["empty metadata", {}],
  ["new key", { ui: { resourceUri: "ui://new" } }],
  ["legacy key", { "ui/resourceUri": "ui://legacy" }],
  ["empty UI URI accepted by the SDK", { ui: { resourceUri: "ui://" } }],
  ["new wins over legacy", { ui: { resourceUri: "ui://new" }, "ui/resourceUri": "ui://legacy" }],
  ["new wins over malformed legacy", { ui: { resourceUri: "ui://new" }, "ui/resourceUri": null }],
  ["undefined new falls back", { ui: { resourceUri: undefined }, "ui/resourceUri": "ui://legacy" }],
  ["null UI object falls back", { ui: null, "ui/resourceUri": "ui://legacy" }],
  ["malformed UI object falls back", { ui: "invalid", "ui/resourceUri": "ui://legacy" }],
  ["absent new key falls back", { ui: {}, "ui/resourceUri": "ui://legacy" }],
  ["malformed UI object without legacy", { ui: 42 }],
  [
    "null new is invalid, not a fallback",
    { ui: { resourceUri: null }, "ui/resourceUri": "ui://legacy" },
  ],
  [
    "invalid new does not fall back",
    { ui: { resourceUri: "https://invalid" }, "ui/resourceUri": "ui://legacy" },
  ],
  ["empty new does not fall back", { ui: { resourceUri: "" }, "ui/resourceUri": "ui://legacy" }],
  [
    "non-string new does not fall back",
    { ui: { resourceUri: false }, "ui/resourceUri": "ui://legacy" },
  ],
  ["array new is invalid", { ui: { resourceUri: ["ui://invalid"] } }],
  ["object new is invalid", { ui: { resourceUri: { uri: "ui://invalid" } } }],
  ["case-sensitive URI scheme", { ui: { resourceUri: "UI://invalid" } }],
  ["null legacy is invalid", { "ui/resourceUri": null }],
  ["empty legacy is invalid", { "ui/resourceUri": "" }],
  ["invalid legacy scheme", { "ui/resourceUri": "https://invalid" }],
  ["non-string legacy is invalid", { "ui/resourceUri": 42 }],
];

describe("canonical tool catalog", () => {
  it.each(metadataCases)("matches the official UI resource extraction: %s", (_name, meta) => {
    const tool: McpTool = { name: "ui_tool", _meta: meta };
    let expectedUri: string | undefined;
    let invalid = false;
    try {
      expectedUri = getToolUiResourceUri(tool);
    } catch {
      invalid = true;
    }
    const { metadata, failedTools } = buildToolMetadata({
      tools: [tool],
      resources: [],
      definition: {},
      serverName: "demo",
      prefix: "server",
    });
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.uiResourceUri).toBe(expectedUri);
    expect(failedTools).toEqual(invalid ? ["ui_tool"] : []);
  });
});
