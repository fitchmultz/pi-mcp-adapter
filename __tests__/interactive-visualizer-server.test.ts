import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("interactive visualizer", () => {
  it("streams chart notifications from the built v2 server", async () => {
    const manager = new McpServerManager();
    const frames: unknown[] = [];
    manager.registerUiStreamListener("example-stream", (_name, frame) => frames.push(frame));
    try {
      const connection = await manager.connect("example", {
        command: process.execPath,
        args: [join(__dirname, "..", "examples", "interactive-visualizer", "dist", "server.js")],
      });
      const result = await connection.client.callTool({
        name: "show_chart",
        arguments: { type: "bar", title: "Local test", labels: "A", datasets: '[{"label":"Test","data":[1]}]' },
        _meta: { "pi-mcp-adapter/stream-token": "example-stream" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ chart: { title: "Local test" } });
      expect(frames).toHaveLength(1);
    } finally {
      await manager.closeAll();
    }
  });

  it("dist/app.html exists and contains chart.js", () => {
    const html = readFileSync(
      join(__dirname, "..", "examples", "interactive-visualizer", "dist", "app.html"),
      "utf-8",
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("chart.js");
    expect(html).toContain('<div id="app">');
  });

  it("dist/server.js exists and is executable", () => {
    const server = readFileSync(
      join(__dirname, "..", "examples", "interactive-visualizer", "dist", "server.js"),
      "utf-8",
    );
    expect(server).toContain("#!/usr/bin/env node");
    expect(server).toContain("show_chart");
    expect(server).toContain("interactive-visualizer");
  });
});
