import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { GetPromptResult } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig, type PromptMetadata } from "./types.ts";
import {
  isServerCacheValid,
  loadMetadataCache,
  reconstructPromptMetadata,
} from "./metadata-cache.ts";
import { logger } from "./logger.ts";
import { truncateAtWord } from "./utils.ts";
import { prepareMcpConnection, type PreparedMcpConnection } from "./proxy-connection.ts";
import { parsePromptArgs, resolvePromptArgs } from "./prompt-args.ts";
import { formatPromptContent } from "./prompt-content.ts";
import { createPromptArgumentCompleter } from "./prompt-completions.ts";
import { fetchPromptWithRecovery } from "./prompt-tools.ts";

export { parsePromptArgs, resolvePromptArgs, type ResolvedPromptArgs } from "./prompt-args.ts";
export { formatPromptContent, formatPromptResult } from "./prompt-content.ts";

/**
 * Resolve prompt metadata for slash-command registration at extension load
 * time. Like typed tool registration, reads the persistent metadata cache so
 * commands are available before any server connects.
 */
export function resolveCachedPrompts(config: McpConfig, cacheEnabled = true): PromptMetadata[] {
  const cache = loadMetadataCache(cacheEnabled);
  if (!cache) {
    return [];
  }

  const prefix = config.settings?.toolPrefix;
  const specs: PromptMetadata[] = [];

  for (const [serverName, entry] of Object.entries(cache.servers)) {
    const definition = config.mcpServers[serverName];
    if (!definition || isServerDisabled(definition)) {
      continue;
    }
    if (entry.prompts === undefined || !isServerCacheValid(entry, definition)) {
      continue;
    }
    specs.push(...reconstructPromptMetadata(serverName, entry.prompts, prefix, definition));
  }

  return specs;
}

/**
 * Build the pi command definition for a single MCP prompt. Registered once
 * per prompt at extension load time from the metadata cache; the same
 * factory is reused by tests to invoke the handler without a running pi.
 */
function resolveActivePromptTarget(
  state: McpExtensionState,
  metadata: PromptMetadata,
  resolveActive: (() => PromptMetadata | undefined) | undefined,
  ctx: ExtensionCommandContext,
): PromptMetadata | undefined {
  const active = resolveActive ? resolveActive() : metadata;
  if (!active) {
    notifyPromptError(
      ctx,
      `MCP prompt "/${metadata.commandName}" is no longer available in the current workspace.`,
    );
    return undefined;
  }
  const definition = state.config.mcpServers[active.serverName];
  if (!definition || isServerDisabled(definition)) {
    notifyPromptError(
      ctx,
      `MCP prompt "${active.originalName}" is no longer configured. Run /mcp reconnect to refresh.`,
    );
    return undefined;
  }
  return active;
}

export function createPromptCommand(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  metadata: PromptMetadata,
  resolveActive?: () => PromptMetadata | undefined,
): Pick<RegisteredCommand, "handler" | "getArgumentCompletions"> & { description: string } {
  return {
    description: buildCommandDescription(metadata),
    getArgumentCompletions: createPromptArgumentCompleter(getState, metadata),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const state = getState();
      if (!state) {
        notifyPromptError(ctx, "MCP not initialized");
        return;
      }
      const active = resolveActivePromptTarget(state, metadata, resolveActive, ctx);
      if (!active) {
        return;
      }
      const prepared = await prepareMcpConnection(state, active.serverName, ctx.signal);
      if (prepared.error) {
        notifyConnectionFailure(state, active.serverName, prepared, ctx);
        return;
      }
      const resolved = preparePromptArguments(state, active, args, ctx);
      if (!resolved) {
        return;
      }
      const result = await fetchPrompt(state, resolved.live, resolved.args, {
        ctx,
        recoverAuthConnection: prepared.recoverAuthConnection,
      });
      if (!result) {
        return;
      }
      deliverPromptResult(pi, resolved.live, result, ctx);
    },
  };
}

function deliverPromptResult(
  pi: ExtensionAPI,
  metadata: PromptMetadata,
  result: GetPromptResult,
  ctx: ExtensionCommandContext,
): void {
  const content = formatPromptContent(result);
  if (content.length === 0) {
    if (ctx.hasUI) {
      ctx.ui.notify(`MCP prompt "${metadata.originalName}" returned no text content.`, "warning");
    }
    return;
  }
  if (content.length === 1 && content[0]?.type === "text") {
    pi.sendUserMessage(content[0].text);
    return;
  }
  pi.sendUserMessage(content);
}
function notifyPromptError(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "error");
  }
}

function notifyConnectionFailure(
  state: McpExtensionState,
  serverName: string,
  prepared: Extract<PreparedMcpConnection, { error: unknown }>,
  ctx: ExtensionCommandContext,
): void {
  const errorCode = prepared.error.details.error;
  if (errorCode === "auth_required") {
    const message =
      state.config.settings?.autoAuth === true && typeof prepared.error.details.message === "string"
        ? prepared.error.details.message
        : `MCP server "${serverName}" needs authentication. Run /mcp-auth ${serverName}.`;
    notifyPromptError(ctx, message);
    return;
  }
  const message = `MCP server "${serverName}" is not available. Run /mcp reconnect ${serverName}.`;
  notifyPromptError(ctx, message);
}

function advertisedPrompt(
  state: McpExtensionState,
  metadata: PromptMetadata,
  ctx: ExtensionCommandContext,
): PromptMetadata | undefined {
  const live = findLivePromptMetadata(state, metadata.serverName, metadata.originalName);
  if (state.promptMetadataLive.has(metadata.serverName) && !live) {
    notifyPromptError(
      ctx,
      `MCP prompt "${metadata.originalName}" is no longer advertised by server "${metadata.serverName}". Run /mcp reconnect to refresh.`,
    );
    return undefined;
  }
  return live ?? metadata;
}

function preparePromptArguments(
  state: McpExtensionState,
  metadata: PromptMetadata,
  args: string,
  ctx: ExtensionCommandContext,
): { live: PromptMetadata; args: Record<string, string> } | undefined {
  const live = advertisedPrompt(state, metadata, ctx);
  if (!live) {
    return undefined;
  }
  const resolved = resolvePromptArgs(live, parsePromptArgs(args));
  if (!resolved.ok) {
    notifyPromptError(ctx, resolved.error ?? "Invalid prompt arguments");
    return undefined;
  }
  if (!state.config.mcpServers[metadata.serverName]) {
    notifyPromptError(
      ctx,
      `MCP prompt "${live.originalName}" is no longer configured. Run /mcp reconnect to refresh.`,
    );
    return undefined;
  }
  return { live, args: resolved.args ?? {} };
}

async function fetchPrompt(
  state: McpExtensionState,
  metadata: PromptMetadata,
  args: Record<string, string>,
  options: {
    ctx: ExtensionCommandContext;
    recoverAuthConnection: Extract<
      PreparedMcpConnection,
      { connection: unknown }
    >["recoverAuthConnection"];
  },
): Promise<GetPromptResult | undefined> {
  const { ctx, recoverAuthConnection } = options;
  try {
    return await fetchPromptWithRecovery(state, {
      serverName: metadata.serverName,
      promptName: metadata.originalName,
      args,
      signal: ctx.signal,
      recoverAuthConnection,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(
      `MCP prompt "${metadata.originalName}" on ${metadata.serverName} failed: ${message}`,
    );
    notifyPromptError(ctx, `MCP prompt "${metadata.originalName}" failed: ${message}`);
    return undefined;
  }
}

function findLivePromptMetadata(
  state: McpExtensionState,
  serverName: string,
  originalName: string,
): PromptMetadata | undefined {
  return state.promptMetadata.get(serverName)?.find((p) => p.originalName === originalName);
}

function buildCommandDescription(metadata: PromptMetadata): string {
  const fallback = `MCP prompt from ${metadata.serverName}`;
  const base = metadata.description !== "" ? metadata.description : metadata.title;
  const description = truncateAtWord(
    `MCP: ${base === undefined || base === "" ? fallback : base}`,
    120,
  );
  return description !== "" ? description : fallback;
}
