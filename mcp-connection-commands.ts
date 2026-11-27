import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveServerToggleResult } from "./host-contract.ts";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import {
  MAX_CONCURRENT_SERVER_CONNECTS,
  applyConnectionMetadata,
  updateStatusBar,
  recordFailure,
} from "./init.ts";
import { parallelLimit, sanitizeTerminalText } from "./utils.ts";
import { isAbortError } from "./runtime-owner.ts";
import type { ServerConnection } from "./server-manager.ts";
async function connectServer(
  state: McpExtensionState,
  name: string,
  definition: ServerEntry,
  afterAuth: boolean,
): Promise<ServerConnection> {
  const previous = afterAuth ? state.manager.getConnection(name) : undefined;
  state.manager.invalidatePriorDiscovery(name);
  if (!afterAuth) {
    await state.manager.close(name);
  }
  state.owner.throwIfInactive();
  const connection = previous
    ? await state.manager.reconnect(name, definition, previous, state.owner.signal)
    : await state.manager.connect(name, definition, state.owner.signal);
  state.owner.throwIfInactive();
  return connection;
}

function notifyReconnected(
  ui: ExtensionContext["ui"] | undefined,
  name: string,
  connection: ServerConnection,
  skippedCount: number,
): void {
  if (!ui) {
    return;
  }
  ui.notify(
    `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
    "info",
  );
  if (skippedCount > 0) {
    ui.notify(`MCP: ${name} - ${skippedCount} tools skipped`, "warning");
  }
}

function handleReconnectFailure(
  state: McpExtensionState,
  ctx: ExtensionContext,
  name: string,
  error: unknown,
): false {
  const message = error instanceof Error ? error.message : String(error);
  recordFailure(state, name, message);
  if (ctx.hasUI) {
    ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${sanitizeTerminalText(message)}`, "error");
  }
  updateStatusBar(state);
  return false;
}

function notifyAuthenticationRequired(
  state: McpExtensionState,
  ui: ExtensionContext["ui"] | undefined,
  name: string,
): false {
  if (ui) {
    ui.notify(`MCP: ${name} requires OAuth. Run /mcp-auth ${name} first.`, "warning");
  }
  updateStatusBar(state);
  return false;
}

export async function reconnectServer(
  state: McpExtensionState,
  ctx: ExtensionContext,
  name: string,
  afterAuth = false,
): Promise<boolean> {
  const definition = state.config.mcpServers[name];
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const signal = state.owner.signal;
  if (!definition) {
    if (ui) {
      ui.notify(`Server "${name}" not found in config`, "error");
    }
    return false;
  }
  if (isServerDisabled(definition)) {
    if (ui) {
      ui.notify(`MCP: ${name} is disabled. Run /mcp enable ${name}.`, "warning");
    }
    return false;
  }

  try {
    const connection = await connectServer(state, name, definition, afterAuth);
    if (connection.status === "needs-auth") {
      return notifyAuthenticationRequired(state, ui, name);
    }

    const skippedCount = applyConnectionMetadata(state, {
      serverName: name,
      connection,
      definition,
      reason: "command-reconnect",
    });
    notifyReconnected(ui, name, connection, skippedCount);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    return handleReconnectFailure(state, ctx, name, error);
  }
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string,
): Promise<void> {
  if (
    targetServer !== undefined &&
    targetServer.length > 0 &&
    !state.config.mcpServers[targetServer]
  ) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const names =
    targetServer !== undefined && targetServer.length > 0
      ? [targetServer]
      : Object.entries(state.config.mcpServers)
          .filter(([, entry]) => !isServerDisabled(entry))
          .map(([name]) => name);
  await parallelLimit(names, MAX_CONCURRENT_SERVER_CONNECTS, (name) =>
    reconnectServer(state, ctx, name),
  );

  updateStatusBar(state);
}

export async function connectEnabledServerLive(
  state: McpExtensionState,
  name: string,
  definition: ServerEntry,
  signal: AbortSignal | undefined,
): Promise<LiveServerToggleResult> {
  const existing = state.manager.getConnection(name);
  if (existing?.status === "connected") {
    return { applied: true, outcome: "connected", toolCount: existing.tools.length };
  }
  try {
    const connection = await state.manager.connect(name, definition, signal);
    state.owner.throwIfInactive();
    if (connection.status === "needs-auth") {
      return { applied: true, outcome: "needs-auth" };
    }
    applyConnectionMetadata(state, {
      serverName: name,
      connection,
      definition,
      reason: "command-enable",
    });
    return { applied: true, outcome: "connected", toolCount: connection.tools.length };
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, name, message);
    return { applied: true, outcome: "failed", errorMessage: message };
  }
}
