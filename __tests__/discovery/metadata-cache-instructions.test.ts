import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  getMetadataCachePath,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  type ServerCacheEntry,
} from "../../metadata-cache.ts";
import { updateMetadataCache } from "../../init.ts";
import { McpServerManager } from "../../server-manager.ts";
import { createTestState } from "../test-state.ts";

describe("metadata cache instructions", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads legacy records and writes raw descriptors with a new format version", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      cachedAt: Date.now(),
      tools: [{ name: "app_only", uiVisibility: ["app"] }],
      resources: [],
    };
    const path = getMetadataCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, servers: { legacy: entry } }));
    const loaded = loadMetadataCache();
    expect(loaded?.servers.legacy).toEqual(entry);
    assert.ok(loaded?.servers.legacy);
    expect(reconstructToolMetadata("legacy", loaded.servers.legacy, "server", {})).toEqual([]);

    const modern = {
      ...entry,
      tools: [{ name: "app_only", _meta: { ui: { visibility: ["app"] } } }],
    };
    saveMetadataCache({ version: 1, servers: { modern } });
    const stored = z
      .object({ version: z.number(), servers: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(readFileSync(path, "utf8")));
    expect(stored.version).toBe(2);
    expect(stored.servers.modern).toEqual(modern);
    expect(loadMetadataCache()?.servers).toEqual({ legacy: entry, modern });
    const modernEntry = loadMetadataCache()?.servers.modern;
    assert.ok(modernEntry);
    expect(reconstructToolMetadata("modern", modernEntry, "server", {})).toEqual([]);
  });

  it("round-trips server instructions through the cache file", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      tools: [],
      resources: [],
      instructions: "The available skills are listed in this server's instructions.",
      cachedAt: Date.now(),
    };

    saveMetadataCache({ version: 1, servers: { demo: entry } });

    expect(loadMetadataCache()?.servers.demo?.instructions).toBe(
      "The available skills are listed in this server's instructions.",
    );
  });

  it("omits instructions from the cache file when a server provides none", async () => {
    const fixture = fileURLToPath(new URL("../fixtures/mcp-code-server.mjs", import.meta.url));
    const definition = {
      command: process.execPath,
      args: [fixture],
      env: { MCP_TEST_INSTRUCTIONS: "" },
    };
    const manager = new McpServerManager();
    const state = createTestState({
      manager,
      metadataCacheEnabled: true,
      config: { mcpServers: { demo: definition }, settings: {} },
    });
    try {
      const connection = await manager.connect("demo", definition);
      expect(connection.instructions).toBeUndefined();
      updateMetadataCache(state, "demo");
      const entry = loadMetadataCache()?.servers.demo;
      assert.ok(entry);
      expect("instructions" in entry).toBe(false);
    } finally {
      await manager.closeAll();
      await state.owner.stop("test cleanup");
    }
  });
});
