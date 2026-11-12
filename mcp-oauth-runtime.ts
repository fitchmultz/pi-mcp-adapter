/**
 * SDK-free OAuth runtime ownership and pending-flow cleanup.
 * Native auth/protocol implementation stays in mcp-auth-flow.ts and is loaded
 * only by operations that need it; all callers share the state owned here.
 */

import type { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { cancelPendingCallback, stopCallbackServer } from "./mcp-callback-server.ts";
import {
  getAuthBaseDir,
  getOAuthState,
  clearOAuthState,
  type AuthStorageOptions,
  type AuthIdentity,
} from "./mcp-auth.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { ServerEntry } from "./types.ts";

/** A completed authorization. Failures reject; there is no partial success to report. */
export type AuthStatus = "authenticated";

export interface McpOAuthRuntime {
  readonly signal: AbortSignal;
}

export interface AuthenticateOptions {
  /**
   * Runtime that owns this flow's pending state, reservations, and abort
   * lifetime. Every caller owns its runtime: create one with
   * createOAuthRuntime() and stop it with shutdownOAuth(). There is no shared
   * default, so an unowned runtime cannot outlive the host that started it.
   */
  runtime: McpOAuthRuntime;
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
  authStorageOptions?: AuthStorageOptions;
  signal?: AbortSignal;
}

export type AuthDiscovery = {
  resourceMetadataUrl?: URL;
  scope?: string;
  skipIssuerMetadataValidation?: boolean;
};

export type CallbackIssuer = {
  expectedIssuer?: string | undefined;
  fallbackIssuer?: string;
  issParameterSupported?: boolean;
};

/** One pending browser authorization and the callback state it reserved. */
export type PendingAuth = {
  serverName: string;
  authProvider: McpOAuthProvider;
  serverUrl: string;
  authorizationUrl: string;
  discovery: AuthDiscovery;
  callbackIssuer: CallbackIssuer;
  request?: OAuthRequest;
  authStorageOptions: AuthStorageOptions;
  /** Callback state this flow reserved; completing or cancelling it requires the match. */
  callbackState: string;
  /** Cleanup deadline for a flow whose browser never returns. */
  cleanupTimer: ReturnType<typeof setTimeout>;
};

export type RuntimeState = {
  controller: AbortController;
  generation: number;
  pendingAuths: Map<string, PendingAuth>;
  pendingAuthentications: Map<string, Promise<AuthStatus>>;
  pendingStarts: Map<string, PendingAuthStart>;
  requests: Map<string, OAuthRequest>;
};

export type PendingAuthStart = {
  serverUrl: string;
  controller: AbortController;
  operation: Promise<{ authorizationUrl: string }>;
};

const runtimeStates = new WeakMap<McpOAuthRuntime, RuntimeState>();
const activeRuntimes = new Set<McpOAuthRuntime>();

export function createOAuthRuntime(signal?: AbortSignal): McpOAuthRuntime {
  const controller = new AbortController();
  const runtime = {
    signal: combineAbortSignals(signal, controller.signal) ?? controller.signal,
  } satisfies McpOAuthRuntime;
  runtimeStates.set(runtime, {
    controller,
    generation: 0,
    pendingAuths: new Map(),
    pendingAuthentications: new Map(),
    pendingStarts: new Map(),
    requests: new Map(),
  });
  activeRuntimes.add(runtime);
  return runtime;
}

/** Register a caller-owned runtime for an auth operation and check it is alive. */
export function useRuntime(runtime: McpOAuthRuntime): McpOAuthRuntime {
  runtime.signal.throwIfAborted();
  activeRuntimes.add(runtime);
  return runtime;
}

export function getRuntimeState(runtime: McpOAuthRuntime): RuntimeState {
  const state = runtimeStates.get(runtime);
  if (!state) {
    throw new Error("Unknown OAuth runtime");
  }
  return state;
}

export function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
  return JSON.stringify([serverName, getAuthBaseDir(options)]);
}

export type OAuthRequest = {
  serverName: string;
  serverUrl: string;
  requestedScope?: string;
  challenge?: { requiredScope?: string; resourceMetadataUrl?: URL };
  issuer?: string;
};

export function hasPendingAuth(
  serverName: string,
  runtime: McpOAuthRuntime,
  options?: AuthStorageOptions,
): boolean {
  const state = getRuntimeState(runtime);
  if (options) {
    return state.pendingAuths.has(getPendingAuthKey(serverName, options));
  }
  return Array.from(state.pendingAuths.values()).some(
    (pendingAuth) => pendingAuth.serverName === serverName,
  );
}

/** The callback state reserved by a server's pending flow, if it has one. */
export function pendingAuthState(
  runtime: McpOAuthRuntime,
  serverName: string,
  options: AuthStorageOptions = {},
): string | undefined {
  return getRuntimeState(runtime).pendingAuths.get(getPendingAuthKey(serverName, options))
    ?.callbackState;
}

/**
 * Clear a server's pending flow, or release only the caller's own reservation.
 *
 * A caller whose state differs from the pending flow's state owns a different
 * flow — a failed start that reserved a callback before an older flow was
 * replaced, or a stale callback/timer racing a newer flow. The pending entry
 * stays untouched in that case, but the caller's own reservation is still
 * released so a failed start cannot strand a reserved callback until process
 * shutdown. Callers with no state of their own clear whichever flow is
 * pending.
 */
export async function clearPendingAuth(
  runtime: McpOAuthRuntime,
  identity: AuthIdentity,
  oauthState?: string,
  fallbackStorageOptions: AuthStorageOptions = {},
): Promise<void> {
  const state = getRuntimeState(runtime);
  const { serverName } = identity;
  const key = getPendingAuthKey(serverName, fallbackStorageOptions);
  const pendingAuth = state.pendingAuths.get(key);
  const pendingState = pendingAuth?.callbackState;
  const callerState = oauthState ?? "";
  const callerOwnsPending =
    callerState === "" || pendingState === undefined || pendingState === callerState;
  if (pendingAuth && pendingAuth.serverUrl === identity.serverUrl && callerOwnsPending) {
    clearTimeout(pendingAuth.cleanupTimer);
    pendingAuth.authProvider.deactivate();
    state.pendingAuths.delete(key);
    await releaseReservedState(
      identity,
      pendingState ?? oauthState,
      pendingAuth.authStorageOptions,
    );
    return;
  }
  await releaseReservedState(identity, oauthState, fallbackStorageOptions);
}

/** Drop the reserved callback and any stored state that still matches the released flow. */
async function releaseReservedState(
  identity: AuthIdentity,
  stateToRelease: string | undefined,
  authStorageOptions: AuthStorageOptions,
): Promise<void> {
  if (stateToRelease === undefined || stateToRelease === "") {
    return;
  }
  cancelPendingCallback(stateToRelease);
  await clearMatchingStoredState(identity, stateToRelease, authStorageOptions);
}

async function clearMatchingStoredState(
  identity: AuthIdentity,
  state: string,
  options: AuthStorageOptions,
): Promise<void> {
  const stored = await Promise.resolve(getOAuthState(identity, options));
  if (stored === state) {
    clearOAuthState(identity, options);
    await Promise.resolve();
  }
}

/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 *
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
export function supportsOAuth(definition: ServerEntry): boolean {
  // OAuth requires a URL
  if (definition.url === undefined || definition.url === "") {
    return false;
  }

  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) {
    return false;
  }
  if (definition.oauth === false) {
    return false;
  }
  if (definition.auth === "oauth") {
    return true;
  }

  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) {
    return false;
  }

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined;
}

/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export async function shutdownOAuth(runtime: McpOAuthRuntime): Promise<void> {
  const state = getRuntimeState(runtime);
  if (state.controller.signal.aborted) {
    return;
  }
  state.generation += 1;
  state.controller.abort(new Error("OAuth runtime stopped"));
  // A start owns its reservation before it can publish a pending browser flow.
  // Its caller owns rejection; shutdown waits for its cancellation cleanup.
  await Promise.allSettled(
    Array.from(state.pendingStarts.values(), (starting) => starting.operation),
  );
  for (const pendingAuth of Array.from(state.pendingAuths.values())) {
    cancelPendingCallback(pendingAuth.callbackState);
  }
  const results = await Promise.allSettled(
    Array.from(state.pendingAuths.values(), (pendingAuth) =>
      clearPendingAuth(runtime, pendingAuth, undefined, pendingAuth.authStorageOptions),
    ),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  state.pendingAuthentications.clear();
  state.requests.clear();
  activeRuntimes.delete(runtime);

  if (activeRuntimes.size === 0) {
    try {
      await stopCallbackServer();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "MCP OAuth cleanup failed");
  }
}
