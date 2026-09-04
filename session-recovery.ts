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
import { SdkHttpError, SdkErrorCode, ProtocolError, InsufficientScopeError, UnauthorizedError, type FetchLike, type Transport } from "@modelcontextprotocol/client";
import { logger } from "./logger.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { isServerDisabled, type McpConfig } from "./types.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";
import { supportsOAuth } from "./mcp-auth-flow.ts";

const toolTransportFailures = new WeakSet<object>();

/** Retain fetch-error origin without changing the SDK's errors or wire requests. */
export const trackToolTransportFailure: FetchLike = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof Error && !init?.signal?.aborted && init?.method === "POST"
      && new Headers(init.headers).get("Mcp-Method") === "tools/call") {
      toolTransportFailures.add(error);
    }
    throw error;
  }
};

/** Observe only the originating tool send, not OAuth or catalog requests. */
export function trackToolHttpFailures(transport: Transport): void {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      await send(message, options);
    } catch (error) {
      if ("method" in message && message.method === "tools/call"
        && error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpNotImplemented
        && error.status >= 500 && error.status < 600) {
        let errorBody = false;
        try {
          const body = JSON.parse(String(error.data.text));
          errorBody = body?.jsonrpc === "2.0" && body.error !== undefined;
        } catch {}
        if (!errorBody) toolTransportFailures.add(error);
      }
      throw error;
    }
  };
}

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
  if (!hadSessionId) return false;
  if (err instanceof SdkHttpError) {
    return err.status === 404
      || (err.status === 400
        && /"code"\s*:\s*-32000/.test(err.message)
        && /"message"\s*:\s*"Bad Request: Server not initialized"/.test(err.message));
  }
  return err instanceof ProtocolError
    && err.code === -32000
    && SERVER_NOT_INITIALIZED_MCP_MESSAGES.has(err.message);
}

function hasSessionId(connection: ServerConnection): boolean {
  // Only StreamableHTTPClientTransport exposes `sessionId`; stdio/SSE
  // transports (and test doubles that omit `transport` entirely) simply
  // read as `undefined` here.
  const transport = connection.transport as { sessionId?: string } | undefined;
  return transport?.sessionId != null;
}

export class SessionRecoveryAuthRequiredError extends Error {
  constructor(readonly serverName: string, readonly authMessage?: string) {
    super(authMessage ?? `MCP server "${serverName}" requires OAuth authentication after reconnect.`);
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
  /** Only tool calls may opt into a same-client retry of a proven modern POST transport failure. */
  retryOnTransportFailure?: boolean;
  onNeedsAuth?: (serverName: string, signal?: AbortSignal, challenge?: AuthChallengeContext) => Promise<ServerConnection | undefined>;
}

/**
 * Retry once on the same modern client when explicitly enabled, or reconnect
 * an expired legacy session once. Neither path retries its second failure.
 */
export async function withSessionRecovery<T>(
  deps: SessionRecoveryDeps,
  serverName: string,
  fn: (conn: ServerConnection) => Promise<T>,
): Promise<T> {
  if (isServerDisabled(deps.config.mcpServers[serverName])) {
    throw new Error(`MCP server "${serverName}" is disabled`);
  }
  throwIfAborted(deps.signal);
  let connection = deps.manager.getConnection(serverName);
  if (!connection) {
    throw new Error(`Server "${serverName}" is not connected`);
  }

  const reconnect = async (stale: ServerConnection, error: unknown): Promise<ServerConnection> => {
    const definition = deps.config.mcpServers[serverName];
    if (!definition) throw error;
    throwIfAborted(deps.signal);
    let fresh = stale;
    if (fresh.status !== "needs-auth") {
      fresh = deps.signal
        ? await deps.manager.reconnect(serverName, definition, stale, deps.signal)
        : await deps.manager.reconnect(serverName, definition, stale);
    }
    throwIfAborted(deps.signal);
    if (fresh.status === "needs-auth" && deps.onNeedsAuth) {
      fresh = await abortable(deps.onNeedsAuth(serverName, deps.signal), deps.signal) ?? fresh;
      throwIfAborted(deps.signal);
    }
    if (fresh.status === "needs-auth") throw new SessionRecoveryAuthRequiredError(serverName);
    if (fresh.status !== "connected") throw error;
    return fresh;
  };

  const isRecoverableAuth = (error: unknown, failed: ServerConnection, activating = false): error is Error => {
    const definition = deps.config.mcpServers[serverName];
    if (!definition || isServerDisabled(definition) || !supportsOAuth(definition)) return false;
    if (error instanceof SdkHttpError) {
      // A provider's exhausted native 401/M2M retry is terminal, not another consent cycle.
      return failed.oauthProvider === false && error.status === 401 && error.code !== SdkErrorCode.ClientHttpAuthentication;
    }
    if (failed.oauthProvider && definition.oauth && definition.oauth.grantType === "client_credentials") return false;
    return error instanceof InsufficientScopeError || (activating && error instanceof UnauthorizedError);
  };

  const terminalDispatch = async (fresh: ServerConnection): Promise<T> => {
    throwIfAborted(deps.signal);
    try {
      return await fn(fresh);
    } catch (error) {
      throwIfAborted(deps.signal);
      if (isRecoverableAuth(error, fresh)) throw new SessionRecoveryAuthRequiredError(serverName);
      throw error;
    }
  };

  const recoverAuth = async (failed: ServerConnection, error: Error): Promise<T> => {
    const definition = deps.config.mcpServers[serverName]!;
    const current = deps.manager.getConnection(serverName);
    if (current && current !== failed && failed.oauthProvider !== false) {
      return terminalDispatch(current.status === "connected" ? current : await reconnect(current, error));
    }

    if (failed.oauthProvider === false) {
      // One anonymous rejection may activate the provider without asking the user to sign in.
      failed = await deps.manager.reconnect(serverName, definition, failed, deps.signal);
      throwIfAborted(deps.signal);
      if (failed.status === "connected") {
        try {
          return await fn(failed);
        } catch (providerError) {
          throwIfAborted(deps.signal);
          if (!isRecoverableAuth(providerError, failed, true)) throw providerError;
          error = providerError;
        }
      }
    }
    if (definition.oauth && definition.oauth.grantType === "client_credentials") throw error;
    const fresh = await abortable(deps.onNeedsAuth?.(serverName, deps.signal, { connection: failed, error }) ?? Promise.resolve(undefined), deps.signal);
    throwIfAborted(deps.signal);
    if (!fresh || fresh === failed || fresh.status !== "connected") throw new SessionRecoveryAuthRequiredError(serverName);
    return terminalDispatch(fresh);
  };

  // Nothing has been dispatched yet: wait for replacement/auth begun during UI preparation.
  if (connection.status !== "connected") {
    connection = await reconnect(connection, new Error(`Server "${serverName}" is not connected`));
  }
  const hadSessionId = hasSessionId(connection);

  try {
    return await fn(connection);
  } catch (err) {
    throwIfAborted(deps.signal);
    if (isRecoverableAuth(err, connection)) return recoverAuth(connection, err);
    if (deps.retryOnTransportFailure === true
      && deps.config.mcpServers[serverName]?.retryOnTransportFailure === true
      && connection.client.getProtocolEra?.() === "modern"
      && err instanceof Error && toolTransportFailures.has(err)) {
      return terminalDispatch(connection);
    }
    if (!isTerminatedSession(err, hadSessionId)) {
      throw err;
    }

    logger.debug(`MCP session for "${serverName}" expired; reconnecting`, {
      server: serverName,
    });
    return terminalDispatch(await reconnect(connection, err));
  }
}
