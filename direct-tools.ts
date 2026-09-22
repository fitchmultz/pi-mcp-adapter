import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, ToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { lazyConnect, getFailureAgeSeconds, clearFailure, recordFailure, updateStatusBar } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { isServerCacheValid, parseDirectToolSelectors, reconstructToolMetadata } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { runToolCall } from "./proxy-modes.ts";
import { isServerDisabled, isNonInteractiveOAuth } from "./types.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage, resolveServerUrl } from "./utils.ts";
import { SessionRecoveryAuthRequiredError, type SessionRecoveryDeps } from "./session-recovery.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;
const advisedDirectToolSets = new Set<string>();

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (oauth && oauth.crossAppAccess) defaultMessage = `MCP server "${serverName}" requires enterprise authorization. Check oauth.crossAppAccess IdP configuration and ID-token source, then retry.`;
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (customGuidance || (oauth && oauth.crossAppAccess)) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<DirectAutoAuthResult> {
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
    return { status: "failed", message: getDirectAuthFailedMessage(state, serverName, message) };
  }
  if (!serverUrl) {
    return { status: "skipped" };
  }

  if (!state.ui && !isNonInteractiveOAuth(definition.oauth)) {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
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
      await authenticate(serverName, serverUrl, definition, {
        ...(signal ? { signal } : {}),
        runtime: state.oauthRuntime,
      });
    }
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getDirectAuthFailedMessage(state, serverName, message),
    };
  }
}

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    for (const { name: prefixedName, ...tool } of reconstructToolMetadata(serverName, serverCache, prefix, definition)) {
      if (tool.resourceUri !== undefined) continue;
      if (toolFilter !== true && !toolFilter.includes(tool.originalName)) continue;
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({ ...tool, serverName, prefixedName });
    }
  }

  const advisoryKey = specs.map(spec => spec.prefixedName).sort().join("\0");
  if (specs.length >= DIRECT_TOOLS_ADVISORY_THRESHOLD && !advisedDirectToolSets.has(advisoryKey)) {
    advisedDirectToolSets.add(advisoryKey);
    console.warn(`MCP: ${specs.length} direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered.`);
  }

  return specs;
}

export function buildProxyDescription(config: McpConfig): string {
  let desc = `MCP gateway — server status, tool search/describe, auth, and single MCP tool calls. When one request needs several MCP calls with logic between them, use mcp_script. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  // Catalog counts and instruction previews change on connect and break prompt caching.
  // Keep this directory config-only; discovery and instructions belong in tool results.
  const enabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([serverName]) => serverName)
    .sort();
  if (enabledServers.length > 0) {
    desc += `\nConfigured servers (call mcp({}) for live status): ${enabledServers.join(", ")}\n`;
  }

  const disabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => isServerDisabled(definition))
    .map(([serverName]) => serverName);
  if (disabledServers.length > 0) {
    desc += `\nDisabled servers (enable with /mcp enable <server> and /reload): ${disabledServers.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name", limit: 12 })    → Browse a server's tools (use offset for more)\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ instructions: "name" })         → Show full server usage instructions\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: { key: "value" } })         → Call a tool (object args; JSON string also accepted)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `  mcp({ action: "auth-start", server: "name" })      → Start manual OAuth and get a browser URL\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > instructions > search > server (list) > nothing (status)`;

  return desc;
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
): DirectToolExecute {
  return async function execute(toolCallId, params, signal, _onUpdate, ctx) {
    throwIfAborted(signal);
    let state = getState();
    const initPromise = getInitPromise();

    if (!state && initPromise) {
      try {
        state = await abortable(initPromise, signal);
      } catch (error) {
        throwIfAborted(signal);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    const definition = state.config.mcpServers[spec.serverName];
    if (isServerDisabled(definition)) {
      const message = `MCP server "${spec.serverName}" is disabled. Run /mcp enable ${spec.serverName} and /reload to enable it.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { error: "server_disabled", server: spec.serverName, message },
      };
    }

    const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
    throwIfAborted(ownedSignal);
    let connected = await lazyConnect(state, spec.serverName, ownedSignal);
    let autoAuthAttempted = false;

    const needsAuthConnection = state.manager.getConnection(spec.serverName);
    if (!connected && needsAuthConnection?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        clearFailure(state, spec.serverName);
        try {
          const liveDefinition = state.config.mcpServers[spec.serverName];
          if (liveDefinition) {
            await state.manager.reconnect(spec.serverName, liveDefinition, needsAuthConnection, ownedSignal);
            connected = true;
          }
        } catch (error) {
          if (isAbortError(error, ownedSignal)) throwIfAborted(ownedSignal);
          recordFailure(state, spec.serverName, error instanceof Error ? error.message : String(error));
          updateStatusBar(state);
        }
        if (connected) connected = await lazyConnect(state, spec.serverName, ownedSignal);
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    const approval = await ensureToolCallApproved(state, spec.serverName, {
      name: spec.prefixedName,
      originalName: spec.originalName,
      description: spec.description,
      ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.resourceUri !== undefined ? { resourceUri: spec.resourceUri } : {}),
      ...(spec.uiResourceUri !== undefined ? { uiResourceUri: spec.uiResourceUri } : {}),
      ...(spec.uiStreamMode !== undefined ? { uiStreamMode: spec.uiStreamMode } : {}),
    }, params, ownedSignal);
    if (approval.ok === false) {
      const denied = approval.reason === "denied";
      const message = denied
        ? `The user declined approval to run MCP tool "${spec.originalName}" on server "${spec.serverName}".`
        : `MCP tool "${spec.originalName}" on server "${spec.serverName}" is approval-gated and requires an interactive session.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: {
          error: denied ? "approval_denied" : "approval_required",
          server: spec.serverName,
          tool: spec.originalName,
        },
      };
    }

    const recoverAuthConnection: NonNullable<SessionRecoveryDeps["onNeedsAuth"]> = async (_serverName, recoverySignal = ownedSignal, challenge) => {
      throwIfAborted(recoverySignal);
      const current = state.manager.getConnection(spec.serverName);
      if (current?.status === "connected" && current !== challenge?.connection) return current;

      if (!autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, recoverySignal);
        throwIfAborted(recoverySignal);
        if (autoAuth.status === "failed") {
          throw new SessionRecoveryAuthRequiredError(spec.serverName, autoAuth.message);
        }
        if (autoAuth.status === "success") {
          const liveDefinition = state.config.mcpServers[spec.serverName];
          if (!current || !liveDefinition) return undefined;
          await state.manager.reconnect(spec.serverName, liveDefinition, current, recoverySignal);
          clearFailure(state, spec.serverName);
          const reconnected = await lazyConnect(state, spec.serverName, recoverySignal);
          return reconnected ? state.manager.getConnection(spec.serverName) : undefined;
        }
      }
      return challenge ? undefined : state.manager.getConnection(spec.serverName);
    };

    return runToolCall(state, spec.serverName, spec, params, {
      toolCallId,
      ...(beforeExecute ? { beforeDispatch: (callSignal, operation) => beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation) } : {}),
      detailsBase: spec.resourceUri
        ? { server: spec.serverName, resourceUri: spec.resourceUri }
        : { server: spec.serverName, tool: spec.originalName },
      ownedSignal,
      signal,
      recoverAuthConnection,
      authRequiredMessage: () => getDirectAuthRequiredMessage(state, spec.serverName),
      autoAuthAttempted: () => autoAuthAttempted,
    });
  };
}
