import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import { isServerDisabled, isNonInteractiveOAuth, type ServerDefinition } from "./types.ts";
import { formatAuthRequiredMessage, resolveServerUrl } from "./utils.ts";
import { supportsOAuth } from "./mcp-oauth-runtime.ts";
import { isAbortError, combineAbortSignals } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import { clearFailure, updateStatusBar } from "./init.ts";
type AutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

export function getAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `Server "${serverName}" requires OAuth authentication. If mcp is inactive, first mcp_search({ enable: ["gateway"] }). Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (typeof oauth === "object" && oauth !== null && oauth.crossAppAccess !== undefined) {
    return formatAuthRequiredMessage(
      state.config,
      serverName,
      `Server "${serverName}" requires enterprise authorization. Check oauth.crossAppAccess IdP configuration and ID-token source, then retry.`,
    );
  }
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(
  state: McpExtensionState,
  serverName: string,
  message: string,
): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  const oauth = state.config.mcpServers[serverName]?.oauth;
  if (
    (customGuidance ?? "").length > 0 ||
    (typeof oauth === "object" && oauth !== null && oauth.crossAppAccess !== undefined)
  ) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. If mcp is inactive, first mcp_search({ enable: ["gateway"] }). Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

function getRedirectPort(authorizationUrl: string): number | undefined {
  try {
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (redirectUri === null || redirectUri.length === 0) {
      return undefined;
    }
    const port = Number.parseInt(new URL(redirectUri).port, 10);
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function formatManualAuthInstructions(serverName: string, authorizationUrl: string): string {
  const port = getRedirectPort(authorizationUrl);
  const portNote =
    port !== undefined && port !== 0
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
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveAutoAuthUrl(
  state: McpExtensionState,
  serverName: string,
  definition: ServerDefinition,
): string | AutoAuthResult {
  let serverUrl: string | undefined;
  try {
    serverUrl = resolveServerUrl(definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: getAuthFailedMessage(state, serverName, message) };
  }
  if (serverUrl === undefined || serverUrl.length === 0) {
    return { status: "skipped" };
  }

  return serverUrl;
}
export async function attemptAutoAuth(
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

  const target = resolveAutoAuthUrl(state, serverName, definition);
  if (typeof target !== "string") {
    return target;
  }
  const serverUrl = target;
  if (!state.ui && !isNonInteractiveOAuth(definition.oauth)) {
    return {
      status: "failed",
      message: getAuthRequiredMessage(
        state,
        serverName,
        `Server "${serverName}" requires OAuth authentication. If mcp is inactive, first mcp_search({ enable: ["gateway"] }). Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  return authenticateConnection(state, { serverName, serverUrl, definition, signal });
}
async function authenticateConnection(
  state: McpExtensionState,
  {
    serverName,
    serverUrl,
    definition,
    signal,
  }: {
    serverName: string;
    serverUrl: string;
    definition: ServerDefinition;
    signal: AbortSignal | undefined;
  },
): Promise<AutoAuthResult> {
  try {
    const { authenticate } = await import("./mcp-auth-flow.ts");
    await authenticate(serverName, serverUrl, definition, {
      authStorageOptions: state.authStorageOptions,
      runtime: state.oauthRuntime,
      ...(signal ? { signal } : {}),
    });
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getAuthFailedMessage(state, serverName, message),
    };
  }
}

export async function executeAuthStart(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<ProxyToolResult> {
  const { startAuth } = await import("./mcp-auth-flow.ts");
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers (load it first with mcp_search({ enable: ["gateway"] }) if inactive).`,
        },
      ],
      details: { mode: "auth-start", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("auth-start", serverName);
  }

  try {
    const serverUrl = resolveServerUrl(definition);
    if (serverUrl === undefined || serverUrl.length === 0 || !supportsOAuth(definition)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Server "${serverName}" is not configured for OAuth over HTTP.`,
          },
        ],
        details: { mode: "auth-start", error: "oauth_not_supported", server: serverName },
      };
    }

    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, {
      authStorageOptions: state.authStorageOptions,
      runtime: state.oauthRuntime,
      ...(ownedSignal ? { signal: ownedSignal } : {}),
    });
    if (authorizationUrl.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `OAuth authentication successful for "${serverName}".` },
        ],
        details: { mode: "auth-start", server: serverName, authenticated: true },
      };
    }

    return {
      content: [
        { type: "text" as const, text: formatManualAuthInstructions(serverName, authorizationUrl) },
      ],
      details: { mode: "auth-start", server: serverName, authorizationUrl },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: "text" as const, text: `Failed to start OAuth for "${serverName}": ${message}` },
      ],
      details: { mode: "auth-start", error: "auth_start_failed", server: serverName, message },
    };
  }
}

export async function executeAuthComplete(
  state: McpExtensionState,
  serverName: string,
  input?: string,
  signal?: AbortSignal,
): Promise<ProxyToolResult> {
  const { completeAuthFromInput } = await import("./mcp-auth-flow.ts");
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers (load it first with mcp_search({ enable: ["gateway"] }) if inactive).`,
        },
      ],
      details: { mode: "auth-complete", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("auth-complete", serverName);
  }

  try {
    const previousConnection = state.manager.getConnection(serverName);
    const status = await completeAuthFromInput(serverName, input, {
      authStorageOptions: state.authStorageOptions,
      runtime: state.oauthRuntime,
      ...(ownedSignal ? { signal: ownedSignal } : {}),
    });
    if (status !== "authenticated") {
      return {
        content: [
          {
            type: "text" as const,
            text: `OAuth authentication did not complete for "${serverName}".`,
          },
        ],
        details: { mode: "auth-complete", error: "not_authenticated", server: serverName, status },
      };
    }

    if (previousConnection) {
      state.manager.retire(serverName, previousConnection);
    }
    clearFailure(state, serverName);
    updateStatusBar(state);
    return {
      content: [
        {
          type: "text" as const,
          text: `OAuth authentication successful for "${serverName}". Run mcp({ action: "connect", server: "${serverName}" }) to connect with the new token.`,
        },
      ],
      details: { mode: "auth-complete", server: serverName, authenticated: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: "text" as const, text: `Failed to complete OAuth for "${serverName}": ${message}` },
      ],
      details: {
        mode: "auth-complete",
        error: "auth_complete_failed",
        server: serverName,
        message,
      },
    };
  }
}
