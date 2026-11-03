import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";
import type { ServerStreamResultPatchNotification } from "../ui-stream-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleDist = join(__dirname, "..", "examples", "interactive-visualizer", "dist");

describe("interactive visualizer", () => {
  it.each([
    { datasets: [{ label: "Test", data: [1] }] },
    {
      datasets: [
        { label: "Test", data: [1] },
        { label: "Second", data: [2], color: "#3f6771" },
      ],
    },
  ])("streams chart notifications from the built v2 server: $datasets", async ({ datasets }) => {
    const manager = new McpServerManager();
    const frames: unknown[] = [];
    manager.registerUiStreamListener("example-stream", (_name, frame) => frames.push(frame));
    try {
      const connection = await manager.connect("example", {
        command: process.execPath,
        args: [join(exampleDist, "server.js")],
      });
      const result = await connection.client.callTool({
        name: "show_chart",
        arguments: {
          type: "bar",
          title: "Local test",
          labels: "A",
          datasets: JSON.stringify(datasets),
        },
        _meta: { "pi-mcp-adapter/stream-token": "example-stream" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ chart: { title: "Local test" } });
      expect(frames).toHaveLength(datasets.length);
      expect(frames).toEqual(
        datasets.map((_dataset, index) => ({
          streamToken: "example-stream",
          result: {
            content: [{ type: "text", text: `Dataset ${index + 1}/${datasets.length}` }],
            structuredContent: {
              "pi-mcp-adapter/stream": {
                frameType: index === datasets.length - 1 ? "final" : "patch",
                phase: index === datasets.length - 1 ? "settled" : "structure",
                status: "ok",
              },
              chart: {
                type: "bar",
                title: "Local test",
                labels: ["A"],
                datasets: datasets.slice(0, index + 1),
              },
            },
          },
        })),
      );
      const resource = await connection.client.readResource({
        uri: "ui://interactive-visualizer/app.html",
      });
      expect(resource.contents).toEqual([
        {
          uri: "ui://interactive-visualizer/app.html",
          mimeType: "text/html;profile=mcp-app",
          text: readFileSync(join(exampleDist, "app.html"), "utf-8"),
        },
      ]);
    } finally {
      await manager.closeAll();
    }
  });

  it("streams all adventure tiers and preserves choice nodes in the final SVG", async () => {
    const manager = new McpServerManager();
    const frames: ServerStreamResultPatchNotification["params"][] = [];
    manager.registerUiStreamListener("adventure-stream", (_name, frame) => frames.push(frame));
    try {
      const connection = await manager.connect("example", {
        command: process.execPath,
        args: [join(exampleDist, "server.js")],
      });
      const result = await connection.client.callTool({
        name: "stream_adventure",
        arguments: {},
        _meta: { "pi-mcp-adapter/stream-token": "adventure-stream" },
      });
      expect(result.isError).not.toBe(true);
      expect(frames).toHaveLength(6);
      expect(frames.map((frame) => frame.result.content)).toEqual(
        [1, 2, 3, 4, 5, 6].map((tier) => [{ type: "text", text: `Tier ${tier}/6` }]),
      );
      expect(frames[0]?.result.structuredContent).toMatchObject({
        "pi-mcp-adapter/stream": { frameType: "patch", phase: "structure", status: "ok" },
      });
      expect(frames[0]?.result.structuredContent?.svg).toContain("You find a locked door");
      expect(frames[0]?.result.structuredContent?.svg).not.toContain('data-choice="pick"');
      expect(frames[1]?.result.structuredContent?.svg).toContain('data-choice="pick"');
      expect(frames[5]?.result.structuredContent).toMatchObject({
        "pi-mcp-adapter/stream": { frameType: "final", phase: "settled", status: "ok" },
      });
      expect(frames[5]?.result.structuredContent?.svg).toContain('data-choice="hide"');
      expect(result.structuredContent).toEqual({
        svg: frames[5]?.result.structuredContent?.svg,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Adventure tree complete. Click a choice to tell the agent your decision.",
        },
      ]);
    } finally {
      await manager.closeAll();
    }
  });

  it("dist/app.html exists and contains chart.js", () => {
    const html = readFileSync(join(exampleDist, "app.html"), "utf-8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("chart.js");
    expect(html).toContain('<div id="app">');
  });

  it("emits the Node shebang for the built server", () => {
    const server = readFileSync(join(exampleDist, "server.js"), "utf-8");
    expect(server.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
