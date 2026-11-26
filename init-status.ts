import type { McpExtensionState } from "./state.ts";
import type { ServerConnection } from "./server-manager.ts";
import { isServerDisabled } from "./types.ts";
import { publishMcpStatusSnapshot } from "./mcp-status.ts";
import { formatMcpStatus, sanitizeTerminalText } from "./utils.ts";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import {
  ensureFailureBackoffMap,
  failureAgeSeconds,
  failureBackoffMs,
  failureRemainingSeconds,
  getFailureBackoffMap,
  serverFailureBackoffMs,
  type FailureBackoffEntry,
} from "./server-status.ts";
import {
  updateServerMetadata,
  updateMetadataCache,
  notifyToolMetadataUpdated,
  markKeepAliveAfterConnect,
} from "./init-metadata.ts";
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;

function getFailureBackoffs(state: McpExtensionState): Map<string, FailureBackoffEntry> {
  return ensureFailureBackoffMap(state, (ownedEntries) => {
    state.owner.addCleanup(() => {
      for (const entry of ownedEntries.values()) {
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
      }
      ownedEntries.clear();
    });
  });
}

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

export function recordFailure(state: McpExtensionState, serverName: string, message: string): void {
  const entries = getFailureBackoffs(state);
  const previous = entries.get(serverName);
  if (previous?.timer) {
    clearTimeout(previous.timer);
  }
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const backoffMs = failureBackoffMs(consecutiveFailures);
  const failedAt = Date.now();
  state.failureTracker.set(serverName, failedAt);
  state.failureMessages.set(serverName, message.slice(0, MAX_FAILURE_MESSAGE_CHARS));
  const entry: FailureBackoffEntry = { consecutiveFailures, backoffMs, timer: undefined };
  const timer = setTimeout(() => {
    entry.timer = undefined;
    if (!state.owner.isActive()) {
      entries.delete(serverName);
      return;
    }
    if (state.failureTracker.get(serverName) === failedAt) {
      state.failureTracker.delete(serverName);
      publishMcpStatusSnapshot(state);
    }
  }, backoffMs);
  timer.unref();
  entry.timer = timer;
  entries.set(serverName, entry);
}

export function updateStatusBar(state: McpExtensionState): void {
  publishMcpStatusSnapshot(state);
  const ui = state.ui;
  if (!ui) {
    return;
  }
  const entries = Object.entries(state.config.mcpServers);
  const disabledCount = entries.filter(([, definition]) => isServerDisabled(definition)).length;
  const enabledCount = entries.length - disabledCount;
  if (entries.length === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = [...state.manager.getAllConnections()].filter(([name, connection]) => {
    const definition = state.config.mcpServers[name];
    return (
      connection.status === "connected" && definition !== undefined && !isServerDisabled(definition)
    );
  }).length;
  const footerStatus = state.config.settings?.mcpFooterStatus ?? "compact";
  if (footerStatus === "off") {
    ui.setStatus("mcp", undefined);
    return;
  }

  const status = statusText(footerStatus, { connectedCount, enabledCount, disabledCount });
  const formattedStatus =
    footerStatus === "compact" ? status : formatMcpStatus(state.config, status);
  if (formattedStatus === undefined) {
    ui.setStatus("mcp", undefined);
    return;
  }
  if (ui.theme === undefined) {
    ui.setStatus("mcp", formattedStatus);
    return;
  }
  ui.setStatus("mcp", ui.theme.fg("accent", formattedStatus));
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  return failureAgeSeconds(
    state.failureTracker.get(serverName),
    Date.now(),
    serverFailureBackoffMs(state, serverName),
  );
}

export function getFailureRemainingSeconds(
  state: McpExtensionState,
  serverName: string,
): number | null {
  return failureRemainingSeconds(
    state.failureTracker.get(serverName),
    Date.now(),
    serverFailureBackoffMs(state, serverName),
  );
}

export function getFailureMessage(state: McpExtensionState, serverName: string): string | null {
  return state.failureMessages.get(serverName) ?? null;
}

function canReconnectNeedsAuth(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
): NonNullable<McpExtensionState["config"]["mcpServers"][string]> | undefined {
  const definition = state.config.mcpServers[serverName];
  if (
    !definition ||
    isServerDisabled(definition) ||
    !state.manager.hasFreshOAuthCredentials(serverName, definition, connection)
  ) {
    return undefined;
  }
  return definition;
}

export async function lazyConnect(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    const definition = canReconnectNeedsAuth(state, serverName, connection);
    return definition
      ? connectLazyServer(state, serverName, {
          definition,
          ownedSignal,
          staleConnection: connection,
        })
      : false;
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    markKeepAliveAfterConnect(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) {
    return false;
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) {
    return false;
  }

  return connectLazyServer(state, serverName, { definition, ownedSignal });
}

async function connectLazyServer(
  state: McpExtensionState,
  serverName: string,
  {
    definition,
    ownedSignal,
    staleConnection,
  }: {
    definition: NonNullable<McpExtensionState["config"]["mcpServers"][string]>;
    ownedSignal: AbortSignal | undefined;
    staleConnection?: ServerConnection;
  },
): Promise<boolean> {
  try {
    if (state.ui) {
      const status = formatMcpStatus(state.config, `connecting to ${serverName}...`);
      state.ui.setStatus("mcp", status);
    }
    const newConnection = staleConnection
      ? await state.manager.reconnect(serverName, definition, staleConnection, ownedSignal)
      : await state.manager.connect(serverName, definition, ownedSignal);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    clearFailure(state, serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    notifyToolMetadataUpdated(state, serverName, "lazy-connect");
    markKeepAliveAfterConnect(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (isAbortError(error, ownedSignal)) {
      throwIfAborted(ownedSignal);
    }
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${sanitizeTerminalText(message)}`);
    updateStatusBar(state);
    return false;
  }
}

export function getEffectiveIdleTimeoutMinutes(
  state: McpExtensionState,
  serverName: string,
): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return typeof state.config.settings?.idleTimeout === "number"
      ? state.config.settings.idleTimeout
      : 10;
  }
  if (typeof definition.idleTimeout === "number") {
    return definition.idleTimeout;
  }
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager" || mode === "lazy-keep-alive") {
    return 0;
  }
  return typeof state.config.settings?.idleTimeout === "number"
    ? state.config.settings.idleTimeout
    : 10;
}

function statusText(
  footerStatus: NonNullable<
    NonNullable<McpExtensionState["config"]["settings"]>["mcpFooterStatus"]
  >,
  {
    connectedCount,
    enabledCount,
    disabledCount,
  }: { connectedCount: number; enabledCount: number; disabledCount: number },
): string {
  let status =
    footerStatus === "compact"
      ? `MCP ${connectedCount}/${enabledCount}`
      : `${enabledCount} ${enabledCount === 1 ? "server" : "servers"} enabled`;
  if (footerStatus === "full") {
    if (connectedCount > 0) {
      status += ` (${connectedCount} connected)`;
    }
    if (disabledCount > 0) {
      status += ` (${disabledCount} disabled)`;
    }
  }
  return status;
}
