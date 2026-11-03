import type { MetadataCache, ServerCacheEntry } from "./types.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import { cacheEntryValidator } from "./metadata-cache-validator.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return asObjectRecord(value) !== undefined && !Array.isArray(value);
}

// Check preserves raw records without loading SDK/Zod or stripping extensions.
export const isCacheEntry: (entry: unknown) => entry is ServerCacheEntry =
  cacheEntryValidator.Check.bind(cacheEntryValidator);

export function readCacheEnvelope(
  raw: unknown,
): { version: number; servers: Record<string, unknown> } | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !isRecord(raw.servers)) {
    return null;
  }
  return { version: raw.version, servers: raw.servers };
}

export function projectMetadataCache(raw: unknown): MetadataCache | null {
  const envelope = readCacheEnvelope(raw);
  if (!envelope) {
    return null;
  }
  const servers: Array<[string, ServerCacheEntry]> = [];
  for (const [name, entry] of Object.entries(envelope.servers)) {
    if (isCacheEntry(entry)) {
      servers.push([name, entry]);
    }
  }
  return { version: envelope.version, servers: Object.fromEntries(servers) };
}
