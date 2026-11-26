import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { inspectAuthForUrl, type OAuthCredentialStatus } from "./mcp-auth.ts";
import { authenticateServer, authEligibility } from "./mcp-auth-commands.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import {
  isNonInteractiveOAuth,
  isServerDisabled,
  type McpConfig,
  type McpPanelCallbacks,
  type McpPanelConnectionStatus,
} from "./types.ts";
import { resolveServerUrl } from "./utils.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import { reconnectServer } from "./mcp-connection-commands.ts";
import { panelStatus, serverStage } from "./server-status.ts";

interface PanelCredentialStatus {
  status: McpPanelConnectionStatus;
  failureMessage: string | null;
}

function eligiblePanelCredentialUrl(
  definition: McpConfig["mcpServers"][string] | undefined,
): string | null | undefined {
  let serverUrl: string | undefined;
  try {
    serverUrl = definition ? resolveServerUrl(definition) : undefined;
  } catch {
    return null;
  }
  const interactiveOAuth =
    definition?.auth === "oauth" &&
    definition.oauth !== false &&
    !isNonInteractiveOAuth(definition.oauth);
  return interactiveOAuth && serverUrl !== undefined && serverUrl.length > 0
    ? serverUrl
    : undefined;
}

async function inspectPanelCredential(
  state: McpExtensionState,
  serverName: string,
  definition: McpConfig["mcpServers"][string] | undefined,
): Promise<OAuthCredentialStatus | undefined> {
  const serverUrl = isServerDisabled(definition)
    ? undefined
    : eligiblePanelCredentialUrl(definition);
  return typeof serverUrl === "string"
    ? await inspectAuthForUrl({ serverName, serverUrl }, state.authStorageOptions)
    : undefined;
}

async function inspectAllPanelCredentials(
  state: McpExtensionState,
  config: McpConfig,
): Promise<Map<string, OAuthCredentialStatus>> {
  const results = await Promise.all(
    Object.entries(config.mcpServers).map(async ([serverName, definition]) => {
      const status = await inspectPanelCredential(state, serverName, definition);
      return status === undefined ? undefined : ([serverName, status] as const);
    }),
  );
  return new Map(
    results.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  );
}

function panelCredentialStatus(
  state: McpExtensionState,
  serverName: string,
  definition: McpConfig["mcpServers"][string] | undefined,
  credentialStatuses: ReadonlyMap<string, OAuthCredentialStatus>,
): PanelCredentialStatus | undefined {
  const serverUrl = eligiblePanelCredentialUrl(definition);
  if (serverUrl === null) {
    return { status: "failed", failureMessage: getFailureMessage(state, serverName) };
  }
  const authStatus = serverUrl === undefined ? undefined : credentialStatuses.get(serverName);
  if (!authStatus) {
    return undefined;
  }
  if (authStatus.status === "unavailable") {
    return { status: "failed", failureMessage: authStatus.message };
  }
  return authStatus.status === "absent" || !authStatus.entry.tokens
    ? { status: "needs-auth", failureMessage: getFailureMessage(state, serverName) }
    : undefined;
}

export async function buildMcpPanelCallbacks(
  state: McpExtensionState,
  config: McpConfig,
  ctx: ExtensionContext,
): Promise<McpPanelCallbacks> {
  const credentialStatuses = await inspectAllPanelCredentials(state, config);
  const refreshCredential = async (serverName: string): Promise<void> => {
    const status = await inspectPanelCredential(state, serverName, config.mcpServers[serverName]);
    if (status === undefined) {
      credentialStatuses.delete(serverName);
    } else {
      credentialStatuses.set(serverName, status);
    }
  };
  return {
    reconnect: async (serverName, afterAuth) => {
      const ok = await reconnectServer(state, ctx, serverName, afterAuth);
      await refreshCredential(serverName);
      return ok;
    },
    canAuthenticate: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      return definition !== undefined && authEligibility(definition) === "eligible";
    },
    authenticate: async (serverName: string) => {
      const result = await authenticateServer({
        serverName,
        config,
        ctx,
        signal: state.owner.signal,
        runtime: state.oauthRuntime,
      });
      await refreshCredential(serverName);
      return result;
    },
    getConnectionStatus: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      if (isServerDisabled(definition)) {
        return "disabled";
      }
      const transport = state.manager.getConnection(serverName)?.status;
      // Stored-credential diagnostics outrank the connection stage for OAuth servers.
      const credentialStatus = panelCredentialStatus(
        state,
        serverName,
        definition,
        credentialStatuses,
      );
      if (credentialStatus !== undefined) {
        return credentialStatus.status;
      }
      return panelStatus(
        serverStage({
          definition,
          transport,
          failedAgoSeconds: getFailureAgeSeconds(state, serverName),
          catalogKnown: state.toolMetadata.has(serverName),
        }),
      );
    },
    getFailureMessage: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      const credentials = isServerDisabled(definition)
        ? undefined
        : panelCredentialStatus(state, serverName, definition, credentialStatuses);
      return credentials?.failureMessage ?? getFailureMessage(state, serverName);
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache(state.metadataCacheEnabled);
      return freshCache?.servers[serverName] ?? null;
    },
  };
}
