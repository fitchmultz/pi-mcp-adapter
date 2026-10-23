/**
 * SDK-free OAuth runtime ownership and pending-flow cleanup.
 * Native auth/protocol implementation stays in mcp-auth-flow.ts and is loaded
 * only by operations that need it; all callers share the state owned here.
 */

import type { McpOAuthProvider } from "./mcp-oauth-provider.ts"
import { cancelPendingCallback, stopCallbackServer } from "./mcp-callback-server.ts"
import { getAuthBaseDir, getOAuthState, clearOAuthState, type AuthStorageOptions } from "./mcp-auth.ts"
import { combineAbortSignals } from "./runtime-owner.ts"
import type { ServerEntry } from "./types.ts"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export interface McpOAuthRuntime {
  readonly signal: AbortSignal
}

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>
  authStorageOptions?: AuthStorageOptions
  signal?: AbortSignal
  runtime?: McpOAuthRuntime
}

export type AuthDiscovery = {
  resourceMetadataUrl?: URL
  scope?: string
  skipIssuerMetadataValidation?: boolean
}

export type CallbackIssuer = { expectedIssuer?: string | undefined; fallbackIssuer?: string; issParameterSupported?: boolean }

export type PendingAuth = {
  serverName: string
  authProvider: McpOAuthProvider
  serverUrl: string
  authorizationUrl: string
  discovery: AuthDiscovery
  callbackIssuer: CallbackIssuer
  request?: OAuthRequest
  authStorageOptions: AuthStorageOptions
}

export type RuntimeState = {
  controller: AbortController
  generation: number
  pendingAuths: Map<string, PendingAuth>
  pendingAuthStates: Map<string, string>
  pendingAuthCleanupTimers: Map<string, ReturnType<typeof setTimeout>>
  pendingAuthentications: Map<string, Promise<AuthStatus>>
  requests: Map<string, OAuthRequest>
}

const runtimeStates = new WeakMap<McpOAuthRuntime, RuntimeState>()
const activeRuntimes = new Set<McpOAuthRuntime>()

export function createOAuthRuntime(signal?: AbortSignal): McpOAuthRuntime {
  const controller = new AbortController()
  const runtime = { signal: combineAbortSignals(signal, controller.signal)! } satisfies McpOAuthRuntime
  runtimeStates.set(runtime, {
    controller,
    generation: 0,
    pendingAuths: new Map(),
    pendingAuthStates: new Map(),
    pendingAuthCleanupTimers: new Map(),
    pendingAuthentications: new Map(),
    requests: new Map(),
  })
  activeRuntimes.add(runtime)
  return runtime
}

export let legacyRuntime = createOAuthRuntime()
activeRuntimes.delete(legacyRuntime)

export function getRuntime(options?: AuthenticateOptions): McpOAuthRuntime {
  if (options?.runtime) {
    options.runtime.signal.throwIfAborted()
    activeRuntimes.add(options.runtime)
    return options.runtime
  }
  if (legacyRuntime.signal.aborted) legacyRuntime = createOAuthRuntime()
  activeRuntimes.add(legacyRuntime)
  return legacyRuntime
}

export function getRuntimeState(runtime: McpOAuthRuntime): RuntimeState {
  const state = runtimeStates.get(runtime)
  if (!state) throw new Error("Unknown OAuth runtime")
  return state
}

export function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
  return JSON.stringify([serverName, getAuthBaseDir(options)])
}

export type OAuthRequest = {
  serverName: string
  serverUrl: string
  requestedScope?: string
  challenge?: { requiredScope?: string; resourceMetadataUrl?: URL }
  issuer?: string
}

export function hasPendingAuth(serverName: string, options?: AuthStorageOptions, runtime?: McpOAuthRuntime): boolean {
  const state = getRuntimeState(runtime ?? legacyRuntime)
  if (options) {
    return state.pendingAuths.has(getPendingAuthKey(serverName, options))
  }
  return Array.from(state.pendingAuths.values()).some(pendingAuth => pendingAuth.serverName === serverName)
}

export async function clearPendingAuth(runtime: McpOAuthRuntime, serverName: string, oauthState?: string, fallbackStorageOptions: AuthStorageOptions = {}): Promise<void> {
  const state = getRuntimeState(runtime)
  const key = getPendingAuthKey(serverName, fallbackStorageOptions)
  const pendingAuth = state.pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackStorageOptions
  const pendingState = state.pendingAuthStates.get(key)
  if (oauthState && pendingState && pendingState !== oauthState) return

  const timer = state.pendingAuthCleanupTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    state.pendingAuthCleanupTimers.delete(key)
  }

  pendingAuth?.authProvider.deactivate()
  state.pendingAuths.delete(key)
  state.pendingAuthStates.delete(key)
  const stateToRelease = pendingState ?? oauthState
  if (stateToRelease) {
    cancelPendingCallback(stateToRelease)
    const storedState = await getOAuthState(serverName, authStorageOptions)
    if (storedState === stateToRelease) {
      await clearOAuthState(serverName, authStorageOptions)
    }
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
  if (!definition.url) return false

  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) return false
  if (definition.oauth === false) return false
  if (definition.auth === "oauth") return true

  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) return false

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined
}

/**
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
export async function initializeOAuth(
  runtimeOrSignal?: McpOAuthRuntime | AbortSignal,
): Promise<McpOAuthRuntime> {
  if (runtimeOrSignal && "signal" in runtimeOrSignal) {
    runtimeOrSignal.signal.throwIfAborted()
    activeRuntimes.add(runtimeOrSignal)
    return runtimeOrSignal
  }

  await shutdownOAuth(legacyRuntime)
  legacyRuntime = createOAuthRuntime(runtimeOrSignal as AbortSignal | undefined)
  return legacyRuntime
}

/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export async function shutdownOAuth(runtime: McpOAuthRuntime = legacyRuntime): Promise<void> {
  const state = getRuntimeState(runtime)
  if (state.controller.signal.aborted) return
  state.generation += 1
  state.controller.abort(new Error("OAuth runtime stopped"))
  for (const callbackState of Array.from(state.pendingAuthStates.values())) cancelPendingCallback(callbackState)
  const results = await Promise.allSettled(Array.from(state.pendingAuths.values(), pendingAuth =>
    clearPendingAuth(runtime, pendingAuth.serverName, undefined, pendingAuth.authStorageOptions)))
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
  state.pendingAuthentications.clear()
  state.requests.clear()
  activeRuntimes.delete(runtime)

  if (activeRuntimes.size === 0) {
    try { await stopCallbackServer() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, "MCP OAuth cleanup failed")
}
