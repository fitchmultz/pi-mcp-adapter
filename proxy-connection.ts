import type { McpExtensionState } from "./state.ts";
import {
  type ProxyToolResult,
  type ProxyToolUpdateCallback,
  disabledResult,
  emitProxyUpdate,
} from "./proxy-result.ts";
import type { SessionRecoveryAuthRequiredError, SessionRecoveryDeps } from "./session-recovery.ts";
import type { ServerConnection } from "./server-manager.ts";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import { attemptAutoAuth, getAuthRequiredMessage } from "./proxy-auth.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import { formatMcpStatus } from "./utils.ts";
import { connectionStderrTail } from "./connection-stdio.ts";
import { formatFailureSummary } from "./server-status.ts";
import {
  lazyConnect,
  applyConnectionMetadata,
  markKeepAliveAfterConnect,
  getFailureAgeSeconds,
  getFailureRemainingSeconds,
  getFailureMessage,
  updateStatusBar,
  clearFailure,
  recordFailure,
} from "./init.ts";
import { applyServerMetadata } from "./init-metadata.ts";
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
  readonly AuthRequired: typeof SessionRecoveryAuthRequiredError;
  readonly onUpdate: ProxyToolUpdateCallback | undefined;
  private readonly state: McpExtensionState;
  private readonly serverName: string;
  private readonly signal: AbortSignal | undefined;
  constructor(
    state: McpExtensionState,
    serverName: string,
    options: {
      signal: AbortSignal | undefined;
      AuthRequired: typeof SessionRecoveryAuthRequiredError;
      onUpdate: ProxyToolUpdateCallback | undefined;
    },
  ) {
    this.AuthRequired = options.AuthRequired;
    this.onUpdate = options.onUpdate;
    this.state = state;
    this.serverName = serverName;
    this.signal = options.signal;
  }
  readonly recover: AuthRecovery = async (_name, recoverySignal = this.signal, challenge) => {
    const { state, serverName } = this;
    throwIfAborted(recoverySignal);
    let current = state.manager.getConnection(serverName);
    if (current?.status === "connected" && current !== challenge?.connection) {
      return current;
    }
    const pickedUp = await this.pickupStoredCredentials(current, recoverySignal);
    if (pickedUp) {
      return pickedUp;
    }
    current = state.manager.getConnection(serverName);
    if (!this.attempted) {
      const recovered = await this.authenticate(current, recoverySignal);
      if (recovered) {
        return recovered;
      }
    }
    return challenge ? undefined : state.manager.getConnection(serverName);
  };
  private async pickupStoredCredentials(
    current: ServerConnection | undefined,
    recoverySignal: AbortSignal | undefined,
  ): Promise<ServerConnection | undefined> {
    if (current?.status !== "needs-auth") {
      return;
    }
    const definition = this.state.config.mcpServers[this.serverName];
    if (
      !definition ||
      isServerDisabled(definition) ||
      !(await this.state.manager.hasFreshOAuthCredentials(this.serverName, definition, current))
    ) {
      return;
    }
    const reconnected = await this.reconnect(current, recoverySignal);
    return reconnected?.status === "connected" ? reconnected : undefined;
  }
  private async authenticate(
    current: ServerConnection | undefined,
    recoverySignal: AbortSignal | undefined,
  ): Promise<ServerConnection | undefined> {
    const { state, serverName } = this;
    this.attempted = true;
    const auth = await attemptAutoAuth(state, serverName, recoverySignal, () => {
      emitProxyUpdate(this.onUpdate, `Authenticating with ${serverName}…`, { server: serverName });
    });
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
    emitProxyUpdate(this.onUpdate, `Connecting to ${serverName}…`, { server: serverName });
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
  applyConnectionMetadata(state, {
    serverName,
    connection,
    definition,
    reason: "proxy-connect",
  });
  updateStatusBar(state);
}
function refreshCallMetadata(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
  definition: ServerDefinition,
): void {
  // Use the live descriptor for visibility, filtering, approval, schema and UI hints;
  // search indexes by metadata-array identity, so retain it for unchanged projections.
  applyServerMetadata(state, {
    serverName,
    connection,
    definition,
    preserveToolMetadataIdentity: true,
    updateInstructions: false,
  });
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
  const base = error instanceof Error ? error.message : String(error);
  const stderrTail = connectionStderrTail(state.manager.getConnection(serverName), error);
  return stderrTail.length > 0 && !base.includes(stderrTail)
    ? `${base}\n\nRecent server stderr:\n${stderrTail}`
    : base;
}

async function connectAuthentication(
  state: McpExtensionState,
  {
    serverName,
    connection: initialConnection,
    definition,
    ownedSignal,
    onUpdate,
  }: {
    serverName: string;
    connection: ServerConnection;
    definition: ServerDefinition;
    ownedSignal: AbortSignal | undefined;
    onUpdate?: ProxyToolUpdateCallback | undefined;
  },
): Promise<
  { error: ProxyToolResult; connection?: never } | { error?: never; connection: ServerConnection }
> {
  let connection = initialConnection;
  if (connection.status === "needs-auth") {
    const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal, () => {
      emitProxyUpdate(onUpdate, `Authenticating with ${serverName}…`, { server: serverName });
    });
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
      emitProxyUpdate(onUpdate, `Connecting to ${serverName}…`, { server: serverName });
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
  {
    serverName,
    signal,
    onUpdate,
    limit,
    offset,
  }: {
    serverName: string;
    signal?: AbortSignal | undefined;
    onUpdate?: ProxyToolUpdateCallback | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  },
): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.`,
        },
      ],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("connect", serverName);
  }

  try {
    emitProxyUpdate(onUpdate, `Connecting to ${serverName}…`, { server: serverName });
    if (state.ui) {
      state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
    }
    let connection = await discoveryConnection(state, serverName, definition, ownedSignal);
    const authenticated = await connectAuthentication(state, {
      serverName,
      connection,
      definition,
      ownedSignal,
      onUpdate,
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
  auth: ConnectionAuthRecovery,
): Promise<ServerConnection | undefined> {
  // Connected metadata is read below, so it does not require another connection attempt.
  let connection = state.manager.getConnection(serverName);
  if (connection?.status !== "connected") {
    if (connection?.status !== "needs-auth" && getFailureAgeSeconds(state, serverName) === null) {
      emitProxyUpdate(auth.onUpdate, `Connecting to ${serverName}…`, { server: serverName });
    }
    await lazyConnect(state, serverName, ownedSignal);
    connection = state.manager.getConnection(serverName);
  } else {
    markKeepAliveAfterConnect(state, serverName);
  }
  if (connection?.status === "needs-auth") {
    connection = await auth.recover(serverName, ownedSignal);
  }
  if (connection?.status === "needs-auth") {
    throw new auth.AuthRequired(serverName);
  }

  return connection;
}

/** Connect/auth once for calls and resource discovery. Recovery stays bounded by withSessionRecovery. */
export async function prepareMcpConnection(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
  onUpdate?: ProxyToolUpdateCallback,
): Promise<PreparedMcpConnection> {
  const { SessionRecoveryAuthRequiredError: AuthRequired } = await import("./session-recovery.ts");
  // Loading the recovery module yields, so cancellation is checked after it.
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const auth = new ConnectionAuthRecovery(state, serverName, {
    signal: ownedSignal,
    AuthRequired,
    onUpdate,
  });
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
    const connection = await callConnection(state, serverName, ownedSignal, auth);
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

function serverFailureDiagnostic(state: McpExtensionState, serverName: string): string | null {
  const connection = state.manager.getConnection(serverName);
  return formatFailureSummary(
    getFailureMessage(state, serverName) ??
      (connection?.status === "closed" ? connection.getStderrTail?.() : null),
  );
}

function backoffError(
  serverName: string,
  failure: (error: string, message: string) => ProxyToolResult,
  context: {
    failedAgo: number;
    retryAfterSeconds: number | null;
    failureMessage: string | null;
  },
): { error: ProxyToolResult } {
  const { failedAgo, retryAfterSeconds, failureMessage } = context;
  const windowText =
    retryAfterSeconds !== null
      ? `last failed ${failedAgo}s ago, retry in ${retryAfterSeconds}s`
      : `last failed ${failedAgo}s ago`;
  const reasonText = failureMessage !== null ? ` Last error: ${failureMessage}.` : "";
  const backoff = failure(
    "server_backoff",
    `Server "${serverName}" is backing off (${windowText}).${reasonText} No call was dispatched. Call mcp({ action: "connect", server: ${JSON.stringify(serverName)} }) to retry immediately.`,
  );
  return {
    error: {
      ...backoff,
      isError: true,
      details: {
        ...backoff.details,
        dispatched: false,
        failedAgoSeconds: failedAgo,
        ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
        ...(failureMessage !== null ? { failureMessage } : {}),
      },
    },
  };
}

function unavailableConnection(
  state: McpExtensionState,
  serverName: string,
  failure: (error: string, message: string) => ProxyToolResult,
): { error: ProxyToolResult } {
  const failedAgo = getFailureAgeSeconds(state, serverName);
  const failureMessage = serverFailureDiagnostic(state, serverName);
  if (failedAgo === null) {
    const base = `Server "${serverName}" not available`;
    const unavailable = failure(
      "server_unavailable",
      failureMessage !== null ? `${base}: ${failureMessage}` : base,
    );
    return {
      error:
        failureMessage !== null
          ? { ...unavailable, details: { ...unavailable.details, failureMessage } }
          : unavailable,
    };
  }
  return backoffError(serverName, failure, {
    failedAgo,
    retryAfterSeconds: getFailureRemainingSeconds(state, serverName),
    failureMessage,
  });
}
