import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { computeServerHash, getMetadataCachePath, isServerCacheValid, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";

const week = 7 * 86400000;
const definition = { command: "synthetic-server" };
const entry = (cachedAt = Date.now()) => ({ configHash: computeServerHash(definition), cachedAt, tools: [{ name: "search" }], resources: [] });
let root: string;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-cache-lifetime-"));
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(dirname(getMetadataCachePath()), { recursive: true });
});
afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("metadata cache lifetime", () => {
  it("prunes expired merged records while retaining selected servers and unrecognized data", () => {
    const stale = entry(Date.now() - week - 1000);
    const unknown = { futureFormat: true, cachedAt: stale.cachedAt };
    writeFileSync(getMetadataCachePath(), JSON.stringify({ version: 2, servers: {
      "recovery-old": stale, old: stale, selected: stale, recent: entry(), unknown,
    } }));
    saveMetadataCache({ version: 2, servers: { current: entry() } }, true, ["selected"]);
    const stored = JSON.parse(readFileSync(getMetadataCachePath(), "utf8"));
    expect(Object.keys(stored.servers).sort()).toEqual(["current", "recent", "selected", "unknown"]);
    expect(stored.servers.selected).toEqual(stale);
    expect(stored.servers.unknown).toEqual(unknown);
    expect(isServerCacheValid(stored.servers.selected, definition)).toBe(false);
  });

  it("rereads another process's merge rather than overwriting it with a retained snapshot", () => {
    saveMetadataCache({ version: 2, servers: { first: entry() } });
    expect(loadMetadataCache()?.servers.first?.tools[0]?.name).toBe("search");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { saveMetadataCache } from ${JSON.stringify(new URL("../metadata-cache.ts", import.meta.url).href)};
      saveMetadataCache(${JSON.stringify({ version: 2, servers: { external: entry() } })});
    `], { encoding: "utf8", env: process.env });
    expect(child.status, child.stderr).toBe(0);
    saveMetadataCache({ version: 2, servers: { last: entry() } });
    expect(Object.keys(loadMetadataCache()!.servers).sort()).toEqual(["external", "first", "last"]);
    expect(JSON.parse(readFileSync(getMetadataCachePath(), "utf8")).servers.external.tools[0].name).toBe("search");
  });

  it("observes atomic replacement even with an unchanged size and mtime, deletion, repair, and disabled reads", () => {
    const path = getMetadataCachePath();
    const first = JSON.stringify({ version: 2, servers: { one: entry() } });
    const second = first.replace('"one"', '"two"');
    const timestamp = new Date("2026-01-01T00:00:00Z");
    writeFileSync(path, first);
    utimesSync(path, timestamp, timestamp);
    expect(loadMetadataCache()?.servers.one).toBeDefined();
    writeFileSync(`${path}.replacement`, second);
    utimesSync(`${path}.replacement`, timestamp, timestamp);
    renameSync(`${path}.replacement`, path);
    expect(loadMetadataCache()?.servers.one).toBeUndefined();
    expect(loadMetadataCache()?.servers.two).toBeDefined();
    expect(loadMetadataCache(false)).toBeNull();
    unlinkSync(path);
    expect(loadMetadataCache()).toBeNull();
    writeFileSync(path, "invalid json");
    expect(loadMetadataCache()).toBeNull();
    writeFileSync(path, second);
    expect(loadMetadataCache()?.servers.two).toBeDefined();
  });

  it("does not share snapshots across agent directories", () => {
    saveMetadataCache({ version: 2, servers: { original: entry() } });
    expect(loadMetadataCache()?.servers.original).toBeDefined();
    process.env.PI_CODING_AGENT_DIR = join(root, "other");
    saveMetadataCache({ version: 2, servers: { other: entry() } });
    expect(Object.keys(loadMetadataCache()!.servers)).toEqual(["other"]);
    process.env.PI_CODING_AGENT_DIR = root;
    expect(Object.keys(loadMetadataCache()!.servers)).toEqual(["original"]);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0, Date.now() + week])("rejects invalid cachedAt %s", cachedAt => {
    expect(isServerCacheValid(entry(cachedAt), definition)).toBe(false);
  });

  it("rejects recognized records with malformed descriptor collections", () => {
    expect(isServerCacheValid({ ...entry(), tools: "bad" } as never, definition)).toBe(false);
    expect(isServerCacheValid({ ...entry(), resources: {} } as never, definition)).toBe(false);
  });
});
