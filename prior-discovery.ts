import { hash } from "node:crypto";
import type { Client, PriorDiscovery } from "@modelcontextprotocol/client";
import type { CachedPriorDiscovery, ServerDefinition } from "./types.ts";
import { CACHE_MAX_AGE_MS } from "./metadata-cache-format.ts";
import {
  hasServerUrl,
  interpolateEnvRecord,
  resolveBearerToken,
  resolveServerUrl,
} from "./utils.ts";

/** Legacy verdicts expire faster so server upgrades to 2026-07-28 are re-probed. */
export const PRIOR_DISCOVERY_LEGACY_TTL_MS = 24 * 60 * 60 * 1000;
/** Modern verdicts match the metadata cache horizon; stale modern verdicts fail fast on first request. */
export const PRIOR_DISCOVERY_MODERN_TTL_MS = CACHE_MAX_AGE_MS;

export function safeResolveServerUrl(definition: ServerDefinition): string | undefined {
  try {
    const resolved = resolveServerUrl(definition);
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function supportsPriorDiscovery(definition: ServerDefinition): boolean {
  return hasServerUrl(definition) && definition.protocolVersion !== "legacy";
}

/**
 * Scope cached era verdicts to exact server URL and auth/header context.
 * Uses unexecuted secret expressions so reading/caching never runs `!command` markers.
 */
export function computePriorDiscoveryKey(definition: ServerDefinition): string | undefined {
  if (!supportsPriorDiscovery(definition)) {
    return undefined;
  }
  const url = safeResolveServerUrl(definition);
  if (url === undefined) {
    return undefined;
  }
  const headers = interpolateEnvRecord(definition.headers);
  const sortedHeaders = headers
    ? Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))
    : undefined;
  return hash(
    "sha256",
    JSON.stringify([
      url,
      definition.auth,
      sortedHeaders,
      resolveBearerToken(definition),
      definition.bearerTokenEnv,
      definition.oauth,
      definition.protocolVersion,
    ]),
    "hex",
  );
}

export function isPriorDiscoveryFresh(entry: CachedPriorDiscovery, now = Date.now()): boolean {
  if (!Number.isFinite(entry.cachedAt) || entry.cachedAt <= 0 || entry.cachedAt > now) {
    return false;
  }
  const maxAge =
    entry.kind === "legacy" ? PRIOR_DISCOVERY_LEGACY_TTL_MS : PRIOR_DISCOVERY_MODERN_TTL_MS;
  return now - entry.cachedAt <= maxAge;
}

export function toSdkPriorDiscovery(entry: CachedPriorDiscovery): PriorDiscovery {
  return entry.kind === "modern"
    ? { kind: "modern", discover: entry.discover }
    : { kind: "legacy" };
}

/**
 * Capture a persistable era verdict from a connected HTTP client.
 * Preserves `cachedAt` when reusing a prior legacy verdict so its freshness horizon does not drift.
 */
export function capturePriorDiscovery(
  client: Client,
  reusedPrior?: CachedPriorDiscovery,
  now = Date.now(),
): CachedPriorDiscovery | undefined {
  const era = client.getProtocolEra();
  if (era === "modern") {
    const discover = client.getDiscoverResult();
    if (!discover) {
      return undefined;
    }
    return {
      kind: "modern",
      discover,
      cachedAt: reusedPrior?.kind === "modern" ? reusedPrior.cachedAt : now,
    };
  }
  if (era === "legacy") {
    return {
      kind: "legacy",
      cachedAt: reusedPrior?.kind === "legacy" ? reusedPrior.cachedAt : now,
    };
  }
  return undefined;
}

export class PriorDiscoveryCache {
  private readonly entries = new Map<string, { key: string; entry: CachedPriorDiscovery }>();

  seed(name: string, definition: ServerDefinition, entry: CachedPriorDiscovery): void {
    const key = computePriorDiscoveryKey(definition);
    if (key === undefined || !isPriorDiscoveryFresh(entry)) {
      return;
    }
    this.entries.set(name, { key, entry });
  }

  get(name: string, definition: ServerDefinition): CachedPriorDiscovery | undefined {
    const key = computePriorDiscoveryKey(definition);
    if (key === undefined) {
      return undefined;
    }
    const stored = this.entries.get(name);
    if (!stored || stored.key !== key) {
      return undefined;
    }
    if (!isPriorDiscoveryFresh(stored.entry)) {
      this.entries.delete(name);
      return undefined;
    }
    return stored.entry;
  }

  record(name: string, definition: ServerDefinition, entry: CachedPriorDiscovery): void {
    const key = computePriorDiscoveryKey(definition);
    if (key === undefined) {
      return;
    }
    this.entries.set(name, { key, entry });
  }

  invalidate(name: string): void {
    this.entries.delete(name);
  }
}
