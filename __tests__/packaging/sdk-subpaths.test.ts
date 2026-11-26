import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getMcpDiscoverySummary,
  getServerProvenance,
  loadMcpConfig,
} from "../../public-runtime.ts";

describe("SDK subpath packaging guarantees", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports built @fitchmultz/pi-mcp-adapter/types in a cold Node process without loading zod", () => {
    const distTypesUrl = pathToFileURL(resolve("dist/public-types.js")).href;
    const loaderScript = `
      import { registerHooks } from "node:module";
      const loaded = [];
      registerHooks({
        resolve(specifier, context, nextResolve) {
          loaded.push(specifier);
          if (specifier === "zod" || specifier.startsWith("zod/")) {
            throw new Error("Unexpected zod import: " + specifier);
          }
          return nextResolve(specifier, context);
        },
      });
      const mod = await import(${JSON.stringify(distTypesUrl)});
      if (typeof mod.MCP_STATUS_EVENT !== "string") throw new Error("Missing MCP_STATUS_EVENT");
      if (typeof mod.isToolAllowed !== "function") throw new Error("Missing isToolAllowed");
      if (typeof mod.SERVER_STREAM_RESULT_PATCH_METHOD !== "string") {
        throw new Error("Missing SERVER_STREAM_RESULT_PATCH_METHOD");
      }
      if ("McpConfigSchema" in mod || "ServerEntrySchema" in mod || "parseMcpConfig" in mod) {
        throw new Error("Unexpected runtime Zod schema export on /types");
      }
      console.log(JSON.stringify({ event: mod.MCP_STATUS_EVENT, exports: Object.keys(mod).sort(), loaded }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", loaderScript], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed = z
      .object({
        event: z.string(),
        exports: z.array(z.string()),
        loaded: z.array(z.string()),
      })
      .parse(JSON.parse(result.stdout));
    expect(parsed.event).toBe("fitch-mcp-adapter/status/v1");
    expect(
      parsed.loaded.some((specifier) => specifier === "zod" || specifier.startsWith("zod/")),
    ).toBe(false);
  });

  it("exports loadMcpConfig, getMcpDiscoverySummary, and getServerProvenance from /runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-sdk-runtime-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } }),
      "utf8",
    );

    const prevHome = process.env.HOME;
    const prevAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = loadMcpConfig(undefined, project);
      expect(config.mcpServers.docs?.url).toBe("https://docs.example.com/mcp");
      const summary = getMcpDiscoverySummary(undefined, project);
      expect(
        summary.sources.some(
          (s) => s.path === join(project, ".mcp.json") && s.exists && s.serverCount === 1,
        ),
      ).toBe(true);
      const provenance = getServerProvenance(undefined, project).get("docs");
      expect(provenance?.kind).toBe("project");
      expect(provenance?.path).toBe(join(project, ".pi", "fitch-mcp-adapter", "mcp.json"));
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevAgent === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = prevAgent;
      }
    }
  });
});
