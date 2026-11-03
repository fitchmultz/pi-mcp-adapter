import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import type { SessionRecoveryAuthRequiredError, SessionRecoveryDeps } from "./session-recovery.ts";
import { isDeepStrictEqual } from "node:util";
import type { ServerConnection } from "./server-manager.ts";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import { attemptAutoAuth, getAuthRequiredMessage } from "./proxy-auth.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import { formatMcpStatus } from "./utils.ts";
import {
  lazyConnect,
  markKeepAliveAfterConnect,
  notifyToolMetadataUpdated,
  updateMetadataCache,
  getFailureAgeSeconds,
  updateStatusBar,
  clearFailure,
  recordFailure,
} from "./init.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { reconstructPromptMetadata } from "./metadata-cache.ts";
import { executeList } from "./proxy-list.ts";

type AuthRecovery = NonNullable<SessionRecoveryDeps["onNeedsAuth"]>;
export type PreparedMcpConnection =
  | {
      error: ProxyToolResult;
      connection?: never;
      recoverAuthConnection?: never;
      autoAuthAttempted?: never;
    }
  | {
      error?: never;
      connection: ServerConnection;
      recoverAuthConnection: AuthRecovery;
      autoAuthAttempted: () => boolean;
    };

class ConnectionAuthRecovery {
  attempted = false;
  private readonly state: McpExtensionState;
  private readonly serverName: string;
  private readonly signal: AbortSignal | undefined;
  private readonly AuthRequired: typeof SessionRecoveryAuthRequiredError;
  constructor(
    state: McpExtensionState,
    serverName: string,
    signal: AbortSignal | undefined,
    AuthRequired: typeof SessionRecoveryAuthRequiredError,
  ) {
    this.AuthRequired = AuthRequired;
    this.state = state;
    this.serverName = serverName;
    this.signal = signal;
  }
  readonly recover: AuthRecovery = async (_name, recoverySignal = this.signal, challenge) => {
    const { state, serverName } = this;
    throwIfAborted(recoverySignal);
    const current = state.manager.getConnection(serverName);
    if (current?.status === "connected" && current !== challenge?.connection) {
      return current;
    }
    if (!this.attempted) {
      const recovered = await this.authenticate(current, recoverySignal);
      if (recovered) {
        return recovered;
      }
    }
    return challenge ? undefined : state.manager.getConnection(serverName);
  };
  private async authenticate(
    current: ServerConnection | undefined,
    recoverySignal: AbortSignal | undefined,
  ): Promise<ServerConnection | undefined> {
    const { state, serverName } = this;
    this.attempted = true;
    const auth = await attemptAutoAuth(state, serverName, recoverySignal);
    throwIfAborted(recoverySignal);
    if (auth.status === "failed") {
      throw new this.AuthRequired(serverName, auth.message);
    }
    if (auth.status === "success" && current) {
      const recovered = await this.reconnect(current, recoverySignal);
      if (recovered) {
        return recovered;
      }
    }
    return;
  }
  private async reconnect(
    current: ServerConnection,
    recoverySignal: AbortSignal | undefined,
  ): Promise<ServerConnection | undefined> {
    const { state, serverName } = this;
    clearFailure(state, serverName);
    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return;
    }
    state.ui?.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
    await state.manager.reconnect(serverName, definition, current, recoverySignal);
    if (await lazyConnect(state, serverName, recoverySignal)) {
      updateStatusBar(state);
      return state.manager.getConnection(serverName);
    }
    return;
  }
}
function saveConnectedMetadata(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
  definition: ServerDefinition,
): void {
  const prefix = state.config.settings?.toolPrefix ?? "server";
  const { metadata } = buildToolMetadata(
    connection.tools,
    connection.resources,
    definition,
    serverName,
    prefix,
  );
  state.toolMetadata.set(serverName, metadata);
  state.resourceCounts.set(serverName, connection.resources.length);
  if (connection.promptDiscoveryFailed !== true) {
    state.promptMetadata.set(
      serverName,
      reconstructPromptMetadata(serverName, connection.prompts, prefix, definition),
    );
    state.promptMetadataLive.add(serverName);
  }
  if (connection.instructions !== undefined && connection.instructions.length > 0) {
    state.serverInstructions.set(serverName, connection.instructions);
  } else {
    state.serverInstructions.delete(serverName);
  }
  updateMetadataCache(state, serverName);
  notifyToolMetadataUpdated(state, serverName, "proxy-connect");
  markKeepAliveAfterConnect(state, serverName);
  clearFailure(state, serverName);
  updateStatusBar(state);
}
function refreshCallMetadata(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
  definition: ServerDefinition,
): void {
  // Use the live descriptor for visibility, filtering, approval, schema and UI hints.
  const { metadata } = buildToolMetadata(
    connection.tools,
    connection.resources,
    definition,
    serverName,
    state.config.settings?.toolPrefix ?? "server",
  );
  // Search indexes by metadata-array identity, so retain it for unchanged projections.
  if (!isDeepStrictEqual(state.toolMetadata.get(serverName), metadata)) {
    state.toolMetadata.set(serverName, metadata);
  }
}
function connectionErrorMessage(
  state: McpExtensionState,
  serverName: string,
  error: unknown,
  AuthRequired: typeof SessionRecoveryAuthRequiredError,
): string {
  if (error instanceof AuthRequired) {
    return error.authMessage ?? getAuthRequiredMessage(state, serverName);
  }
  return error instanceof Error ? error.message : String(error);
}

async function connectAuthentication(
  state: McpExtensionState,
  {
    serverName,
    connection: initialConnection,
    definition,
    ownedSignal,
  }: {
    serverName: string;
    connection: ServerConnection;
    definition: ServerDefinition;
    ownedSignal: AbortSignal | undefined;
  },
): Promise<
  { error: ProxyToolResult; connection?: never } | { error?: never; connection: ServerConnection }
> {
  let connection = initialConnection;
  if (connection.status === "needs-auth") {
    const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
    if (autoAuth.status === "failed") {
      return {
        error: {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: {
            mode: "connect",
            error: "auth_required",
            server: serverName,
            message: autoAuth.message,
          },
        },
      };
    }
    if (autoAuth.status === "success") {
      throwIfAborted(ownedSignal);
      connection = await state.manager.reconnect(serverName, definition, connection, ownedSignal);
    }
    if (connection.status === "needs-auth") {
      const message = getAuthRequiredMessage(state, serverName);
      return {
        error: {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message },
        },
      };
    }
  }

  return { connection };
}

async function discoveryConnection(
  state: McpExtensionState,
  serverName: string,
  definition: ServerDefinition,
  ownedSignal: AbortSignal | undefined,
): Promise<ServerConnection> {
  const currentConnection = state.manager.getConnection(serverName);
  return currentConnection?.status === "connected"
    ? await state.manager.reconnect(serverName, definition, currentConnection, ownedSignal)
    : await state.manager.connect(serverName, definition, ownedSignal);
}
export async function executeConnect(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
  limit?: number,
  offset?: number,
): Promise<ProxyToolResult> {
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
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("connect", serverName);
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
    }
    let connection = await discoveryConnection(state, serverName, definition, ownedSignal);
    const authenticated = await connectAuthentication(state, {
      serverName,
      connection,
      definition,
      ownedSignal,
    });
    if (authenticated.error) {
      return authenticated.error;
    }
    connection = authenticated.connection;
    saveConnectedMetadata(state, serverName, connection, definition);
    return executeList(state, serverName, limit, offset);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAbortError(error, ownedSignal)) {
      recordFailure(state, serverName, message);
    }
    updateStatusBar(state);
    return {
      content: [
        { type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` },
      ],
      details: {
        mode: "connect",
        error: isAbortError(error, ownedSignal) ? "aborted" : "connect_failed",
        server: serverName,
        message,
      },
    };
  }
}

async function callConnection(
  state: McpExtensionState,
  serverName: string,
  ownedSignal: AbortSignal | undefined,
  recoverAuthConnection: AuthRecovery,
): Promise<ServerConnection | undefined> {
  // Connected metadata is read below, so it does not require another connection attempt.
  let connection = state.manager.getConnection(serverName);
  if (connection?.status !== "connected") {
    await lazyConnect(state, serverName, ownedSignal);
    connection = state.manager.getConnection(serverName);
  } else {
    markKeepAliveAfterConnect(state, serverName);
  }
  if (connection?.status === "needs-auth") {
    connection = await recoverAuthConnection(serverName, ownedSignal);
  }
  if (connection?.status === "needs-auth") {
    const { SessionRecoveryAuthRequiredError: AuthRequired } =
      await import("./session-recovery.ts");
    throw new AuthRequired(serverName);
  }

  return connection;
}

/** Connect/auth once for calls and resource discovery. Recovery stays bounded by withSessionRecovery. */
export async function prepareMcpConnection(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<PreparedMcpConnection> {
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const { SessionRecoveryAuthRequiredError: AuthRequired } = await import("./session-recovery.ts");
  const auth = new ConnectionAuthRecovery(state, serverName, ownedSignal, AuthRequired);
  const recoverAuthConnection = auth.recover;
  const failure = (error: string, message: string) => ({
    content: [{ type: "text" as const, text: message }],
    details: { mode: "call", error, server: serverName, message },
  });
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return { error: failure("server_not_found", `Server "${serverName}" not found.`) };
  }
  if (isServerDisabled(definition)) {
    return { error: disabledResult("call", serverName) };
  }
  try {
    const connection = await callConnection(state, serverName, ownedSignal, recoverAuthConnection);
    if (connection?.status !== "connected") {
      return unavailableConnection(state, serverName, failure);
    }
    refreshCallMetadata(state, serverName, connection, definition);
    return { connection, recoverAuthConnection, autoAuthAttempted: () => auth.attempted };
  } catch (error) {
    if (isAbortError(error, ownedSignal)) {
      throw error;
    }
    const message = connectionErrorMessage(state, serverName, error, AuthRequired);
    if (!(error instanceof AuthRequired)) {
      recordFailure(state, serverName, message);
      updateStatusBar(state);
    }
    return {
      error: failure(error instanceof AuthRequired ? "auth_required" : "connect_failed", message),
    };
  }
}

function unavailableConnection(
  state: McpExtensionState,
  serverName: string,
  failure: (error: string, message: string) => ProxyToolResult,
): { error: ProxyToolResult } {
  const failedAgo = getFailureAgeSeconds(state, serverName);
  return {
    error: failure(
      failedAgo === null ? "server_unavailable" : "server_backoff",
      `Server "${serverName}" not available${failedAgo === null ? "" : ` (last failed ${failedAgo}s ago)`}`,
    ),
  };
}
