import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import {
  MAX_CONCURRENT_SERVER_CONNECTS,
  markKeepAliveAfterConnect,
  notifyToolMetadataUpdated,
  updateMetadataCache,
  updateStatusBar,
  clearFailure,
  recordFailure,
} from "./init.ts";
import { reconstructPromptMetadata } from "./metadata-cache.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
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

function applyConnectionMetadata(
  state: McpExtensionState,
  name: string,
  definition: ServerEntry,
  connection: ServerConnection,
): ReturnType<typeof buildToolMetadata>["failedTools"] {
  const prefix = state.config.settings?.toolPrefix ?? "server";
  const { metadata, failedTools } = buildToolMetadata({
    tools: connection.tools,
    resources: connection.resources,
    definition,
    serverName: name,
    prefix,
  });
  state.toolMetadata.set(name, metadata);
  if (connection.promptDiscoveryFailed !== true) {
    state.promptMetadata.set(
      name,
      reconstructPromptMetadata(name, connection.prompts, prefix, definition),
    );
    state.promptMetadataLive.add(name);
  }
  const { instructions } = connection;
  if (instructions !== undefined && instructions.length > 0) {
    state.serverInstructions.set(name, instructions);
  } else {
    state.serverInstructions.delete(name);
  }
  updateMetadataCache(state, name);
  notifyToolMetadataUpdated(state, name, "command-reconnect");
  markKeepAliveAfterConnect(state, name);
  clearFailure(state, name);

  return failedTools;
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
      ui.notify(`MCP: ${name} is disabled. Run /mcp enable ${name}, then /reload.`, "warning");
    }
    return false;
  }

  try {
    const connection = await connectServer(state, name, definition, afterAuth);
    if (connection.status === "needs-auth") {
      return notifyAuthenticationRequired(state, ui, name);
    }

    const failedTools = applyConnectionMetadata(state, name, definition, connection);
    notifyReconnected(ui, name, connection, failedTools.length);
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
      : Object.keys(state.config.mcpServers);
  await parallelLimit(names, MAX_CONCURRENT_SERVER_CONNECTS, (name) =>
    reconnectServer(state, ctx, name),
  );

  updateStatusBar(state);
}
