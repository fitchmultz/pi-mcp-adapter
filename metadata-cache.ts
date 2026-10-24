// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getAdapterPath } from "./agent-dir.ts";
import { createHash } from "node:crypto";
import type {
  CachedPrompt,
  CachedResource,
  CachedTool,
  McpConfig,
  McpTool,
  McpResource,
  McpPrompt,
  McpPromptArgument,
  MetadataCache,
  ServerCacheEntry,
  ServerEntry,
  ToolMetadata,
  PromptMetadata,
} from "./types.ts";
import { formatPromptCommandName, isServerDisabled, resolveToolPrefix, type ToolPrefix } from "./types.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import {
  interpolateEnvRecord,
  resolveBearerToken,
  resolveConfigPath,
  resolveServerUrl,
} from "./utils.ts";

// Version 2 stores raw descriptors; version 1 readers cannot enforce raw UI visibility.
const CACHE_VERSION = 2;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let snapshot: { path: string; revision: string; cache: MetadataCache | null } | undefined;
const toolProjections = new WeakMap<ServerCacheEntry, { key: string; metadata: ToolMetadata[] }>();

function cacheRevision(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function freezeMetadata<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";

export function getMetadataCachePath(): string {
  return getAdapterPath("mcp-cache.json");
}

export function loadMetadataCache(enabled = true): MetadataCache | null {
  if (!enabled) return null;
  const cachePath = getMetadataCachePath();
  try {
    const revision = cacheRevision(cachePath);
    if (snapshot?.path === cachePath && snapshot.revision === revision) return snapshot.cache;
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    const cache = raw && typeof raw === "object" && !Array.isArray(raw)
      && (raw.version === 1 || raw.version === CACHE_VERSION)
      && raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers)
      ? freezeMetadata(raw as MetadataCache) : null;
    // A concurrent rename must not associate the old bytes with the new file's revision.
    snapshot = cacheRevision(cachePath) === revision ? { path: cachePath, revision, cache } : undefined;
    return cache;
  } catch {
    snapshot = undefined;
    return null;
  }
}

export function saveMetadataCache(cache: MetadataCache, enabled = true, selectedServers: Iterable<string> = []): void {
  if (!enabled) return;
  const cachePath = getMetadataCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  let merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
  try {
    if (existsSync(cachePath)) {
      const existing = JSON.parse(readFileSync(cachePath, "utf-8")) as MetadataCache;
      if (existing && (existing.version === 1 || existing.version === CACHE_VERSION) && existing.servers) {
        merged.servers = { ...existing.servers };
      }
    }
  } catch {
    // Ignore parse errors and proceed with empty cache
  }

  merged.version = CACHE_VERSION;
  merged.servers = { ...merged.servers, ...cache.servers };
  const protectedServers = new Set([...selectedServers, ...Object.keys(cache.servers)]);
  const now = Date.now();
  for (const [name, entry] of Object.entries(merged.servers)) {
    if (!protectedServers.has(name) && isCacheEntry(entry)
      && (entry.cachedAt > now || now - entry.cachedAt > CACHE_MAX_AGE_MS)) {
      delete merged.servers[name];
    }
  }

  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

export function computeServerHash(definition: ServerEntry): string {
  // Hash only fields that affect server identity and tool/resource output.
  // Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
  // that don't change which tools a server exposes.
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    socket: resolveConfigPath(definition.socket),
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: resolveServerUrl(definition),
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    includeTools: definition.includeTools,
    excludeTools: definition.excludeTools,
  };
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

export function isServerCacheValid(
  entry: ServerCacheEntry,
  definition: ServerEntry,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): boolean {
  let configHash: string;
  try {
    configHash = computeServerHash(definition);
  } catch {
    return false;
  }
  if (!isCacheEntry(entry) || entry.configHash !== configHash) return false;
  if (entry.cachedAt > Date.now()) return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

function isCacheEntry(entry: unknown): entry is ServerCacheEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Partial<ServerCacheEntry>;
  return typeof value.configHash === "string"
    && typeof value.cachedAt === "number" && Number.isFinite(value.cachedAt) && value.cachedAt > 0
    && Array.isArray(value.tools) && Array.isArray(value.resources)
    && (value.prompts === undefined || Array.isArray(value.prompts))
    && (value.instructions === undefined || typeof value.instructions === "string");
}

export function parseDirectToolSelectors(selectors: string[]): {
  servers: Set<string>;
  tools: Map<string, Set<string>>;
} {
  const servers = new Set<string>();
  const tools = new Map<string, Set<string>>();

  for (let selector of selectors) {
    selector = selector.replace(/\/+$/, "");
    if (selector.includes("/")) {
      const [server, tool] = selector.split("/", 2);
      if (server && tool) {
        const serverTools = tools.get(server) ?? new Set<string>();
        serverTools.add(tool);
        tools.set(server, serverTools);
      } else if (server) {
        servers.add(server);
      }
    } else if (selector) {
      servers.add(selector);
    }
  }

  return { servers, tools };
}

export function getMissingConfiguredDirectToolServers(
  config: McpConfig,
  cache: MetadataCache | null,
  envOverride?: string[],
): string[] {
  const missing: string[] = [];
  const globalDirect = config.settings?.directTools;
  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const hasDirectTools = envSelection
      ? envSelection.servers.has(serverName) || envSelection.tools.has(serverName)
      : definition.directTools !== undefined
        ? !!definition.directTools
        : !!globalDirect;

    if (!hasDirectTools) continue;

    const serverCache = cache?.servers?.[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) {
      missing.push(serverName);
    }
  }

  return missing;
}

export function reconstructToolMetadata(
  serverName: string,
  entry: ServerCacheEntry,
  prefix: ToolPrefix,
  definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix" | "disabled">
): ToolMetadata[] {
  const key = JSON.stringify([serverName, prefix, definition.exposeResources, definition.includeTools,
    definition.excludeTools, definition.toolPrefix, definition.disabled]);
  const previous = toolProjections.get(entry);
  if (Object.isFrozen(entry) && previous?.key === key) return previous.metadata;
  const metadata = buildToolMetadata(
    (entry.tools ?? []).filter(tool => tool?.name).map(restoreCachedTool),
    entry.resources ?? [],
    definition,
    serverName,
    prefix,
  ).metadata;
  if (Object.isFrozen(entry)) toolProjections.set(entry, { key, metadata: freezeMetadata(metadata) });
  return metadata;
}

function restoreCachedTool(tool: CachedTool): McpTool {
  const { uiResourceUri, uiVisibility, uiStreamMode, ...descriptor } = tool;
  if (descriptor._meta !== undefined || (uiResourceUri === undefined && uiVisibility === undefined && uiStreamMode === undefined)) {
    return descriptor;
  }
  return {
    ...descriptor,
    _meta: {
      ui: {
        ...(uiResourceUri !== undefined ? { resourceUri: uiResourceUri } : {}),
        ...(uiVisibility !== undefined ? { visibility: uiVisibility } : {}),
        ...(uiStreamMode !== undefined ? { "pi-mcp-adapter.streamMode": uiStreamMode } : {}),
      },
    },
  };
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools.filter(tool => tool?.name);
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources.filter(resource => resource?.name && resource?.uri);
}

export function serializePrompts(prompts: McpPrompt[]): CachedPrompt[] {
  return (prompts ?? [])
    .filter(prompt => prompt?.name)
    .map(prompt => ({
      name: prompt.name,
      ...(prompt.title !== undefined ? { title: prompt.title } : {}),
      ...(prompt.description !== undefined ? { description: prompt.description } : {}),
      ...(Array.isArray(prompt.arguments)
        ? {
            arguments: prompt.arguments.filter(argument => argument?.name).map(argument => ({
              name: argument.name,
              ...(argument.description !== undefined ? { description: argument.description } : {}),
              ...(argument.required !== undefined ? { required: argument.required } : {}),
            })),
          }
        : {}),
    }));
}

export function reconstructPromptMetadata(
  serverName: string,
  prompts: ReadonlyArray<McpPrompt | CachedPrompt>,
  prefix: ToolPrefix,
  definition?: Pick<ServerEntry, "toolPrefix">,
): PromptMetadata[] {
  const effectivePrefix = resolveToolPrefix(definition, prefix);
  return (prompts ?? []).filter(prompt => prompt?.name).map(prompt => {
    const args: McpPromptArgument[] = Array.isArray(prompt.arguments)
      ? prompt.arguments.filter(argument => argument?.name).map(argument => ({
          name: argument.name,
          ...(argument.description !== undefined ? { description: argument.description } : {}),
          ...(argument.required !== undefined ? { required: argument.required } : {}),
        }))
      : [];
    return {
      serverName,
      originalName: prompt.name,
      commandName: formatPromptCommandName(prompt.name, serverName, effectivePrefix),
      ...(prompt.title !== undefined ? { title: prompt.title } : {}),
      description: prompt.description ?? "",
      arguments: args,
    };
  });
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
