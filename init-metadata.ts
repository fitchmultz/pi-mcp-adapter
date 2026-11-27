import { isDeepStrictEqual } from "node:util";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { ServerConnection } from "./server-manager.ts";
import { buildToolMetadata, isUiResourceUri } from "./tool-metadata.ts";
import {
  computeServerHash,
  loadMetadataCache,
  saveMetadataCache,
  reconstructPromptMetadata,
  serializeTools,
  serializeResources,
  serializeResourceTemplates,
  serializePrompts,
  serializeSkills,
  type MetadataCache,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { cleanupServerSkills, syncConnectedServerSkills } from "./mcp-skills-store.ts";
import { logger } from "./logger.ts";
import { getFailureBackoffMap } from "./server-status.ts";

export function clearFailure(state: McpExtensionState, serverName: string): void {
  state.failureTracker.delete(serverName);
  state.failureMessages.delete(serverName);
  state.lifecycle.resetReconnectBackoff(serverName);
  const entries = getFailureBackoffMap(state);
  const entry = entries?.get(serverName);
  if (entry?.timer) {
    clearTimeout(entry.timer);
  }
  entries?.delete(serverName);
}
export function markKeepAliveAfterConnect(state: McpExtensionState, serverName: string): void {
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) {
    return;
  }
  if ((definition.lifecycle ?? "lazy") === "lazy-keep-alive") {
    state.lifecycle.markKeepAlive(serverName, definition);
  }
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") {
    return;
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return;
  }
  if (isServerDisabled(definition)) {
    state.toolMetadata.delete(serverName);
    state.resourceCounts.delete(serverName);
    state.resourceTemplates.delete(serverName);
    state.promptMetadata.delete(serverName);
    state.promptMetadataLive.delete(serverName);
    state.serverInstructions.delete(serverName);
    cleanupServerSkills(state, serverName);
    return;
  }

  applyServerMetadata(state, { serverName, connection, definition });
}

function syncServerResources(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
  definition: ServerDefinition,
): void {
  if (definition.exposeResources === false) {
    state.resourceCounts.set(serverName, 0);
    state.resourceTemplates.set(serverName, []);
    return;
  }
  state.resourceCounts.set(
    serverName,
    connection.resources.filter((resource) => !isUiResourceUri(resource.uri)).length,
  );
  state.resourceTemplates.set(
    serverName,
    (connection.resourceTemplates ?? []).filter(
      (template) => !isUiResourceUri(template.uriTemplate),
    ),
  );
}

function syncServerInstructions(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
): void {
  if (connection.instructions !== undefined && connection.instructions.length > 0) {
    state.serverInstructions.set(serverName, connection.instructions);
  } else {
    state.serverInstructions.delete(serverName);
  }
}

export function applyServerMetadata(
  state: McpExtensionState,
  input: {
    readonly serverName: string;
    readonly connection: ServerConnection;
    readonly definition: ServerDefinition;
    readonly preserveToolMetadataIdentity?: boolean;
    readonly updateInstructions?: boolean;
  },
): number {
  const { serverName, connection, definition } = input;
  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata, failedTools } = buildToolMetadata({
    tools: connection.tools,
    resources: connection.resources,
    definition,
    serverName,
    prefix,
  });
  if (
    input.preserveToolMetadataIdentity !== true ||
    !isDeepStrictEqual(state.toolMetadata.get(serverName), metadata)
  ) {
    state.toolMetadata.set(serverName, metadata);
  }
  syncServerResources(state, serverName, connection, definition);
  if (connection.promptDiscoveryFailed !== true) {
    state.promptMetadata.set(
      serverName,
      reconstructPromptMetadata(serverName, connection.prompts, prefix, definition),
    );
    state.promptMetadataLive.add(serverName);
  }
  if (input.updateInstructions !== false) {
    syncServerInstructions(state, serverName, connection);
  }
  syncConnectedServerSkills(state, serverName, connection);
  return failedTools.length;
}

export interface ApplyConnectionMetadataInput {
  readonly serverName: string;
  readonly connection: ServerConnection;
  readonly definition: ServerDefinition;
  readonly reason: string;
  readonly preserveToolMetadataIdentity?: boolean;
  readonly updateInstructions?: boolean;
}

export function applyConnectionMetadata(
  state: McpExtensionState,
  input: ApplyConnectionMetadataInput,
): number {
  const skippedCount = applyServerMetadata(state, input);
  updateMetadataCache(state, input.serverName);
  notifyToolMetadataUpdated(state, input.serverName, input.reason);
  markKeepAliveAfterConnect(state, input.serverName);
  clearFailure(state, input.serverName);
  return skippedCount;
}

export class MetadataCacheUpdates {
  readonly entries = new Map<string, ServerCacheEntry>();
  private existing: MetadataCache | null | undefined;

  getExisting(state: Readonly<McpExtensionState>): MetadataCache | null {
    if (this.existing === undefined) {
      this.existing = loadMetadataCache(state.metadataCacheEnabled);
    }
    return this.existing;
  }

  save(state: Readonly<McpExtensionState>): void {
    if (this.entries.size === 0) {
      return;
    }
    const servers = Object.fromEntries(this.entries);
    this.existing = undefined;
    const result = saveMetadataCache(
      { version: 1, servers },
      state.metadataCacheEnabled,
      Object.keys(state.config.mcpServers),
    );
    if (result === "saved") {
      this.entries.clear();
    } else if (result === "busy") {
      logger.warn(
        "MCP: metadata cache not saved because another process holds its lock; updates remain pending",
      );
    }
  }
}

const metadataCacheUpdates = new WeakMap<Readonly<McpExtensionState>, MetadataCacheUpdates>();

export function getMetadataCacheUpdates(state: Readonly<McpExtensionState>): MetadataCacheUpdates {
  let updates = metadataCacheUpdates.get(state);
  if (!updates) {
    updates = new MetadataCacheUpdates();
    metadataCacheUpdates.set(state, updates);
  }
  return updates;
}

export function collectMetadataCacheUpdate(
  state: McpExtensionState,
  serverName: string,
  updates: MetadataCacheUpdates,
  options: { preserveEmptyResources?: boolean } = {},
): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") {
    return;
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) {
    return;
  }

  const configHash = computeServerHash(definition);
  const existingEntry = updates.getExisting(state)?.servers[serverName];

  updates.entries.set(
    serverName,
    cacheEntry(
      {
        connection,
        definition,
        configHash,
        existingEntry,
        exposeSkillsGlobal: state.config.settings?.exposeSkills !== false,
      },
      options,
    ),
  );
}

function cacheSkills(
  exposeSkillsGlobal: boolean,
  definition: ServerDefinition,
  connection: ServerConnection,
  matchingEntry: ServerCacheEntry | undefined,
): ServerCacheEntry["skills"] | undefined {
  if (!exposeSkillsGlobal || definition.exposeSkills === false) {
    return undefined;
  }
  if (connection.skillDiscoveryFailed === true) {
    return matchingEntry?.skills !== undefined && matchingEntry.skills.length > 0
      ? matchingEntry.skills
      : undefined;
  }
  const skills = serializeSkills(connection.skills ?? []);
  return skills.length > 0 ? skills : undefined;
}

function cacheEntry(
  {
    connection,
    definition,
    configHash,
    existingEntry,
    exposeSkillsGlobal,
  }: {
    connection: ServerConnection;
    definition: ServerDefinition;
    configHash: string;
    existingEntry: ServerCacheEntry | undefined;
    exposeSkillsGlobal: boolean;
  },
  options: { preserveEmptyResources?: boolean },
): ServerCacheEntry {
  const tools = serializeTools(connection.tools);
  const matchingEntry = existingEntry?.configHash === configHash ? existingEntry : undefined;
  const resources = cacheResources(
    definition,
    connection,
    matchingEntry,
    options.preserveEmptyResources !== false,
  );
  const resourceTemplates = cacheResourceTemplates(
    definition,
    connection,
    matchingEntry,
    options.preserveEmptyResources !== false,
  );
  const prompts =
    connection.promptDiscoveryFailed === true
      ? matchingEntry?.prompts
      : serializePrompts(connection.prompts);
  const skills = cacheSkills(exposeSkillsGlobal, definition, connection, matchingEntry);

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    resourceTemplates,
    ...(prompts !== undefined ? { prompts } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(connection.instructions !== undefined ? { instructions: connection.instructions } : {}),
    ...(connection.priorDiscovery !== undefined
      ? { priorDiscovery: connection.priorDiscovery }
      : {}),
    cachedAt: Date.now(),
  };

  return entry;
}

export function updateMetadataCache(
  state: McpExtensionState,
  serverName: string,
  options: { preserveEmptyResources?: boolean } = {},
): void {
  const updates = getMetadataCacheUpdates(state);
  collectMetadataCacheUpdate(state, serverName, updates, options);
  updates.save(state);
}

export function notifyToolMetadataUpdated(
  state: McpExtensionState,
  serverName: string,
  reason: string,
): void {
  try {
    const result = state.onToolMetadataUpdated?.(serverName, reason);
    if (result && typeof result.catch === "function") {
      result.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
  }
}

export function flushMetadataCache(state: McpExtensionState): void {
  const updates = getMetadataCacheUpdates(state);
  try {
    for (const [name, connection] of state.manager.getAllConnections()) {
      if (connection.status === "connected") {
        collectMetadataCacheUpdate(state, name, updates);
      }
    }
  } finally {
    updates.save(state);
  }
}

function cacheResources(
  definition: ServerDefinition,
  connection: ServerConnection,
  existing: Partial<ServerCacheEntry> | undefined,
  preserveEmpty: boolean,
): ServerCacheEntry["resources"] {
  if (definition.exposeResources === false) {
    return [];
  }
  const resources = serializeResources(connection.resources);
  const cached = existing?.resources;
  if (resources.length === 0 && cached !== undefined && cached.length > 0 && preserveEmpty) {
    return cached;
  }
  return resources;
}

function cacheResourceTemplates(
  definition: ServerDefinition,
  connection: ServerConnection,
  existing: Partial<ServerCacheEntry> | undefined,
  preserveEmpty: boolean,
): NonNullable<ServerCacheEntry["resourceTemplates"]> {
  if (definition.exposeResources === false) {
    return [];
  }
  const templates = serializeResourceTemplates(connection.resourceTemplates ?? []);
  const cached = existing?.resourceTemplates;
  if (templates.length === 0 && cached !== undefined && cached.length > 0 && preserveEmpty) {
    return cached;
  }
  return templates;
}
