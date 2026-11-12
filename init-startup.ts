import type { McpExtensionState } from "./state.ts";
import type { ServerDefinition } from "./types.ts";
import {
  loadMetadataCache,
  isServerCacheValid,
  reconstructToolMetadata,
  reconstructPromptMetadata,
  getMissingConfiguredDirectToolServers,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { totalToolCount } from "./tool-metadata.ts";
import {
  parallelLimit,
  MAX_CONCURRENT_SERVER_CONNECTS,
  formatMcpStatus,
  sanitizeTerminalText,
} from "./utils.ts";
import { isAbortError } from "./runtime-owner.ts";
import { logger } from "./logger.ts";
import {
  type MetadataCacheUpdates,
  getMetadataCacheUpdates,
  collectMetadataCacheUpdate,
  notifyToolMetadataUpdated,
  markKeepAliveAfterConnect,
  updateServerMetadata,
  updateMetadataCache,
  applyServerMetadata,
} from "./init-metadata.ts";
import {
  recordFailure,
  clearFailure,
  updateStatusBar,
  getEffectiveIdleTimeoutMinutes,
} from "./init-status.ts";
import type { ServerConnection } from "./server-manager.ts";

type ServerEntry = [string, ServerDefinition];
type StartupResult = {
  name: string;
  definition: ServerDefinition;
  connection: ServerConnection | null;
  error: string | null;
};

export function registerServers(state: McpExtensionState, serverEntries: ServerEntry[]): void {
  const { config } = state;
  state.lifecycle.setGlobalIdleTimeout(config.settings?.idleTimeout ?? 10);
  const cache = loadMetadataCache(state.metadataCacheEnabled);
  const prefix = config.settings?.toolPrefix ?? "server";
  for (const [name, definition] of serverEntries) {
    registerLifecycle(state, name, definition);
    restoreCachedMetadata(state, { name, definition, prefix, cachedEntry: cache?.servers[name] });
  }
}
function registerLifecycle(
  state: McpExtensionState,
  name: string,
  definition: ServerDefinition,
): void {
  const lifecycleMode = definition.lifecycle ?? "lazy";
  const persistent = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
  const idleOverride = definition.idleTimeout ?? (persistent ? 0 : undefined);
  state.lifecycle.registerServer(
    name,
    definition,
    idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined,
  );
  if (lifecycleMode === "keep-alive") {
    state.lifecycle.markKeepAlive(name, definition);
  }
}
function restoreCachedMetadata(
  state: McpExtensionState,
  input: {
    name: string;
    definition: ServerDefinition;
    prefix: NonNullable<NonNullable<McpExtensionState["config"]["settings"]>["toolPrefix"]>;
    cachedEntry: ServerCacheEntry | undefined;
  },
): void {
  const { name, definition, prefix, cachedEntry } = input;
  if (!cachedEntry || !isServerCacheValid(cachedEntry, definition)) {
    return;
  }
  state.toolMetadata.set(name, reconstructToolMetadata(name, cachedEntry, prefix, definition));
  if (Array.isArray(cachedEntry.resources)) {
    state.resourceCounts.set(name, cachedEntry.resources.length);
  }
  if ((cachedEntry.prompts?.length ?? 0) > 0) {
    state.promptMetadata.set(
      name,
      reconstructPromptMetadata(name, cachedEntry.prompts ?? [], prefix, definition),
    );
  }
  if (cachedEntry.instructions !== undefined && cachedEntry.instructions.length > 0) {
    state.serverInstructions.set(name, cachedEntry.instructions);
  }
}

async function connectStartup(
  state: McpExtensionState,
  entry: ServerEntry,
  runtimeSignal?: AbortSignal,
): Promise<StartupResult> {
  const [name, definition] = entry;
  try {
    const connection = await state.manager.connect(name, definition, runtimeSignal);
    if (connection.status === "needs-auth") {
      return {
        name,
        definition,
        connection: null,
        error: `OAuth authentication required. Run /mcp-auth ${name}.`,
      };
    }
    return { name, definition, connection, error: null };
  } catch (error) {
    if (isAbortError(error, runtimeSignal)) {
      if (state.owner.signal.aborted) {
        throw error;
      }
      return { name, definition, connection: null, error: null };
    }
    return {
      name,
      definition,
      connection: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function acceptStartupResult(
  state: McpExtensionState,
  result: StartupResult,
  cache: MetadataCacheUpdates,
  initialSignal: AbortSignal | undefined,
): void {
  const { name, connection, error } = result;
  const { owner, ui } = state;
  owner.throwIfInactive();
  if (error !== null || !connection) {
    if (initialSignal?.aborted === true) {
      return;
    }
    reportStartupFailure(state, result, cache);
    return;
  }
  const failedToolCount = updateServerMetadataFromConnection(state, result);
  collectMetadataCacheUpdate(state, name, cache);
  notifyToolMetadataUpdated(state, name, "startup");
  markKeepAliveAfterConnect(state, name);
  if (failedToolCount > 0 && ui) {
    cache.save(state);
    ui.notify(`MCP: ${name} - ${failedToolCount} tools skipped`, "warning");
  }
}

export async function connectStartupServers(
  state: McpExtensionState,
  startupServers: ServerEntry[],
  signals: { initial: AbortSignal | undefined; runtime: AbortSignal | undefined },
): Promise<Set<string>> {
  if (state.ui && startupServers.length > 0) {
    state.ui.setStatus(
      "mcp",
      formatMcpStatus(state.config, `connecting to ${startupServers.length} servers...`),
    );
  }
  const results = await parallelLimit(startupServers, MAX_CONCURRENT_SERVER_CONNECTS, (entry) =>
    connectStartup(state, entry, signals.runtime),
  );
  if (signals.initial?.aborted === true) {
    return new Set();
  }
  state.owner.throwIfInactive();
  const cache = getMetadataCacheUpdates(state);
  try {
    for (const result of results) {
      acceptStartupResult(state, result, cache, signals.initial);
    }
  } finally {
    cache.save(state);
  }
  const connected = results.filter((result) => result.connection !== null);
  const failedCount = results.filter(
    (result) => result.error !== null && result.error.length > 0,
  ).length;
  if (state.ui && connected.length > 0) {
    const count =
      failedCount > 0 ? `${connected.length}/${startupServers.length}` : String(connected.length);
    state.ui.notify(`MCP: ${count} servers connected (${totalToolCount(state)} tools)`, "info");
  }
  return new Set(connected.map((result) => result.name));
}

export async function bootstrapDirectTools(
  state: McpExtensionState,
  connectedServers: Set<string>,
  runtimeSignal?: AbortSignal,
): Promise<void> {
  const { config, manager, owner, ui } = state;
  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache(state.metadataCacheEnabled);
    const envDirectToolOverride = envDirect
      ?.split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const missingCacheServers = getMissingConfiguredDirectToolServers(
      config,
      currentCache,
      envDirectToolOverride,
    );

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter((name) => !connectedServers.has(name)),
        MAX_CONCURRENT_SERVER_CONNECTS,
        async (name) => {
          try {
            const definition = config.mcpServers[name];
            if (!definition) {
              throw new Error(`MCP server "${name}" is not configured`);
            }
            const connection = await manager.connect(name, definition, runtimeSignal);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            updateServerMetadata(state, name);
            updateMetadataCache(state, name);
            notifyToolMetadataUpdated(state, name, "direct-tools-bootstrap");
            markKeepAliveAfterConnect(state, name);
            clearFailure(state, name);
            return { name, ok: true };
          } catch (error) {
            if (isAbortError(error, runtimeSignal)) {
              if (owner.signal.aborted) {
                throw error;
              }
              return { name, ok: false };
            }
            const message = error instanceof Error ? error.message : String(error);
            recordFailure(state, name, message);
            logger.debug(
              `MCP: direct-tools bootstrap failed for ${name}: ${sanitizeTerminalText(message)}`,
            );
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter((r) => r.ok).map((r) => r.name);
      owner.throwIfInactive();
      if (bootstrapped.length > 0 && ui) {
        ui.notify(`MCP: tools discovered for ${bootstrapped.join(", ")}`, "info");
      }
    }
  }
}

export function bindLifecycle(state: McpExtensionState, runtimeSignal?: AbortSignal): void {
  const { owner, lifecycle, ui, config } = state;
  lifecycle.setReconnectCallback((serverName) => {
    if (!owner.isActive()) {
      return;
    }
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    notifyToolMetadataUpdated(state, serverName, "lifecycle-reconnect");
    clearFailure(state, serverName);
    updateStatusBar(state);
  });

  lifecycle.setReconnectFailureCallback((serverName, error) => {
    if (!owner.isActive()) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    if (!owner.isActive()) {
      return;
    }
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  owner.throwIfInactive();
  lifecycle.startHealthChecks(runtimeSignal);
  if (config.settings?.mcpFooterStatus === "off") {
    ui?.setStatus("mcp", undefined);
  }
}

function updateServerMetadataFromConnection(
  state: McpExtensionState,
  { name, definition, connection }: StartupResult,
): number {
  if (!connection) {
    return 0;
  }
  return applyServerMetadata(state, name, connection, definition);
}

function reportStartupFailure(
  state: McpExtensionState,
  { name, error }: StartupResult,
  cache: MetadataCacheUpdates,
): void {
  const ui = state.ui;
  cache.save(state);
  if (error !== null && error.length > 0) {
    recordFailure(state, name, error);
  }
  const displayError = sanitizeTerminalText(error ?? "Unknown connection failure");
  ui?.notify(`MCP: Failed to connect to ${name}: ${displayError}`, "error");
  console.error(`MCP: Failed to connect to ${name}: ${displayError}`);
}
