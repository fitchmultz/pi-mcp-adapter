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
} from "./mcp-auth.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { ServerEntry } from "./types.ts";

/** A completed authorization. Failures reject; there is no partial success to report. */
export type AuthStatus = "authenticated";

export interface McpOAuthRuntime {
  readonly signal: AbortSignal;
}

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
  authStorageOptions?: AuthStorageOptions;
  signal?: AbortSignal;
  runtime?: McpOAuthRuntime;
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
  requests: Map<string, OAuthRequest>;
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
    requests: new Map(),
  });
  activeRuntimes.add(runtime);
  return runtime;
}

let legacyRuntime = createOAuthRuntime();
activeRuntimes.delete(legacyRuntime);

export function getLegacyRuntime(): McpOAuthRuntime {
  return legacyRuntime;
}

export function getRuntime(options?: AuthenticateOptions): McpOAuthRuntime {
  if (options?.runtime) {
    options.runtime.signal.throwIfAborted();
    activeRuntimes.add(options.runtime);
    return options.runtime;
  }
  if (legacyRuntime.signal.aborted) {
    legacyRuntime = createOAuthRuntime();
  }
  activeRuntimes.add(legacyRuntime);
  return legacyRuntime;
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
  options?: AuthStorageOptions,
  runtime?: McpOAuthRuntime,
): boolean {
  const state = getRuntimeState(runtime ?? legacyRuntime);
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

export async function clearPendingAuth(
  runtime: McpOAuthRuntime,
  serverName: string,
  oauthState?: string,
  fallbackStorageOptions: AuthStorageOptions = {},
): Promise<void> {
  const state = getRuntimeState(runtime);
  const key = getPendingAuthKey(serverName, fallbackStorageOptions);
  const pendingAuth = state.pendingAuths.get(key);
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackStorageOptions;
  const pendingState = pendingAuth?.callbackState;
  if (isDifferentPendingState(oauthState, pendingState)) {
    return;
  }

  if (pendingAuth) {
    clearTimeout(pendingAuth.cleanupTimer);
    pendingAuth.authProvider.deactivate();
  }
  state.pendingAuths.delete(key);
  await releaseReservedState(serverName, pendingState ?? oauthState, authStorageOptions);
}

/** Drop the reserved callback and any stored state that still matches the released flow. */
async function releaseReservedState(
  serverName: string,
  stateToRelease: string | undefined,
  authStorageOptions: AuthStorageOptions,
): Promise<void> {
  if (stateToRelease === undefined || stateToRelease === "") {
    return;
  }
  cancelPendingCallback(stateToRelease);
  await clearMatchingStoredState(serverName, stateToRelease, authStorageOptions);
}

function isDifferentPendingState(
  oauthState: string | undefined,
  pendingState: string | undefined,
): boolean {
  return (oauthState ?? "") !== "" && (pendingState ?? "") !== "" && pendingState !== oauthState;
}

async function clearMatchingStoredState(
  serverName: string,
  state: string,
  options: AuthStorageOptions,
): Promise<void> {
  const stored = await Promise.resolve(getOAuthState(serverName, options));
  if (stored === state) {
    clearOAuthState(serverName, options);
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
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
export async function initializeOAuth(
  runtimeOrSignal?: McpOAuthRuntime | AbortSignal,
): Promise<McpOAuthRuntime> {
  if (runtimeOrSignal && "signal" in runtimeOrSignal) {
    runtimeOrSignal.signal.throwIfAborted();
    activeRuntimes.add(runtimeOrSignal);
    return runtimeOrSignal;
  }

  await shutdownOAuth(legacyRuntime);
  legacyRuntime = createOAuthRuntime(runtimeOrSignal);
  return legacyRuntime;
}

/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export async function shutdownOAuth(runtime: McpOAuthRuntime = legacyRuntime): Promise<void> {
  const state = getRuntimeState(runtime);
  if (state.controller.signal.aborted) {
    return;
  }
  state.generation += 1;
  state.controller.abort(new Error("OAuth runtime stopped"));
  for (const pendingAuth of Array.from(state.pendingAuths.values())) {
    cancelPendingCallback(pendingAuth.callbackState);
  }
  const results = await Promise.allSettled(
    Array.from(state.pendingAuths.values(), (pendingAuth) =>
      clearPendingAuth(runtime, pendingAuth.serverName, undefined, pendingAuth.authStorageOptions),
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
