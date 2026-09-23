import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/client";
import { DEFAULT_REQUEST_TIMEOUT_MSEC, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { ServerConnection } from "./server-manager.ts";
import type { ToolMetadata, McpOperationContext, McpToolCallEvent, McpToolCallIdentity } from "./types.ts";
import { getServerPrefix, isServerDisabled, isNonInteractiveOAuth, parseUiPromptHandoff, resolveToolPrefix } from "./types.ts";
import { lazyConnect, markKeepAliveAfterConnect, notifyToolMetadataUpdated, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar, clearFailure, recordFailure } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { buildToolMetadata, catalogCoverage, findToolByName, formatSchema, toToolDescriptor } from "./tool-metadata.ts";
import { reconstructPromptMetadata } from "./metadata-cache.ts";
import { renderMcpResultContent } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, retainMcpResult, resolveMcpOutputGuardOptions, formatMcpResultReference } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { formatAuthRequiredMessage, formatMcpStatus, resolveServerUrl, truncateAtWord } from "./utils.ts";
import { authenticate, completeAuthFromInput, startAuth, supportsOAuth } from "./mcp-auth-flow.ts";
import { isInterruptedToolCall, isToolTransportFailure, trackToolCallOutcome, SessionRecoveryAuthRequiredError, withSessionRecovery, type SessionRecoveryDeps } from "./session-recovery.ts";
import { paginate, rankSuggestions, rankToolMatches } from "./search-ranking.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "./tool-approval.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;
type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

const INSTRUCTIONS_PREVIEW_LENGTH = 300;

type AutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function disabledResult(mode: string, serverName: string): ProxyToolResult {
  const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName} and /reload to enable it.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: { mode, error: "server_disabled", server: serverName, message },
  };
}

function getAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (oauth && oauth.crossAppAccess) defaultMessage = `Server "${serverName}" requires enterprise authorization. Check oauth.crossAppAccess IdP configuration and ID-token source, then retry.`;
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (customGuidance || (oauth && oauth.crossAppAccess)) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

function getRedirectPort(authorizationUrl: string): number | undefined {
  try {
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (!redirectUri) return undefined;
    const port = Number.parseInt(new URL(redirectUri).port, 10);
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function formatManualAuthInstructions(serverName: string, authorizationUrl: string): string {
  const port = getRedirectPort(authorizationUrl);
  const portNote = port
    ? `\nThe redirect URL will use local port ${port}. On a remote server it is expected for that localhost page to fail locally; copy the address bar URL anyway.`
    : "";

  return [
    `MCP OAuth required for "${serverName}".`,
    "",
    "Open this URL in your local browser:",
    "",
    authorizationUrl,
    "",
    "After approval reaches this Pi session's callback, complete without copying the callback URL or code:",
    `mcp({ action: "auth-complete", server: "${serverName}" })`,
    "",
    "If the browser cannot reach the callback, copy the full redirected localhost URL from your address bar and send it back with:",
    `mcp({ action: "auth-complete", server: "${serverName}", args: { redirectUrl: "PASTE_REDIRECT_URL_HERE" } })`,
    "",
    'You can also pass just the `code` query parameter as `args: { code: "PASTE_CODE_HERE" }`.',
    portNote.trimEnd(),
  ].filter(Boolean).join("\n");
}

async function attemptAutoAuth(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<AutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition) || !supportsOAuth(definition)) {
    return { status: "skipped" };
  }

  let serverUrl: string | undefined;
  try {
    serverUrl = resolveServerUrl(definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: getAuthFailedMessage(state, serverName, message) };
  }
  if (!serverUrl) {
    return { status: "skipped" };
  }

  if (!state.ui && !isNonInteractiveOAuth(definition.oauth)) {
    return {
      status: "failed",
      message: getAuthRequiredMessage(
        state,
        serverName,
        `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    if (state.authStorageOptions) {
      await authenticate(
        serverName,
        serverUrl,
        definition,
        signal
          ? { authStorageOptions: state.authStorageOptions, signal, runtime: state.oauthRuntime }
          : { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime },
      );
    } else {
      if (signal) {
        await authenticate(serverName, serverUrl, definition, { signal, runtime: state.oauthRuntime });
      } else {
        await authenticate(serverName, serverUrl, definition, { runtime: state.oauthRuntime });
      }
    }
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getAuthFailedMessage(state, serverName, message),
    };
  }
}

export function executeUiMessages(state: McpExtensionState): ProxyToolResult {
  const sessions = state.completedUiSessions;

  if (sessions.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No UI session messages available." }],
      details: { sessions: 0 },
    };
  }

  const output: string[] = [];
  output.push(`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`);

  const allPrompts: string[] = [];
  const allIntents = sessions.flatMap((session) => session.messages.intents);
  const allContexts = sessions.flatMap((session) => session.messages.contexts);
  const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> = [];

  for (const session of sessions) {
    const timestamp = session.completedAt.toLocaleTimeString();
    output.push(`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`);

    const plainPrompts: string[] = [];
    for (const prompt of session.messages.prompts) {
      allPrompts.push(prompt);
      const handoff = parseUiPromptHandoff(prompt);
      if (handoff) {
        parsedHandoffs.push(handoff);
      } else {
        plainPrompts.push(prompt);
      }
    }

    if (plainPrompts.length > 0) {
      output.push("\n### Prompts:");
      for (const prompt of plainPrompts) {
        output.push(`- ${prompt}`);
      }
    }

    const intentsForSession = [
      ...session.messages.intents,
      ...session.messages.prompts
        .map((prompt) => parseUiPromptHandoff(prompt))
        .filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
        .map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
    ];

    if (intentsForSession.length > 0) {
      output.push("\n### Intents:");
      for (const intent of intentsForSession) {
        const params = intent.params ? ` (${JSON.stringify(intent.params)})` : "";
        output.push(`- ${intent.intent}${params}`);
      }
    }

    const contexts = session.messages.contexts;
    if (contexts.length > 0) {
      output.push("\n### Context updates:");
      for (const context of contexts) {
        output.push(`- ${context.summary}${context.truncated ? " (truncated)" : ""}`);
      }
    }

    if (session.messages.notifications.length > 0) {
      output.push("\n### Notifications:");
      for (const notification of session.messages.notifications) {
        output.push(`- ${notification}`);
      }
    }
  }

  const count = sessions.length;
  state.completedUiSessions = [];

  return {
    content: [{ type: "text" as const, text: output.join("\n") }],
    details: {
      sessions: count,
      prompts: allPrompts,
      intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
      contexts: allContexts,
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null; disabled?: boolean }> = [];

  for (const name of Object.keys(state.config.mcpServers)) {
    const definition = state.config.mcpServers[name];
    const disabled = isServerDisabled(definition);
    const connection = disabled ? undefined : state.manager.getConnection(name);
    const metadata = disabled ? undefined : state.toolMetadata.get(name);
    const toolCount = metadata?.filter(tool => !tool.resourceUri).length ?? 0;
    const failedAgo = disabled ? null : getFailureAgeSeconds(state, name);
    let status = disabled ? "disabled" : "not connected";
    if (!disabled && connection?.status === "connected") {
      status = "connected";
    } else if (!disabled && connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (!disabled && failedAgo !== null) {
      status = "failed";
    } else if (!disabled && metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo, ...(disabled ? { disabled: true } : {}) });
  }

  const disabledCount = servers.filter(s => s.disabled).length;
  const enabledServers = servers.filter(s => !s.disabled);
  const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = enabledServers.filter(s => s.status === "connected").length;
  const coverage = catalogCoverage(state);

  let text = `MCP: ${connectedCount}/${enabledServers.length} connected, ${totalTools} tools available (calls connect lazily)`;
  if (disabledCount > 0) text += ` (${disabledCount} disabled)`;
  text += "\n\n";
  for (const server of servers) {
    if (server.disabled) {
      text += `⊘ ${server.name} (disabled)\n`;
      continue;
    }
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "needs-auth") {
      text += `⚠ ${server.name} (needs auth)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not discovered)\n`;
  }

  if (servers.length > 0) {
    text += `\nmcp_search({ query: "...", server: "name" }) to discover tools; mcp({ action: "resources", server: "name" }) for resources.`;
    if (!coverage.complete) text += `\nPartial catalog: ${coverage.unknownServers.length} undiscovered server(s).`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount, disabledCount, coverage },
  };
}

export async function executeAuthStart(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.` }],
      details: { mode: "auth-start", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("auth-start", serverName);

  try {
    const serverUrl = resolveServerUrl(definition);
    if (!serverUrl || !supportsOAuth(definition)) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" is not configured for OAuth over HTTP.` }],
        details: { mode: "auth-start", error: "oauth_not_supported", server: serverName },
      };
    }

    const { authorizationUrl } = state.authStorageOptions
      ? ownedSignal
        ? await startAuth(serverName, serverUrl, definition, { authStorageOptions: state.authStorageOptions, signal: ownedSignal, runtime: state.oauthRuntime })
        : await startAuth(serverName, serverUrl, definition, { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime })
      : ownedSignal
        ? await startAuth(serverName, serverUrl, definition, { signal: ownedSignal, runtime: state.oauthRuntime })
        : await startAuth(serverName, serverUrl, definition, { runtime: state.oauthRuntime });
    if (!authorizationUrl) {
      return {
        content: [{ type: "text" as const, text: `OAuth authentication successful for "${serverName}".` }],
        details: { mode: "auth-start", server: serverName, authenticated: true },
      };
    }

    return {
      content: [{ type: "text" as const, text: formatManualAuthInstructions(serverName, authorizationUrl) }],
      details: { mode: "auth-start", server: serverName, authorizationUrl },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to start OAuth for "${serverName}": ${message}` }],
      details: { mode: "auth-start", error: "auth_start_failed", server: serverName, message },
    };
  }
}

export async function executeAuthComplete(state: McpExtensionState, serverName: string, input?: string, signal?: AbortSignal): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.` }],
      details: { mode: "auth-complete", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("auth-complete", serverName);

  try {
    const previousConnection = state.manager.getConnection(serverName);
    const status = state.authStorageOptions
      ? ownedSignal
        ? await completeAuthFromInput(serverName, input, { authStorageOptions: state.authStorageOptions, signal: ownedSignal, runtime: state.oauthRuntime })
        : await completeAuthFromInput(serverName, input, { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime })
      : ownedSignal
        ? await completeAuthFromInput(serverName, input, { signal: ownedSignal, runtime: state.oauthRuntime })
        : await completeAuthFromInput(serverName, input, { runtime: state.oauthRuntime });
    if (status !== "authenticated") {
      return {
        content: [{ type: "text" as const, text: `OAuth authentication did not complete for "${serverName}".` }],
        details: { mode: "auth-complete", error: "not_authenticated", server: serverName, status },
      };
    }

    if (previousConnection) state.manager.retire(serverName, previousConnection);
    clearFailure(state, serverName);
    updateStatusBar(state);
    return {
      content: [{ type: "text" as const, text: `OAuth authentication successful for "${serverName}". Run mcp({ action: "connect", server: "${serverName}" }) to connect with the new token.` }],
      details: { mode: "auth-complete", server: serverName, authenticated: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to complete OAuth for "${serverName}": ${message}` }],
      details: { mode: "auth-complete", error: "auth_complete_failed", server: serverName, message },
    };
  }
}

export function executeDescribe(state: McpExtensionState, toolName: string, serverFilter?: string): ProxyToolResult {
  if (serverFilter && isServerDisabled(state.config.mcpServers[serverFilter])) return disabledResult("describe", serverFilter);
  const catalog = [...state.toolMetadata].flatMap(([server, tools]) =>
    (!serverFilter || serverFilter === server) && state.config.mcpServers[server] && !isServerDisabled(state.config.mcpServers[server])
      ? tools.map(tool => ({ server, tool })) : []);
  const originals = serverFilter ? catalog.filter(({ tool }) => tool.originalName === toolName) : [];
  const exact = originals.length ? originals : catalog.filter(({ tool }) => tool.name === toolName);
  const matches = exact.length ? exact : catalog.filter(({ tool }) => tool.name.replace(/-/g, "_") === toolName.replace(/-/g, "_"));
  if (matches.length > 1) return {
    content: [{ type: "text", text: `Tool ${JSON.stringify(toolName)} is ambiguous. Specify server and original tool name: ${JSON.stringify(matches.map(({ server, tool }) => ({ server, tool: tool.originalName })))}` }],
    details: { mode: "describe", error: "ambiguous_tool", requestedTool: toolName },
  };
  const match = matches[0];
  if (!match) {
    const disabled = [...state.toolMetadata].find(([server, tools]) => isServerDisabled(state.config.mcpServers[server]) && findToolByName(tools, toolName));
    if (disabled) return disabledResult("describe", disabled[0]);
    const suggestions = rankSuggestions(state, toolName, 5, serverFilter);
    const hint = suggestions.length > 0
      ? `Did you mean: ${suggestions.join(", ")}. Inspect with mcp({ action: "describe", tool: "${suggestions[0]}" }).`
      : `Use mcp_search({ query: "..." }) to search.`;
    return {
      content: [{ type: "text", text: `Tool "${toolName}" not found. ${hint}` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName, suggestions },
    };
  }
  const { server: serverName, tool: toolMeta } = match;
  const descriptor = toToolDescriptor(serverName, toolMeta);
  const approvalRequired = isToolCallApprovalRequired(state.config, serverName, toolMeta);
  return {
    content: [{ type: "text", text: JSON.stringify({ ...descriptor, ...(toolMeta.resourceUri ? { resourceUri: toolMeta.resourceUri, readWith: { action: "read-resource", server: serverName, uri: toolMeta.resourceUri } } : {}), ...(approvalRequired ? { approvalRequired: true } : {}) }, null, 2) }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

export function executeSearch(
  state: McpExtensionState,
  query: string,
  server?: string,
  includeSchemas?: boolean,
  limit = 12,
  offset = 0,
  caller: "mcp" | "mcp_search" = "mcp",
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;
  const searchCall = (nextOffset: number | null) =>
    `${caller}({ ${caller === "mcp" ? 'action: "search", ' : ""}query: ${JSON.stringify(query)}${server ? `, server: ${JSON.stringify(server)}` : ""}${caller === "mcp" && !showSchemas ? ", includeSchemas: false" : ""}, limit: ${limit}, offset: ${nextOffset} })`;
  if (server && isServerDisabled(state.config.mcpServers[server])) return disabledResult("search", server);

  let matches: Array<{ server: string; tool: ToolMetadata; score: number }>;
  if (query.trim().length === 0) {
    if (!server) {
      return {
        content: [{ type: "text" as const, text: "Search query cannot be empty" }],
        details: { mode: "search", error: "empty_query" },
      };
    }
    matches = (state.toolMetadata.get(server) ?? []).filter(tool => !tool.resourceUri)
      .map(tool => ({ server, tool, score: 0 }))
      .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  } else {
    matches = rankToolMatches(state, query, server);
  }

  const page = paginate(matches, offset, limit);
  const coverage = catalogCoverage(state, server);
  const coverageNotice = coverage.complete ? "" : `\nCatalog is incomplete. Undiscovered servers: ${coverage.unknownServers.join(", ")}. Search with server to discover one.`;
  if (page.total === 0) {
    const msg = server ? `No tools matching "${query}" in "${server}"` : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg + coverageNotice }],
      details: { mode: "search", matches: [], count: 0, hasMore: false, nextOffset: null, query, coverage },
    };
  }
  if (page.items.length === 0) {
    const retry = searchCall(0);
    return {
      content: [{ type: "text" as const, text: `No search results at offset ${offset}; ${page.total} tools match. Retry with ${retry}.` }],
      details: { mode: "search", error: "offset_out_of_range", matches: [], count: page.total, hasMore: false, nextOffset: null, query },
    };
  }

  let text = `Found ${page.total} tool${page.total === 1 ? "" : "s"} matching "${query}":\n\n`;
  for (const match of page.items) {
    const approvalMarker = isToolCallApprovalRequired(state.config, match.server, match.tool)
      ? " (requires approval)"
      : "";
    if (showSchemas) {
      text += `${JSON.stringify({ ...toToolDescriptor(match.server, match.tool), ...(approvalMarker ? { approvalRequired: true } : {}) }, null, 2)}\n\n`;
    } else {
      text += `- ${match.tool.name}${approvalMarker}`;
      if (match.tool.description) text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      text += "\n";
    }
  }
  const first = (Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0) + 1;
  const nextSearch = searchCall(page.nextOffset);
  text += page.hasMore
    ? `\n${first}-${first + page.items.length - 1} of ${page.total} — ${nextSearch} for more\n`
    : `\n${first}-${first + page.items.length - 1} of ${page.total} — end\n`;

  return {
    content: [{ type: "text" as const, text: text.trim() + coverageNotice }],
    details: {
      mode: "search",
      coverage,
      matches: page.items.map(match => ({ server: match.server, tool: match.tool.name, score: match.score })),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string, limit = 12, offset = 0): ProxyToolResult {
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({ action: "status" }) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("list", server);

  const metadata = state.toolMetadata.get(server)?.filter(tool => !tool.resourceUri);
  const connection = state.manager.getConnection(server);
  const instructions = state.serverInstructions.get(server);
  let instructionsText = "";
  if (instructions) {
    const preview = truncateAtWord(instructions, INSTRUCTIONS_PREVIEW_LENGTH);
    instructionsText = `\n\nServer instructions:\n${preview}`;
    if (preview !== instructions) {
      instructionsText += `\nUse mcp({ action: "instructions", server: "${server}" }) for the full text.`;
    }
  }

  if (!metadata?.length) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.${instructionsText}` }],
        details: { mode: "list", server, tools: [], count: 0, hasInstructions: Boolean(instructions) },
      };
    }
    if (metadata !== undefined) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).${instructionsText}` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true, hasInstructions: Boolean(instructions) },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ action: "connect", server: "${server}" }) or /mcp reconnect ${server} to retry.${instructionsText}` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected", hasInstructions: Boolean(instructions) },
    };
  }

  const page = paginate(metadata, offset, limit);
  if (page.items.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No tools at offset ${offset}; "${server}" has ${page.total} tools. Retry with mcp({ action: "list", server: ${JSON.stringify(server)}, limit: ${limit}, offset: 0 }).` }],
      details: { mode: "list", error: "offset_out_of_range", server, tools: [], count: page.total, hasMore: false, nextOffset: null, hasInstructions: Boolean(instructions) },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : ", not connected, cached";
  let text = `${server} (${page.total} tools${cachedNote}):\n\n`;

  for (const tool of page.items) {
    const description = truncateAtWord(tool.description, 50);
    text += `- ${tool.name}`;
    if (description) text += ` - ${description}`;
    text += "\n";
  }
  const first = (Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0) + 1;
  text += page.hasMore
    ? `\n${first}-${first + page.items.length - 1} of ${page.total} — mcp({ action: "list", server: ${JSON.stringify(server)}, limit: ${limit}, offset: ${page.nextOffset} }) for more`
    : `\n${first}-${first + page.items.length - 1} of ${page.total} — end`;
  text += instructionsText;

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "list",
      server,
      tools: page.items.map(tool => tool.name),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      hasInstructions: Boolean(instructions),
    },
  };
}

export function executeInstructions(state: McpExtensionState, server: string): ProxyToolResult {
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({ action: "status" }) to see available servers.` }],
      details: { mode: "instructions", server, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("instructions", server);

  const instructions = state.serverInstructions.get(server);
  if (instructions) {
    return {
      content: [{ type: "text" as const, text: `${server} instructions:\n\n${instructions}` }],
      details: { mode: "instructions", server, length: instructions.length },
    };
  }

  const connection = state.manager.getConnection(server);
  if (connection?.status === "connected") {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" does not provide instructions.` }],
      details: { mode: "instructions", server, error: "no_instructions" },
    };
  }

  return {
    content: [{ type: "text" as const, text: `No instructions cached for "${server}". Use mcp({ action: "connect", server: "${server}" }) to connect and refresh.` }],
    details: { mode: "instructions", server, error: "not_connected" },
  };
}

export async function executeConnect(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
  limit?: number,
  offset?: number,
): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("connect", serverName);

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
    }
    const currentConnection = state.manager.getConnection(serverName);
    let connection = currentConnection?.status === "connected"
      ? await state.manager.reconnect(serverName, definition, currentConnection, ownedSignal)
      : await state.manager.connect(serverName, definition, ownedSignal);
    if (connection.status === "needs-auth") {
      const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        throwIfAborted(ownedSignal);
        connection = await state.manager.reconnect(serverName, definition, connection, ownedSignal);
      }
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message },
        };
      }
    }
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    state.resourceCounts?.set(serverName, connection.resources.length);
    if (!connection.promptDiscoveryFailed) {
      state.promptMetadata?.set(serverName, reconstructPromptMetadata(serverName, connection.prompts ?? [], prefix, definition));
      state.promptMetadataLive?.add(serverName);
    }
    if (connection.instructions) {
      state.serverInstructions.set(serverName, connection.instructions);
    } else {
      state.serverInstructions.delete(serverName);
    }
    updateMetadataCache(state, serverName);
    notifyToolMetadataUpdated(state, serverName, "proxy-connect");
    markKeepAliveAfterConnect(state, serverName);
    clearFailure(state, serverName);
    updateStatusBar(state);
    return executeList(state, serverName, limit, offset);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAbortError(error, ownedSignal)) recordFailure(state, serverName, message);
    updateStatusBar(state);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: isAbortError(error, ownedSignal) ? "aborted" : "connect_failed", server: serverName, message },
    };
  }
}

/** The part of a tool call that is identical for proxy and direct tools. */
type ToolCallTarget = Pick<ToolMetadata, "originalName" | "inputSchema" | "annotations" | "resourceUri" | "uiResourceUri" | "uiStreamMode">;

interface ToolCallOptions extends McpToolCallIdentity {
  beforeDispatch?: (signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>;
  /** Spread into every details payload: identity, and `mode` for proxy calls. */
  detailsBase: Record<string, unknown>;
  ownedSignal: AbortSignal | undefined;
  /** Caller-supplied signal, passed to the UI session rather than the MCP call. */
  signal: AbortSignal | undefined;
  recoverAuthConnection: NonNullable<SessionRecoveryDeps["onNeedsAuth"]>;
  authRequiredMessage: () => string;
  autoAuthAttempted: () => boolean;
  raw?: boolean;
}

/**
 * Executes an already-approved tool call against a connected server.
 *
 * Direct, gateway, resource and script calls share executeCall preparation.
 * Raw scripts skip content rendering but retain protocol results and artifacts.
 */
export async function runToolCall(
  state: McpExtensionState,
  serverName: string,
  target: ToolCallTarget,
  args: Record<string, unknown> | undefined,
  options: ToolCallOptions,
): Promise<ProxyToolResult> {
  const { detailsBase, signal, recoverAuthConnection, authRequiredMessage, autoAuthAttempted } = options;
  const configuredOptions = state.manager.getRequestOptions?.(serverName, options.ownedSignal);
  const callerSignal = combineAbortSignals(configuredOptions?.signal, options.ownedSignal);
  const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings, state.outputDirectory);
  // Lazy: formatSchema recurses, so only pay for it (and only risk it throwing)
  // on the error paths that actually print it.
  const schemaSuffix = () => target.inputSchema ? `\n\nExpected parameters:\n${formatSchema(target.inputSchema)}` : "";
  let uiSession: UiSessionRuntime | null = null;
  const identity = {
    server: serverName, tool: target.originalName,
    ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
    ...(options.innerCallId !== undefined ? { innerCallId: options.innerCallId } : {}),
  };
  let beforeDispatchPending = false;
  let captureFailure: McpToolCallEvent | undefined;
  const capture = async (event: McpToolCallEvent) => {
    if (!state.onToolCall) return;
    try {
      const run = () => state.onToolCall!(event);
      await abortable(state.owner ? state.owner.runCallback("onToolCall", run) : run(), event.signal);
      throwIfAborted(event.signal);
    } catch (error) {
      captureFailure = event;
      throw error;
    }
  };

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    uiSession = !target.resourceUri && target.uiResourceUri
      ? await abortable(maybeStartUiSession(state, {
          serverName,
          toolName: target.originalName,
          toolArgs: args ?? {},
          uiResourceUri: target.uiResourceUri,
          ...(target.uiStreamMode !== undefined ? { streamMode: target.uiStreamMode } : {}),
          ...(signal ? { signal } : {}),
          onNeedsAuth: recoverAuthConnection,
        }), callerSignal)
      : null;

    // UI preparation can replace the connection; use its current annotations.
    const liveTools = state.manager.getConnection(serverName)?.tools;
    const annotations = liveTools
      ? liveTools.find(tool => tool.name === target.originalName)?.annotations
      : target.annotations;
    const operation = {
      ...identity, args: args ?? {},
      ...(annotations !== undefined ? { annotations } : {}),
      ...(target.resourceUri ? { resourceUri: target.resourceUri } : {}),
    };
    if (options.beforeDispatch) {
      beforeDispatchPending = true;
      const run = () => options.beforeDispatch!(callerSignal, {
        ...operation, annotationsTrusted: state.config.mcpServers[serverName]?.retryOnTransportFailure === true,
      });
      await abortable(state.owner ? state.owner.runCallback("beforeExecute", run) : run(), callerSignal);
      beforeDispatchPending = false;
    }
    throwIfAborted(callerSignal);

    // Host checkpoints and UI preparation do not consume the service deadline.
    const ownedSignal = combineAbortSignals(callerSignal, AbortSignal.timeout(Math.ceil(configuredOptions?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC)))!;
    const requestOptions = { ...configuredOptions, signal: ownedSignal };
    const recovery = { manager: state.manager, config: state.config, signal: ownedSignal, onNeedsAuth: recoverAuthConnection };
    const call = { ...operation, signal: ownedSignal };
    await capture({ ...call, phase: "before" });
    throwIfAborted(ownedSignal);
    const dispatch = async <T>(fn: () => Promise<T>): Promise<T> => {
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        await capture({ ...call, phase: "after", error });
        throw error;
      }
      await capture({ ...call, phase: "after", result });
      return result;
    };

    const result = target.resourceUri
      ? await dispatch(() => withSessionRecovery(
          recovery, serverName,
          conn => abortable(conn.client.readResource({ uri: target.resourceUri! }, requestOptions), ownedSignal),
        ))
      : await dispatch(() => trackToolCallOutcome(() => withSessionRecovery<ClientCallToolResult>(
          { ...recovery, retryOnTransportFailure: annotations?.readOnlyHint === true || annotations?.idempotentHint === true },
          serverName,
          conn => abortable(conn.client.callTool({ name: target.originalName, arguments: args ?? {}, _meta: uiSession?.requestMeta }, requestOptions), ownedSignal),
        ), ownedSignal));
    if (!target.resourceUri) uiSession?.sendToolResult(result as ClientCallToolResult);
    const record = result as Record<string, unknown>;
    const isError = record.isError === true;
    const uiSummary = target.uiResourceUri ? summarizeUiSessionResult(uiSession) : undefined;
    const details = {
      ...detailsBase,
      ...(isError ? { error: "tool_error" } : {}),
      ...(uiSummary ? { uiOpen: uiSummary.uiOpen, uiViewer: uiSummary.uiViewer, uiUrl: uiSummary.uiUrl } : {}),
    };
    const retained = await retainMcpResult(result, outputGuardOptions, options.raw);
    if (options.raw) {
      const message = isError
        ? (Array.isArray(record.content) ? record.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "") || "Tool execution failed" : undefined;
      return { content: [], details: { ...details, ...retained, ...(message ? { message } : {}) } };
    }
    const content = renderMcpResultContent(record, retained.payloadFiles);
    const guarded = await guardMcpOutput(content.length ? content : [{ type: "text", text: target.resourceUri ? "(empty resource)" : "(empty result)" }], {
      ...outputGuardOptions, retainedMcpResult: retained,
      ...(isError ? { prefix: "Error: ", suffix: schemaSuffix(), emptyTextFallback: "Tool execution failed" }
        : uiSummary ? { suffix: `\n\n${uiSummary.message}` } : {}),
    });
    return { content: guarded.content, details: { ...details, ...guardedMcpDetails(guarded) } };
  } catch (error) {
    // Direct/proxy host errors throw; scripts retain their failed-call envelope.
    if (beforeDispatchPending && options.innerCallId === undefined) throw error;
    if (captureFailure) {
      const { signal: _signal, ...context } = captureFailure;
      const message = captureFailure.phase === "before"
        ? "MCP call capture failed before dispatch; the tool did not run. Restore capture before continuing."
        : "MCP outcome capture failed. Use the retained outcome to continue the original work; do not repeat a completed call or rerun the script.";
      uiSession?.sendToolCancelled(message);
      const retained = "result" in captureFailure && captureFailure.result !== undefined
        ? await retainMcpResult(captureFailure.result, { ...outputGuardOptions, enabled: true, detailsMaxBytes: 1 }) : {};
      return {
        content: [{ type: "text", text: message }, ...(retained.resultRef ? [{ type: "text" as const, text: formatMcpResultReference(retained.resultRef) }] : [])],
        details: { ...detailsBase, ...retained, error: isAbortError(error, callerSignal) ? "aborted" : "call_capture_failed", message, recovery: context },
      };
    }
    if (isToolTransportFailure(error) || isInterruptedToolCall(error)) {
      const message = `The outcome of MCP tool "${target.originalName}" on "${serverName}" is unknown after the call was interrupted. Read back the original operation using its saved arguments and provider identity before continuing. Do not blindly repeat the call or rerun its script.`;
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text", text: message }],
        details: { ...detailsBase, error: "ambiguous_outcome", message, recovery: { ...identity, action: "readback" } },
      };
    }
    if (error instanceof SessionRecoveryAuthRequiredError) {
      const message = error.authMessage ?? authRequiredMessage();
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { ...detailsBase, error: "auth_required", message, autoAuthAttempted: autoAuthAttempted() },
      };
    }
    if (error instanceof UrlElicitationRequiredError) {
      const action = await state.manager.handleUrlElicitationRequired(serverName, error);
      const message = action === "accept"
        ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
        : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { ...detailsBase, error: "url_elicitation_required", action },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    uiSession?.sendToolCancelled(message);
    const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaSuffix() });
    return {
      content: guarded.content,
      details: {
        ...detailsBase,
        error: isAbortError(error, callerSignal) ? "aborted" : "call_failed",
        message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
        ...guardedMcpDetails(guarded),
      },
    };
  } finally {
    if (uiSession?.reused) {
      uiSession.close();
    }
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
  }
}

export interface ExecuteCallOptions {
  exactOriginalName?: boolean;
  resourceUri?: string;
  /** Scripts receive the raw protocol result without model-facing content transformation. */
  raw?: boolean;
}

/** Connect/auth once for calls and resource discovery. Recovery stays bounded by withSessionRecovery. */
export async function prepareMcpConnection(state: McpExtensionState, serverName: string, signal?: AbortSignal) {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  let autoAuthAttempted = false;
  const recoverAuthConnection: NonNullable<SessionRecoveryDeps["onNeedsAuth"]> = async (_name, recoverySignal = ownedSignal, challenge) => {
    throwIfAborted(recoverySignal);
    const current = state.manager.getConnection(serverName);
    if (current?.status === "connected" && current !== challenge?.connection) return current;
    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const auth = await attemptAutoAuth(state, serverName, recoverySignal);
      throwIfAborted(recoverySignal);
      if (auth.status === "failed") throw new SessionRecoveryAuthRequiredError(serverName, auth.message);
      if (auth.status === "success" && current) {
        clearFailure(state, serverName);
        const definition = state.config.mcpServers[serverName];
        if (!definition) return undefined;
        state.ui?.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
        await state.manager.reconnect(serverName, definition, current, recoverySignal);
        if (await lazyConnect(state, serverName, recoverySignal)) {
          updateStatusBar(state);
          return state.manager.getConnection(serverName);
        }
      }
    }
    return challenge ? undefined : state.manager.getConnection(serverName);
  };
  const failure = (error: string, message: string) => ({
    content: [{ type: "text" as const, text: message }],
    details: { mode: "call", error, server: serverName, message },
  });
  const definition = state.config.mcpServers[serverName];
  if (!definition) return { error: failure("server_not_found", `Server "${serverName}" not found.`) };
  if (isServerDisabled(definition)) return { error: disabledResult("call", serverName) };
  try {
    // Connected metadata is read below, so it does not require another connection attempt.
    let connection = state.manager.getConnection(serverName);
    if (connection?.status !== "connected") {
      await lazyConnect(state, serverName, ownedSignal);
      connection = state.manager.getConnection(serverName);
    } else {
      markKeepAliveAfterConnect(state, serverName);
    }
    if (connection?.status === "needs-auth") connection = await recoverAuthConnection(serverName, ownedSignal);
    if (connection?.status === "needs-auth") throw new SessionRecoveryAuthRequiredError(serverName);
    if (connection?.status !== "connected") {
      const failedAgo = getFailureAgeSeconds(state, serverName);
      return { error: failure(failedAgo === null ? "server_unavailable" : "server_backoff", `Server "${serverName}" not available${failedAgo === null ? "" : ` (last failed ${failedAgo}s ago)`}`) };
    }
    // Use the live descriptor for visibility, filtering, approval, schema and UI hints.
    if (connection.tools) {
      const { metadata } = buildToolMetadata(connection.tools, connection.resources ?? [], definition, serverName, state.config.settings?.toolPrefix ?? "server");
      state.toolMetadata.set(serverName, metadata);
    }
    return { connection, recoverAuthConnection, autoAuthAttempted: () => autoAuthAttempted };
  } catch (error) {
    if (isAbortError(error, ownedSignal)) throw error;
    const message = error instanceof SessionRecoveryAuthRequiredError
      ? error.authMessage ?? getAuthRequiredMessage(state, serverName)
      : error instanceof Error ? error.message : String(error);
    if (!(error instanceof SessionRecoveryAuthRequiredError)) {
      recordFailure(state, serverName, message);
      updateStatusBar(state);
    }
    return { error: failure(error instanceof SessionRecoveryAuthRequiredError ? "auth_required" : "connect_failed", message) };
  }
}

export async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
  identity: McpToolCallIdentity = {},
  beforeDispatch?: (signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>,
  options: ExecuteCallOptions = {},
): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  if (typeof toolName !== "string" || !toolName.trim() || (serverOverride !== undefined && (typeof serverOverride !== "string" || !serverOverride))) return {
    content: [{ type: "text", text: "Specify a non-empty tool name and, when supplied, server." }],
    details: { mode: "call", error: "invalid_arguments" },
  };
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return {
    content: [{ type: "text", text: "Tool arguments must be an object." }],
    details: { mode: "call", error: "invalid_arguments", requestedTool: toolName },
  };
  let serverName = serverOverride;
  const matches = (metadata: ToolMetadata[] = []) => {
    if (options.resourceUri !== undefined) return metadata.filter(tool => tool.resourceUri === options.resourceUri);
    if (options.exactOriginalName) return metadata.filter(tool => tool.originalName === toolName && !tool.resourceUri);
    if (serverOverride) {
      const originals = metadata.filter(tool => tool.originalName === toolName);
      if (originals.length) return originals;
    }
    const exact = metadata.filter(tool => tool.name === toolName);
    if (exact.length) return exact;
    return metadata.filter(tool => tool.name.replace(/-/g, "_") === toolName.replace(/-/g, "_"));
  };
  const ambiguous = (): ProxyToolResult => ({
    content: [{ type: "text", text: `Tool "${toolName}" is ambiguous. Specify its exact server and tool name; no call was dispatched.` }],
    details: { mode: "call", error: "ambiguous_tool", requestedTool: toolName, ...(serverName ? { server: serverName } : {}) },
  });
  if (!serverName) {
    const candidates = [...state.toolMetadata].flatMap(([server, metadata]) =>
      isServerDisabled(state.config.mcpServers[server]) ? [] : matches(metadata).map(tool => ({ server, tool })));
    if (candidates.length > 1) return ambiguous();
    serverName = candidates[0]?.server;
    if (!serverName) {
      const disabled = [...state.toolMetadata].find(([server, metadata]) => isServerDisabled(state.config.mcpServers[server]) && matches(metadata).length > 0);
      if (disabled) return disabledResult("call", disabled[0]);
      const prefixes = Object.entries(state.config.mcpServers)
        .filter(([, definition]) => !isServerDisabled(definition))
        .map(([server, definition]) => ({ server, prefix: getServerPrefix(server, resolveToolPrefix(definition, state.config.settings?.toolPrefix ?? "server")) }))
        .filter(({ prefix }) => prefix && toolName.startsWith(`${prefix}_`))
        .sort((a, b) => b.prefix.length - a.prefix.length);
      if (prefixes.length > 1 && prefixes[0]?.prefix === prefixes[1]?.prefix) return ambiguous();
      serverName = prefixes[0]?.server;
    }
  }
  const missing = (): ProxyToolResult => {
    const nativeTool = !serverOverride && getPiTools?.().find(tool => tool.name === toolName && tool.name !== "mcp");
    if (nativeTool) return {
      content: [{ type: "text", text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ action: "call", tool: "${toolName}" }).` }],
      details: { mode: "call", error: "native_tool", requestedTool: toolName },
    };
    const normalizedName = toolName.replace(/-/g, "_");
    const localOriginal = serverOverride && state.toolMetadata.get(serverOverride)?.some(tool => tool.originalName.replace(/-/g, "_") === normalizedName);
    const owners = serverOverride && !localOriginal
      ? [...state.toolMetadata].filter(([server, metadata]) => server !== serverOverride && !isServerDisabled(state.config.mcpServers[server]) && matches(metadata).length === 1)
      : [];
    const suggestedOwner = owners.length === 1 ? owners[0] : undefined;
    if (suggestedOwner) return {
      content: [{ type: "text", text: `Tool ${JSON.stringify(toolName)} is on server ${JSON.stringify(suggestedOwner[0])}, not ${JSON.stringify(serverOverride)}. Retry the same call with server: ${JSON.stringify(suggestedOwner[0])} or omit server.` }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer: serverName, suggestedServer: suggestedOwner[0], suggestions: matches(suggestedOwner[1]).map(tool => tool.name) },
    };
    const suggestions = rankSuggestions(state, toolName, 5, serverName);
    let hint = suggestions.length
      ? ` Did you mean: ${suggestions.join(", ")}. Inspect with mcp({ action: "describe", tool: ${JSON.stringify(suggestions[0])} }).`
      : serverName ? ` Search with mcp({ action: "search", query: ${JSON.stringify(toolName)}, server: ${JSON.stringify(serverName)} }).` : ' Use mcp({ action: "search", query: "..." }) to search.';
    if (serverName && state.toolMetadata.has(serverName) && state.manager.getConnection(serverName)?.status !== "connected") hint += ` Refresh a stale catalog with mcp({ action: "connect", server: ${JSON.stringify(serverName)} }).`;
    return {
      content: [{ type: "text", text: `Tool "${toolName}" not found.${hint}` }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer: serverName, suggestions },
    };
  };
  if (!serverName) return missing();
  const definition = state.config.mcpServers[serverName];
  if (!definition) return { content: [{ type: "text", text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.` }], details: { mode: "call", error: "server_not_found", server: serverName, requestedTool: toolName } };
  if (isServerDisabled(definition)) return disabledResult("call", serverName);
  const cached = state.toolMetadata.get(serverName);
  if (matches(cached).length > 1) return ambiguous();
  // Misspellings in a known catalog do not cause connection churn or guessed execution.
  if (cached && !matches(cached).length && !options.exactOriginalName && options.resourceUri === undefined) return missing();

  const prepared = await prepareMcpConnection(state, serverName, ownedSignal);
  if (prepared.error) {
    const cachedTarget = matches(cached)[0];
    return { ...prepared.error, details: { ...prepared.error.details, ...(cachedTarget
      ? cachedTarget.resourceUri ? { resourceUri: cachedTarget.resourceUri } : { tool: cachedTarget.originalName }
      : { requestedTool: toolName }) } };
  }
  const targets = matches(state.toolMetadata.get(serverName));
  if (targets.length > 1) return ambiguous();
  const toolMeta = targets[0];
  if (!toolMeta) return missing();
  if (isServerDisabled(state.config.mcpServers[serverName])) return disabledResult("call", serverName);
  const approval = await ensureToolCallApproved(state, serverName, toolMeta, args, ownedSignal);
  if (!approval.ok) {
    const denied = approval.reason === "denied";
    return {
      content: [{ type: "text", text: denied
        ? `The user declined approval to run MCP tool "${toolMeta.originalName}" on server "${serverName}".`
        : `MCP tool "${toolMeta.originalName}" on server "${serverName}" is approval-gated and requires an interactive session.` }],
      details: { mode: "call", error: denied ? "approval_denied" : "approval_required", server: serverName, tool: toolMeta.originalName },
    };
  }
  return runToolCall(state, serverName, toolMeta, args, {
    ...identity,
    ...(beforeDispatch ? { beforeDispatch } : {}),
    ...(options.raw !== undefined ? { raw: options.raw } : {}),
    detailsBase: { mode: "call", server: serverName, ...(toolMeta.resourceUri ? { resourceUri: toolMeta.resourceUri } : { tool: toolMeta.originalName }) },
    ownedSignal, signal,
    recoverAuthConnection: prepared.recoverAuthConnection!,
    authRequiredMessage: () => getAuthRequiredMessage(state, serverName),
    autoAuthAttempted: prepared.autoAuthAttempted!,
  });
}
