// session-recovery.ts
//
// Streamable HTTP session recovery.
//
// Per the MCP spec (Streamable HTTP transport):
//   "When a client receives HTTP 404 in response to a request containing an
//   Mcp-Session-Id, it MUST start a new session by sending a new
//   InitializeRequest without a session ID attached."
//
// A 404 for a request that carried a session ID is therefore the spec's own
// definition of "this session no longer exists" (e.g. the remote server
// process restarted and lost its in-memory session table). Because the spec
// requires the server to reject the request *before* processing it, retrying
// the same call against a freshly initialized session cannot double-execute
// the original request.
//
// This module intentionally does NOT:
//   - match broad error messages without a prior session id
//   - match generic HTTP 400 responses, which are ambiguous and can mean
//     many things other than "your session is gone"
//   - treat generic -32000/ConnectionClosed errors as session expiry
//   - treat AbortError/cancellation as a session failure
import {
  SdkHttpError,
  SdkErrorCode,
  ProtocolError,
  InsufficientScopeError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { logger } from "./logger.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import {
  isServerDisabled,
  isNonInteractiveOAuth,
  type McpConfig,
  type ServerDefinition,
} from "./types.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";
import { supportsOAuth } from "./mcp-auth-flow.ts";
import { isToolTransportFailure } from "./tool-transport.ts";
export {
  isToolTransportFailure,
  isInterruptedToolCall,
  trackToolCallOutcome,
  trackToolTransport,
  trackToolTransportFailure,
} from "./tool-transport.ts";

/**
 * True when `err` is a stale Streamable HTTP session signal for a request
 * sent while carrying an `Mcp-Session-Id`: the spec's 404 transport
 * response, or the narrowly-known `-32000 Server not initialized` protocol
 * gate response some servers emit before dispatching to a handler.
 *
 * `hadSessionId` must reflect the transport's session id from *before* the
 * call that produced `err` was made. The SDK does not
 * clear `transport.sessionId` on a 404 response, so callers must capture it
 * before the call rather than rely on catch-time transport state.
 */
const SERVER_NOT_INITIALIZED_MCP_MESSAGES = new Set([
  "Server not initialized",
  "Bad Request: Server not initialized",
]);

export function isTerminatedSession(err: unknown, hadSessionId: boolean): boolean {
  if (!hadSessionId) {
    return false;
  }
  if (err instanceof SdkHttpError) {
    return (
      err.status === 404 ||
      (err.status === 400 &&
        /"code"\s*:\s*-32000/.test(err.message) &&
        /"message"\s*:\s*"Bad Request: Server not initialized"/.test(err.message))
    );
  }
  return (
    err instanceof ProtocolError &&
    err.code === -32000 &&
    SERVER_NOT_INITIALIZED_MCP_MESSAGES.has(err.message)
  );
}

function hasSessionId(connection: ServerConnection): boolean {
  // Only Streamable HTTP exposes sessionId. Other native transports have none.
  return "sessionId" in connection.transport && connection.transport.sessionId !== undefined;
}

export class SessionRecoveryAuthRequiredError extends Error {
  readonly serverName: string;
  readonly authMessage: string | undefined;

  constructor(serverName: string, authMessage?: string) {
    super(
      authMessage ?? `MCP server "${serverName}" requires OAuth authentication after reconnect.`,
    );
    this.serverName = serverName;
    this.authMessage = authMessage;
    this.name = "SessionRecoveryAuthRequiredError";
  }
}

export interface AuthChallengeContext {
  connection: ServerConnection;
  error: Error;
}

export interface SessionRecoveryDeps {
  manager: McpServerManager;
  config: McpConfig;
  signal?: AbortSignal;
  /** Only replay-safe tool calls may opt into a same-client retry of a proven modern POST transport failure. */
  retryOnTransportFailure?: boolean;
  onNeedsAuth?: (
    serverName: string,
    signal?: AbortSignal,
    challenge?: AuthChallengeContext,
  ) => Promise<ServerConnection | undefined>;
}

class RecoveryAttempt<T> {
  private readonly deps: SessionRecoveryDeps;
  private readonly serverName: string;
  private readonly dispatch: (connection: ServerConnection) => Promise<T>;

  constructor(
    deps: SessionRecoveryDeps,
    serverName: string,
    dispatch: (connection: ServerConnection) => Promise<T>,
  ) {
    this.deps = deps;
    this.serverName = serverName;
    this.dispatch = dispatch;
  }

  private async reconnect(stale: ServerConnection, error: Error): Promise<ServerConnection> {
    const definition = this.deps.config.mcpServers[this.serverName];
    if (!definition) {
      throw error;
    }
    throwIfAborted(this.deps.signal);
    let fresh = stale;
    if (fresh.status !== "needs-auth") {
      fresh = this.deps.signal
        ? await this.deps.manager.reconnect(this.serverName, definition, stale, this.deps.signal)
        : await this.deps.manager.reconnect(this.serverName, definition, stale);
    }
    throwIfAborted(this.deps.signal);
    if (fresh.status === "needs-auth" && this.deps.onNeedsAuth) {
      fresh =
        (await abortable(
          this.deps.onNeedsAuth(this.serverName, this.deps.signal),
          this.deps.signal,
        )) ?? fresh;
      throwIfAborted(this.deps.signal);
    }
    if (fresh.status === "needs-auth") {
      throw new SessionRecoveryAuthRequiredError(this.serverName);
    }
    if (fresh.status !== "connected") {
      throw error;
    }
    return fresh;
  }

  private isRecoverableAuth(
    error: unknown,
    failed: ServerConnection,
    activating = false,
  ): error is Error {
    const definition = this.deps.config.mcpServers[this.serverName];
    if (!definition || !this.supportsAuthRecovery(definition)) {
      return false;
    }
    if (error instanceof SdkHttpError) {
      // Exhausted native 401/M2M retry is terminal, not another consent cycle.
      return this.isAnonymousAuthFailure(error, failed);
    }
    if (failed.oauthProvider === true && isNonInteractiveOAuth(definition.oauth)) {
      return false;
    }
    return (
      error instanceof InsufficientScopeError || (activating && error instanceof UnauthorizedError)
    );
  }

  private isAnonymousAuthFailure(error: SdkHttpError, failed: ServerConnection): boolean {
    return (
      failed.oauthProvider === false &&
      error.status === 401 &&
      error.code !== SdkErrorCode.ClientHttpAuthentication
    );
  }

  private supportsAuthRecovery(definition: ServerDefinition): boolean {
    return !isServerDisabled(definition) && supportsOAuth(definition);
  }

  private async terminalDispatch(fresh: ServerConnection): Promise<T> {
    throwIfAborted(this.deps.signal);
    try {
      return await this.dispatch(fresh);
    } catch (error) {
      throwIfAborted(this.deps.signal);
      if (this.isRecoverableAuth(error, fresh)) {
        throw new SessionRecoveryAuthRequiredError(this.serverName);
      }
      throw error;
    }
  }

  private async activateProvider(
    failed: ServerConnection,
    error: Error,
  ): Promise<
    { kind: "result"; value: T } | { kind: "challenge"; connection: ServerConnection; error: Error }
  > {
    const definition = this.deps.config.mcpServers[this.serverName];
    if (!definition || failed.oauthProvider !== false) {
      return { kind: "challenge", connection: failed, error };
    }
    // One anonymous rejection may activate the provider without prompting.
    const activated = await this.deps.manager.reconnect(
      this.serverName,
      definition,
      failed,
      this.deps.signal,
    );
    throwIfAborted(this.deps.signal);
    if (activated.status !== "connected") {
      return { kind: "challenge", connection: activated, error };
    }
    try {
      return { kind: "result", value: await this.dispatch(activated) };
    } catch (providerError) {
      throwIfAborted(this.deps.signal);
      if (!this.isRecoverableAuth(providerError, activated, true)) {
        throw providerError;
      }
      return { kind: "challenge", connection: activated, error: providerError };
    }
  }

  private async recoverAuth(failed: ServerConnection, error: Error): Promise<T> {
    const definition = this.deps.config.mcpServers[this.serverName];
    const current = this.deps.manager.getConnection(this.serverName);
    if (current && current !== failed && failed.oauthProvider !== false) {
      return this.terminalDispatch(
        current.status === "connected" ? current : await this.reconnect(current, error),
      );
    }
    const activation = await this.activateProvider(failed, error);
    if (activation.kind === "result") {
      return activation.value;
    }
    return this.requestConsent(definition?.oauth, activation);
  }

  private async requestConsent(
    oauth: ServerDefinition["oauth"],
    challenge: AuthChallengeContext,
  ): Promise<T> {
    if (isNonInteractiveOAuth(oauth)) {
      throw challenge.error;
    }
    const fresh = await abortable(
      Promise.resolve(this.deps.onNeedsAuth?.(this.serverName, this.deps.signal, challenge)),
      this.deps.signal,
    );
    throwIfAborted(this.deps.signal);
    if (!fresh || fresh === challenge.connection || fresh.status !== "connected") {
      throw new SessionRecoveryAuthRequiredError(this.serverName);
    }
    return this.terminalDispatch(fresh);
  }

  async run(): Promise<T> {
    if (isServerDisabled(this.deps.config.mcpServers[this.serverName])) {
      throw new Error(`MCP server "${this.serverName}" is disabled`);
    }
    throwIfAborted(this.deps.signal);
    let connection = this.deps.manager.getConnection(this.serverName);
    if (!connection) {
      throw new Error(`Server "${this.serverName}" is not connected`);
    }
    // Nothing dispatched yet: wait for replacement/auth begun during UI preparation.
    if (connection.status !== "connected") {
      connection = await this.reconnect(
        connection,
        new Error(`Server "${this.serverName}" is not connected`),
      );
    }
    const hadSessionId = hasSessionId(connection);
    try {
      return await this.dispatch(connection);
    } catch (error) {
      throwIfAborted(this.deps.signal);
      if (this.isRecoverableAuth(error, connection)) {
        return this.recoverAuth(connection, error);
      }
      if (this.canRetryTransport(error, connection)) {
        return this.terminalDispatch(connection);
      }
      if (!(error instanceof Error) || !isTerminatedSession(error, hadSessionId)) {
        throw error;
      }
      logger.debug(`MCP session for "${this.serverName}" expired; reconnecting`, {
        server: this.serverName,
      });
      return this.terminalDispatch(await this.reconnect(connection, error));
    }
  }

  private canRetryTransport(error: unknown, connection: ServerConnection): boolean {
    return (
      this.deps.retryOnTransportFailure === true &&
      this.deps.config.mcpServers[this.serverName]?.retryOnTransportFailure === true &&
      connection.client.getProtocolEra() === "modern" &&
      isToolTransportFailure(error)
    );
  }
}

/** Retry an explicitly replay-safe modern call or reconnect an expired legacy session once. */
export function withSessionRecovery<T>(
  deps: SessionRecoveryDeps,
  serverName: string,
  fn: (conn: ServerConnection) => Promise<T>,
): Promise<T> {
  return new RecoveryAttempt(deps, serverName, fn).run();
}
