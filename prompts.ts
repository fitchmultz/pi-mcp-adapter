import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { GetPromptResult, PromptMessage } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig, type PromptMetadata } from "./types.ts";
import {
  isServerCacheValid,
  loadMetadataCache,
  reconstructPromptMetadata,
} from "./metadata-cache.ts";
import { logger } from "./logger.ts";
import { truncateAtWord } from "./utils.ts";

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

  const prefix = config.settings?.toolPrefix ?? "server";
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
 * Parse a slash-command argument string into positional and named MCP prompt
 * arguments. Supports bash-style quoting so callers can pass values with
 * spaces:
 *
 *   /mcp__demo__brief today "important tasks"
 *   /mcp__demo__brief day=today topic="important tasks"
 */
export function parsePromptArgs(input: string): {
  positional: string[];
  named: Record<string, string>;
} {
  const positional: string[] = [];
  const named: Record<string, string> = {};

  const tokens = tokenizeArgs(input);
  for (const token of tokens) {
    const eq = findUnquotedEquals(token);
    if (eq > 0) {
      const key = token.slice(0, eq).trim();
      const value = stripQuotes(token.slice(eq + 1).trim());
      if (key !== "") {
        named[key] = value;
        continue;
      }
    }
    positional.push(stripQuotes(token));
  }

  return { positional, named };
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      appendToken(tokens, current);
      current = "";
      continue;
    }
    current += char;
  }

  appendToken(tokens, current);
  return tokens;
}

function appendToken(tokens: string[], token: string): void {
  if (token.length > 0) {
    tokens.push(token);
  }
}

function isQuote(value: string): value is "'" | '"' {
  return value === "'" || value === '"';
}

function findUnquotedEquals(token: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "=") {
      return i;
    }
  }
  return -1;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value.charAt(0))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export interface ResolvedPromptArgs {
  ok: boolean;
  /** Present when `ok === true`. */
  args?: Record<string, string>;
  /** Present when `ok === false`. */
  error?: string;
}

/**
 * Map positional and named arguments onto the prompt's declared argument
 * list. Named arguments win over positional when both target the same slot.
 * Missing required arguments produce a helpful usage message that the
 * command handler surfaces via `ctx.ui.notify`.
 */
export function resolvePromptArgs(
  metadata: PromptMetadata,
  parsed: { positional: string[]; named: Record<string, string> },
): ResolvedPromptArgs {
  const args: Record<string, string> = {};

  const declared = metadata.arguments;
  let positionalIndex = 0;
  for (const argDef of declared) {
    const value = parsed.named[argDef.name] ?? parsed.positional[positionalIndex++];
    if (value !== undefined && value !== "") {
      args[argDef.name] = value;
    }
  }

  // Preserve named arguments the prompt did not declare so servers with
  // permissive schemas still receive them. The MCP spec allows arbitrary
  // string key/values in `prompts/get` params.arguments.
  for (const [key, value] of Object.entries(parsed.named)) {
    if (!(key in args)) {
      args[key] = value;
    }
  }

  const missing = declared.filter(
    (a) => a.required === true && (args[a.name] === undefined || args[a.name] === ""),
  );
  if (missing.length > 0) {
    return { ok: false, error: buildUsageMessage(metadata, missing) };
  }

  return { ok: true, args };
}

function buildUsageMessage(metadata: PromptMetadata, missing: PromptMetadata["arguments"]): string {
  const usage = metadata.arguments
    .map((a) => (a.required === true ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
  const missingList = missing.map((a) => a.name).join(", ");
  return `Missing required argument${missing.length > 1 ? "s" : ""}: ${missingList}.\nUsage: /${metadata.commandName} ${usage}`.trim();
}

/**
 * Flatten a `GetPromptResult` into a single string suitable for
 * `pi.sendUserMessage`. MCP prompts can contain multiple messages with
 * mixed roles; we preserve role attribution as inline markers so the model
 * still sees the intended conversational shape without needing a
 * multi-message replay API on the pi side.
 */
export function formatPromptResult(result: GetPromptResult): string {
  const lines: string[] = [];
  for (const message of result.messages) {
    const text = extractMessageText(message);
    if (text === "") {
      continue;
    }
    if (message.role === "user" && result.messages.length === 1) {
      lines.push(text);
    } else {
      lines.push(`[${message.role}] ${text}`);
    }
  }
  return lines.join("\n\n").trim();
}

function extractMessageText(message: PromptMessage): string {
  const content = message.content;
  switch (content.type) {
    case "text":
      return content.text;
    case "resource": {
      const resource = content.resource;
      if ("text" in resource && typeof resource.text === "string") {
        return `[resource ${resource.uri}]\n${resource.text}`;
      }
      return `[resource ${resource.uri}]`;
    }
    case "resource_link":
      return `[resource_link ${content.uri}${content.name !== "" ? ` — ${content.name}` : ""}]`;
    case "image":
      return `[image ${content.mimeType}${content.data !== "" ? " (embedded)" : ""}]`;
    case "audio":
      return `[audio ${content.mimeType}]`;
    default:
      return "";
  }
}

/**
 * Build the pi command definition for a single MCP prompt. Registered once
 * per prompt at extension load time from the metadata cache; the same
 * factory is reused by tests to invoke the handler without a running pi.
 */
export function createPromptCommand(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  metadata: PromptMetadata,
): Pick<RegisteredCommand, "handler"> & { description: string } {
  return {
    description: buildCommandDescription(metadata),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const state = getState();
      if (!state) {
        notifyPromptError(ctx, "MCP not initialized");
        return;
      }
      const { lazyConnect } = await import("./init.ts");
      const connected = await lazyConnect(state, metadata.serverName, ctx.signal);
      if (!connected) {
        notifyUnavailablePrompt(state, metadata.serverName, ctx);
        return;
      }
      const prepared = preparePromptArguments(state, metadata, args, ctx);
      if (!prepared) {
        return;
      }
      const result = await fetchPrompt(state, prepared.live, prepared.args, ctx);
      if (!result) {
        return;
      }
      const text = formatPromptResult(result);
      if (text === "") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `MCP prompt "${prepared.live.originalName}" returned no text content.`,
            "warning",
          );
        }
        return;
      }
      pi.sendUserMessage(text);
    },
  };
}

function notifyPromptError(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "error");
  }
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

function notifyUnavailablePrompt(
  state: McpExtensionState,
  serverName: string,
  ctx: ExtensionCommandContext,
): void {
  const conn = state.manager.getConnection(serverName);
  const message =
    conn?.status === "needs-auth"
      ? `MCP server "${serverName}" needs authentication. Run /mcp-auth ${serverName}.`
      : `MCP server "${serverName}" is not available. Run /mcp reconnect ${serverName}.`;
  notifyPromptError(ctx, message);
}

async function fetchPrompt(
  state: McpExtensionState,
  metadata: PromptMetadata,
  args: Record<string, string>,
  ctx: ExtensionCommandContext,
): Promise<GetPromptResult | undefined> {
  try {
    return await state.manager.getPrompt(
      metadata.serverName,
      metadata.originalName,
      Object.keys(args).length > 0 ? args : undefined,
      ctx.signal,
    );
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
