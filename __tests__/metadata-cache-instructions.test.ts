import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMetadataCachePath, loadMetadataCache, reconstructToolMetadata, saveMetadataCache, type ServerCacheEntry } from "../metadata-cache.ts";

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
    expect(reconstructToolMetadata("legacy", loaded!.servers.legacy!, "server", {})).toEqual([]);

    const modern = { ...entry, tools: [{ name: "app_only", _meta: { ui: { visibility: ["app"] } } }] };
    saveMetadataCache({ version: 1, servers: { modern } });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.version).toBe(2);
    expect(loadMetadataCache()?.servers).toEqual({ legacy: entry, modern });
    expect(reconstructToolMetadata("modern", stored.servers.modern, "server", {})).toEqual([]);
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

    expect(loadMetadataCache()?.servers.demo.instructions).toBe(
      "The available skills are listed in this server's instructions.",
    );
  });

  it("omits instructions from the cache file when a server provides none", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      tools: [],
      resources: [],
      instructions: undefined,
      cachedAt: Date.now(),
    };

    saveMetadataCache({ version: 1, servers: { demo: entry } });

    expect("instructions" in (loadMetadataCache()?.servers.demo ?? {})).toBe(false);
  });
});
