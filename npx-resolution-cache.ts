import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asObjectRecord } from "./mcp-output-values.ts";
import { getAdapterPath } from "./agent-dir.ts";
import { StorageLockBusyError, withStorageLock } from "./storage-lock.ts";

export interface NpxCacheEntry {
  resolvedBin: string;
  resolvedAt: number;
  packageVersion?: string;
  isJs: boolean;
}

function readEntries(path: string): Record<string, unknown> {
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      const envelope = asObjectRecord(raw);
      const entries = asObjectRecord(envelope?.entries);
      if (envelope?.version === 1 && entries && !Array.isArray(envelope.entries)) {
        return entries;
      }
    }
  } catch {
    // Missing or malformed cache data falls back to npm's own cache.
  }
  return {};
}

export function loadCacheEntry(key: string): NpxCacheEntry | undefined {
  const entries = readEntries(getAdapterPath("mcp-npx-cache.json"));
  const entry = asObjectRecord(entries[key]);
  if (
    !entry ||
    typeof entry.resolvedBin !== "string" ||
    typeof entry.resolvedAt !== "number" ||
    typeof entry.isJs !== "boolean"
  ) {
    return undefined;
  }
  if (entry.packageVersion !== undefined && typeof entry.packageVersion !== "string") {
    return undefined;
  }
  return {
    resolvedBin: entry.resolvedBin,
    resolvedAt: entry.resolvedAt,
    isJs: entry.isJs,
    ...(entry.packageVersion !== undefined ? { packageVersion: entry.packageVersion } : {}),
  };
}

export function saveCacheEntry(key: string, entry: NpxCacheEntry): "saved" | "busy" {
  const cachePath = getAdapterPath("mcp-npx-cache.json");
  mkdirSync(dirname(cachePath), { recursive: true });
  try {
    withStorageLock(`${cachePath}.lock.sqlite`, () => {
      const entries = { ...readEntries(cachePath), [key]: entry };
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ version: 1, entries }, null, 2), "utf-8");
      renameSync(tmpPath, cachePath);
    });
    return "saved";
  } catch (error) {
    if (error instanceof StorageLockBusyError) {
      return "busy";
    }
    throw error;
  }
}
