/**
 * MCP Auth Flow
 * 
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
  Client,
  StreamableHTTPClientTransport,
  validateAuthorizationResponseIssuer,
  InsufficientScopeError,
  SdkHttpError,
  computeScopeUnion,
  isStrictScopeSuperset,
} from "@modelcontextprotocol/client"
import open from "open"
import { McpOAuthProvider, issuersMatch, loopbackRedirectsMatch, validateOAuthClientMetadataUrl, validateOAuthPrivateKeyJwt, validateOAuthCrossAppAccess, type McpOAuthConfig } from "./mcp-oauth-provider.ts"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  releaseCallbackServer,
} from "./mcp-callback-server.ts"
import {
  getAuthForUrl,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  getOAuthState,
  clearOAuthState,
  getAuthBaseDir,
  type AuthStorageOptions,
} from "./mcp-auth.ts"
import { isServerDisabled, isNonInteractiveOAuth, validateServerProtocolConfig, type ServerEntry } from "./types.ts"
import { formatTerminalError, interpolateEnvRecord, interpolateEnvVars, normalizeRequestTimeoutMs } from "./utils.ts"
import { abortable, throwIfAborted } from "./abort.ts"
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts"

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

type AuthDiscovery = {
  resourceMetadataUrl?: URL
  scope?: string
  skipIssuerMetadataValidation?: boolean
}

function applyConfiguredScope(discovery: AuthDiscovery, config: McpOAuthConfig): AuthDiscovery {
  return {
    ...discovery,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    ...(config.skipIssuerMetadataValidation !== undefined ? { skipIssuerMetadataValidation: config.skipIssuerMetadataValidation } : {}),
  }
}

type CallbackIssuer = { expectedIssuer?: string | undefined; fallbackIssuer?: string; issParameterSupported?: boolean }

function validateCallbackIssuer(serverName: string, context: CallbackIssuer, response: { iss?: string; error?: string }): void {
  if (response.error && context.expectedIssuer === undefined) {
    throw new Error("Cannot verify the OAuth error callback issuer")
  }
  try {
    validateAuthorizationResponseIssuer({ expectedIssuer: context.expectedIssuer ?? context.fallbackIssuer, issParameterSupported: context.issParameterSupported === true, iss: response.iss })
  } catch {
    if (response.iss === undefined && context.issParameterSupported) {
      throw new Error(
        `The authorization server for ${serverName} requires the RFC 9207 "iss" parameter. ` +
        "Paste the full redirect URL from the browser address bar (not just the authorization code).",
      )
    }
    throw new Error(`The OAuth authorization response issuer does not match the discovered issuer for ${serverName}.`)
  }
}

type PendingAuth = {
  serverName: string
  authProvider: McpOAuthProvider
  serverUrl: string
  authorizationUrl: string
  discovery: AuthDiscovery
  callbackIssuer: CallbackIssuer
  request?: OAuthRequest
  authStorageOptions: AuthStorageOptions
}

type RuntimeState = {
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

let legacyRuntime = createOAuthRuntime()
activeRuntimes.delete(legacyRuntime)

function getRuntime(options?: AuthenticateOptions): McpOAuthRuntime {
  if (options?.runtime) {
    options.runtime.signal.throwIfAborted()
    activeRuntimes.add(options.runtime)
    return options.runtime
  }
  if (legacyRuntime.signal.aborted) legacyRuntime = createOAuthRuntime()
  activeRuntimes.add(legacyRuntime)
  return legacyRuntime
}

function getRuntimeState(runtime: McpOAuthRuntime): RuntimeState {
  const state = runtimeStates.get(runtime)
  if (!state) throw new Error("Unknown OAuth runtime")
  return state
}

function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
  return JSON.stringify([serverName, getAuthBaseDir(options)])
}

type OAuthRequest = {
  serverName: string
  serverUrl: string
  requestedScope?: string
  challenge?: { requiredScope?: string; resourceMetadataUrl?: URL }
  issuer?: string
}

export function isOAuthChallenge(error: unknown): error is InsufficientScopeError | UnauthorizedError | SdkHttpError {
  return error instanceof InsufficientScopeError || error instanceof UnauthorizedError
    || (error instanceof SdkHttpError && error.status === 401)
}

export function getOAuthRequest(serverName: string, serverUrl: string, storageBase: string, runtime: McpOAuthRuntime = legacyRuntime): OAuthRequest | undefined {
  if (runtime.signal.aborted) return undefined
  const request = getRuntimeState(runtime).requests.get(JSON.stringify([serverName, storageBase]))
  return request?.serverUrl === serverUrl ? request : undefined
}

/** Observe native challenges only; no credential reads or auth work here. */
export function recordOAuthChallenge(serverName: string, serverUrl: string, storageBase: string, error: unknown, runtime: McpOAuthRuntime = legacyRuntime): void {
  if (runtime.signal.aborted || !isOAuthChallenge(error)) return
  const previous = getOAuthRequest(serverName, serverUrl, storageBase, runtime)
  const request: OAuthRequest = { ...previous, serverName, serverUrl }
  if (error instanceof InsufficientScopeError) {
    const requiredScope = computeScopeUnion(previous?.challenge?.requiredScope, error.requiredScope)
    const resourceMetadataUrl = error.resourceMetadataUrl ?? previous?.challenge?.resourceMetadataUrl
    request.challenge = { ...(requiredScope ? { requiredScope } : {}), ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) }
  }
  getRuntimeState(runtime).requests.set(JSON.stringify([serverName, storageBase]), request)
}

export function bindOAuthRequestIssuer(serverName: string, serverUrl: string, storageBase: string, issuer: string, runtime: McpOAuthRuntime = legacyRuntime): void {
  const request = getOAuthRequest(serverName, serverUrl, storageBase, runtime)
  if (!request) return
  if (request.issuer && !issuersMatch(request.issuer, issuer)) {
    throw new Error(`OAuth authorization server issuer changed for ${serverName}; clear credentials before authenticating again`)
  }
  request.issuer = issuer
}

export function hasPendingAuth(serverName: string, options?: AuthStorageOptions, runtime?: McpOAuthRuntime): boolean {
  const state = getRuntimeState(runtime ?? legacyRuntime)
  if (options) {
    return state.pendingAuths.has(getPendingAuthKey(serverName, options))
  }
  return Array.from(state.pendingAuths.values()).some(pendingAuth => pendingAuth.serverName === serverName)
}

/** Timeout for manual auth completion (5 minutes) */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Extract OAuth configuration from a ServerEntry.
 */
export function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
  validateServerProtocolConfig(definition)
  if (definition.oauth === false) {
    return {}
  }

  const config: McpOAuthConfig = {}
  if (definition.oauth?.skipIssuerMetadataValidation !== undefined) config.skipIssuerMetadataValidation = definition.oauth.skipIssuerMetadataValidation
  if (definition.oauth?.grantType !== undefined) config.grantType = definition.oauth.grantType
  if (definition.oauth?.clientId !== undefined) {
    if (typeof definition.oauth.clientId !== "string") throw new Error("OAuth clientId must be a string")
    config.clientId = interpolateEnvVars(definition.oauth.clientId)
  }
  if (definition.oauth?.clientSecret !== undefined) {
    if (typeof definition.oauth.clientSecret !== "string") throw new Error("OAuth clientSecret must be a string")
    // Preserve command expressions for the provider; interpolation remains eager for ordinary values.
    config.clientSecret = definition.oauth.clientSecret.startsWith("!")
      ? definition.oauth.clientSecret
      : interpolateEnvVars(definition.oauth.clientSecret)
  }
  if (definition.oauth?.clientMetadataUrl !== undefined) {
    const value = definition.oauth.clientMetadataUrl
    if (value !== false && typeof value !== "string") throw new Error("OAuth clientMetadataUrl must be a string or false")
    config.clientMetadataUrl = value === false ? false : interpolateEnvVars(value)
    validateOAuthClientMetadataUrl(config.clientMetadataUrl)
  }
  if (definition.oauth?.privateKeyJwt !== undefined) {
    // Keep environment and command sources lazy; each authentication resolves its own key.
    config.privateKeyJwt = definition.oauth.privateKeyJwt
  }
  if (definition.oauth?.crossAppAccess !== undefined) config.crossAppAccess = definition.oauth.crossAppAccess
  validateOAuthPrivateKeyJwt(config)
  validateOAuthCrossAppAccess(config)
  if (definition.oauth?.scope !== undefined) {
    if (typeof definition.oauth.scope !== "string") throw new Error("OAuth scope must be a string")
    config.scope = interpolateEnvVars(definition.oauth.scope)
  }
  if (definition.oauth?.authorizationParams !== undefined) {
    const params = definition.oauth.authorizationParams
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("OAuth authorizationParams must be an object")
    }
    config.authorizationParams = {}
    for (const [key, value] of Object.entries(params)) {
      if (!key) throw new Error("OAuth authorizationParams keys must not be empty")
      if (typeof value !== "string") throw new Error(`OAuth authorizationParams.${key} must be a string`)
      config.authorizationParams[key] = interpolateEnvVars(value)
    }
  }
  if (definition.oauth?.redirectUri !== undefined) {
    if (typeof definition.oauth.redirectUri !== "string") {
      throw new Error("OAuth redirectUri must be a string")
    }
    const redirectUri = interpolateEnvVars(definition.oauth.redirectUri).trim()
    if (!redirectUri) {
      throw new Error("OAuth redirectUri must not be empty")
    }
    config.redirectUri = redirectUri
  }
  if (definition.oauth?.clientName !== undefined) {
    if (typeof definition.oauth.clientName !== "string") {
      throw new Error("OAuth clientName must be a string")
    }
    const clientName = interpolateEnvVars(definition.oauth.clientName).trim()
    if (!clientName) {
      throw new Error("OAuth clientName must not be empty")
    }
    config.clientName = clientName
  }
  if (definition.oauth?.clientUri !== undefined) {
    if (typeof definition.oauth.clientUri !== "string") {
      throw new Error("OAuth clientUri must be a string")
    }
    const clientUri = interpolateEnvVars(definition.oauth.clientUri).trim()
    if (!clientUri) {
      throw new Error("OAuth clientUri must not be empty")
    }
    config.clientUri = clientUri
  }
  return config
}

async function probeAuthDiscovery(serverUrl: string, definition?: ServerEntry, signal?: AbortSignal): Promise<AuthDiscovery> {
  // Discovery must not execute config commands or send their source text.
  const discoveryHeaders = definition?.headers
    ? Object.fromEntries(Object.entries(definition.headers).filter(([, value]) => !value.startsWith("!") || value.startsWith("!!")))
    : undefined
  const headers = new Headers(interpolateEnvRecord(discoveryHeaders))
  const timeout = normalizeRequestTimeoutMs(definition?.requestTimeoutMs) ?? 5000
  const discoverySignal = combineAbortSignals(signal, AbortSignal.timeout(Math.ceil(timeout)))
  let discovery: AuthDiscovery = {}
  const client = new Client({ name: "pi-mcp-auth-discovery", version: "4.3.0" }, {
    versionNegotiation: { mode: definition?.protocolVersion ?? "auto" },
    ...(isNonInteractiveOAuth(definition?.oauth)
      ? { capabilities: { extensions: { [definition?.oauth && definition.oauth.crossAppAccess
        ? "io.modelcontextprotocol/enterprise-managed-authorization" : "io.modelcontextprotocol/oauth-client-credentials"]: {} } } } : {}),
  })
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers },
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
      discovery = { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) }
      return response
    },
  })
  try {
    await abortable(client.connect(transport, { timeout }), discoverySignal)
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal)
  } finally {
    await (client.transport ? client.close() : transport.close())
  }
  return discovery
}

function parseOAuthRedirectUri(redirectUri: string): { port: number; callbackHost: string; callbackPath: string } {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error })
  }

  const hostname = url.hostname.toLowerCase()
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI")
  }

  if (url.username || url.password) {
    throw new Error("OAuth redirectUri must not include username or password")
  }

  if (url.hash) {
    throw new Error("OAuth redirectUri must not include a fragment")
  }

  if (!url.port) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const callbackHost = hostname === "[::1]" ? "::1" : hostname
  return { port, callbackHost, callbackPath: url.pathname }
}

/**
 * Start OAuth authentication flow for a server.
 * Returns the authorization URL when browser authorization is required.
 */
export async function startAuth(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
  options: AuthenticateOptions = {},
): Promise<{ authorizationUrl: string }> {
  if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`)
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const config = definition ? extractOAuthConfig(definition) : {}
  const authStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  const generation = runtimeState.generation
  throwIfAborted(signal)

  if (isNonInteractiveOAuth(config)) {
    const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
    if (!config.crossAppAccess && storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      clearClientInfo(serverName, authStorageOptions)
      clearCodeVerifier(serverName, authStorageOptions)
      await clearOAuthState(serverName, authStorageOptions)
    }

    const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async () => {
        throw new Error("Browser redirect is not used for noninteractive OAuth flows")
      },
    }, authStorageOptions, signal)
    try {
      const discovery = applyConfiguredScope(await probeAuthDiscovery(serverUrl, definition, signal), config)
      throwIfAborted(signal)
      const result = await abortable(runSdkAuth(authProvider, { serverUrl, ...discovery, fetchFn: authProvider.fetch }), signal)
      throwIfAborted(signal)
      if (result !== "AUTHORIZED") {
        throw new UnauthorizedError("Failed to authorize")
      }
      return { authorizationUrl: "" }
    } finally {
      authProvider.deactivate()
    }
  }

  const storageBase = getAuthBaseDir(authStorageOptions)
  const request = getOAuthRequest(serverName, serverUrl, storageBase, runtime)
  const existingPendingAuth = runtimeState.pendingAuths.get(getPendingAuthKey(serverName, authStorageOptions))
  if (existingPendingAuth?.serverUrl === serverUrl) {
    return { authorizationUrl: existingPendingAuth.authorizationUrl }
  }

  const redirectCallback = config.redirectUri !== undefined ? parseOAuthRedirectUri(config.redirectUri) : undefined
  const oauthState = generateState()
  const callbackIssuer: CallbackIssuer = {}

  try {
    await ensureCallbackServer({
      strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
      validate: response => validateCallbackIssuer(serverName, callbackIssuer, response),
      ...(redirectCallback ? { port: redirectCallback.port, callbackHost: redirectCallback.callbackHost, callbackPath: redirectCallback.callbackPath } : {}),
    })
    throwIfAborted(signal)
  } catch (error) {
    releaseCallbackServer(oauthState)
    try {
      await clearOAuthState(serverName, authStorageOptions)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed")
    }
    throw error
  }

  let capturedUrl: URL | undefined
  let authProvider: McpOAuthProvider | undefined
  try {
    const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
    let discovery = applyConfiguredScope(await probeAuthDiscovery(serverUrl, definition, signal), config)
    if (request?.challenge) {
      const scope = computeScopeUnion(discovery.scope, request.requestedScope, storedAuth?.tokens?.scope, request.challenge.requiredScope)
      discovery = { ...discovery, ...(scope ? { scope } : {}), ...(request.challenge.resourceMetadataUrl ? { resourceMetadataUrl: request.challenge.resourceMetadataUrl } : {}) }
    }
    throwIfAborted(signal)
    const flowConfig = { ...config, ...(request?.challenge && discovery.scope ? { scope: discovery.scope } : {}) }
    authProvider = new McpOAuthProvider(serverName, serverUrl, flowConfig, {
      onRedirect: url => {
        capturedUrl = url
        const requestedScope = url.searchParams.get("scope") ?? undefined
        if (requestedScope) {
          discovery = { ...discovery, scope: requestedScope }
          if (request?.challenge) flowConfig.scope = requestedScope
        }
        const current = getOAuthRequest(serverName, serverUrl, storageBase, runtime)
        const scope = computeScopeUnion(current?.requestedScope, requestedScope)
        if (current && scope) current.requestedScope = scope
      },
      onDiscoveryState: state => {
        callbackIssuer.expectedIssuer = state.authorizationServerMetadata?.issuer
        callbackIssuer.fallbackIssuer = state.authorizationServerUrl
        callbackIssuer.issParameterSupported = state.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true
        bindOAuthRequestIssuer(serverName, serverUrl, storageBase, callbackIssuer.expectedIssuer ?? state.authorizationServerUrl, runtime)
      },
    }, authStorageOptions, runtime.signal, oauthState)
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        clearClientInfo(serverName, authStorageOptions)
        clearCodeVerifier(serverName, authStorageOptions)
        await clearOAuthState(serverName, authStorageOptions)
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris
        const redirectUrl = authProvider.redirectUrl ?? ""
        const matchesRedirect = Array.isArray(redirectUris) && (redirectUris.includes(redirectUrl)
          || (storedAuth.clientInfo.registrationType === "cimd"
            && redirectUris.some(uri => loopbackRedirectsMatch(redirectUrl, uri))))
        if (!matchesRedirect) {
          clearClientInfo(serverName, authStorageOptions)
          clearTokens(serverName, authStorageOptions)
          clearCodeVerifier(serverName, authStorageOptions)
          await clearOAuthState(serverName, authStorageOptions)
        }
      }
    }

    throwIfAborted(signal)

    const result = await abortable(runSdkAuth(authProvider, {
      serverUrl, ...discovery,
      ...(request?.challenge ? { forceReauthorization: isStrictScopeSuperset(discovery.scope, storedAuth?.tokens?.scope) } : {}),
    }), signal)
    throwIfAborted(signal)
    if (result === "AUTHORIZED") {
      authProvider.deactivate()
      releaseCallbackServer(oauthState)
      await clearOAuthState(serverName, authStorageOptions)
      return { authorizationUrl: "" }
    }
    if (!capturedUrl) {
      throw new UnauthorizedError("OAuth authorization URL was not provided")
    }
    await setPendingAuth(runtime, serverName, { serverName, authProvider, serverUrl, authorizationUrl: capturedUrl.toString(), discovery, callbackIssuer: { ...callbackIssuer }, authStorageOptions, ...(request ? { request } : {}) }, oauthState, signal, generation)
    return { authorizationUrl: capturedUrl.toString() }
  } catch (error) {
    authProvider?.deactivate()
    try {
      await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed")
    }
    throw error
  }
}

async function setPendingAuth(
  runtime: McpOAuthRuntime,
  serverName: string,
  pendingAuth: PendingAuth,
  oauthState: string,
  signal?: AbortSignal,
  generation = getRuntimeState(runtime).generation,
): Promise<void> {
  const state = getRuntimeState(runtime)
  const key = getPendingAuthKey(serverName, pendingAuth.authStorageOptions)
  await clearPendingAuth(runtime, serverName, undefined, pendingAuth.authStorageOptions)
  throwIfAborted(signal)
  if (generation !== state.generation) throw new Error("OAuth runtime stopped")
  state.pendingAuths.set(key, pendingAuth)
  state.pendingAuthStates.set(key, oauthState)
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(runtime, serverName, oauthState, pendingAuth.authStorageOptions).catch(error => {
      console.error(`MCP Auth: Timed-out flow cleanup failed: ${formatTerminalError(error)}`)
    })
  }, MANUAL_AUTH_TIMEOUT_MS)
  cleanupTimer.unref?.()
  state.pendingAuthCleanupTimers.set(key, cleanupTimer)
}

async function clearPendingAuth(runtime: McpOAuthRuntime, serverName: string, oauthState?: string, fallbackStorageOptions: AuthStorageOptions = {}): Promise<void> {
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

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    const url = new URL(input)
    const params = new URLSearchParams(url.search)
    if (url.hash) {
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
      const hashParams = new URLSearchParams(hash)
      for (const [key, value] of hashParams) {
        if (!params.has(key)) params.set(key, value)
      }
    }
    return params
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query)
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined
  }
}

/** Authorization code plus the optional RFC 9207 `iss` callback parameter. */
export interface AuthorizationCodeInput {
  code: string
  iss?: string
}

/**
 * Extract an OAuth authorization code (and the RFC 9207 `iss` parameter, when
 * present) from either a raw code, a query string, or the full localhost
 * redirect URL copied from the browser address bar.
 */
type AuthorizationResponseInput = AuthorizationCodeInput | { error: string; errorDescription?: string; iss?: string; code?: never }

export function parseAuthorizationRedirectInput(input: string, expectedState?: string): AuthorizationResponseInput {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Authorization code or redirect URL is required")
  }

  const params = getSearchParamsFromInput(trimmed)
  if (params) {
    const state = params.get("state")
    if (expectedState && !state) {
      throw new Error("OAuth state missing from redirect URL")
    }
    if (expectedState && state !== expectedState) {
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    const error = params.get("error")
    if (error) {
      const description = params.get("error_description")
      const iss = params.get("iss")
      return { error, ...(description !== null ? { errorDescription: description } : {}), ...(iss !== null ? { iss } : {}) }
    }
    const code = params.get("code")
    if (code) {
      const iss = params.get("iss")
      return { code, ...(iss !== null ? { iss } : {}) }
    }
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return { code: trimmed }
  }

  throw new Error("Could not find an OAuth authorization code in the provided input")
}

/**
 * Complete OAuth authentication from manual user input.
 */
export async function completeAuthFromInput(
  serverName: string,
  input: string,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions)
  const oauthState = runtimeState.pendingAuthStates.get(key)
  throwIfAborted(signal)
  const parsed = parseAuthorizationRedirectInput(input, oauthState)
  return completeAuth(serverName, parsed, options)
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(
  serverName: string,
  authorizationCode: string | AuthorizationResponseInput,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const response = typeof authorizationCode === "string" ? { code: authorizationCode } : authorizationCode
  const { iss } = response
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions)
  const pendingAuth = runtimeState.pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackAuthStorageOptions
  if (!pendingAuth) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`)
  }

  const oauthState = runtimeState.pendingAuthStates.get(key)
  throwIfAborted(signal)

  let keepPendingForRetry = false
  let caughtError: unknown
  try {
    keepPendingForRetry = iss === undefined && pendingAuth.callbackIssuer.issParameterSupported === true
    validateCallbackIssuer(serverName, pendingAuth.callbackIssuer, response)
    if ("error" in response) {
      keepPendingForRetry = true
      throw new Error(response.errorDescription ? `${response.error}: ${response.errorDescription}` : response.error)
    }

    const result = await abortable(runSdkAuth(pendingAuth.authProvider, {
      serverUrl: pendingAuth.serverUrl,
      authorizationCode: response.code,
      ...(iss !== undefined ? { iss } : {}),
      ...pendingAuth.discovery,
    }), signal)
    throwIfAborted(signal)
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize")
    }
    const request = pendingAuth.request
    if (request?.challenge?.requiredScope
      && request === getOAuthRequest(serverName, pendingAuth.serverUrl, getAuthBaseDir(authStorageOptions), runtime)) {
      const issuedScope = (await getAuthForUrl(serverName, pendingAuth.serverUrl, authStorageOptions))?.tokens?.scope
      if (issuedScope !== undefined && !isStrictScopeSuperset(request.challenge.requiredScope, issuedScope)) delete request.challenge
    }
    return "authenticated"
  } catch (error) {
    caughtError = error
    throw error
  } finally {
    if (!keepPendingForRetry) {
      try {
        await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
      } catch (cleanupError) {
        if (caughtError !== undefined) {
          throw new AggregateError([caughtError, cleanupError], "OAuth completion cleanup failed")
        }
        throw cleanupError
      }
    }
  }
}

/**
 * Perform the complete OAuth authentication flow for a server.
 * 
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server  
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
export async function authenticate(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`)
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const authStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const authKey = JSON.stringify([serverName, serverUrl, getAuthBaseDir(authStorageOptions)])
  const inFlight = runtimeState.pendingAuthentications.get(authKey)
  if (inFlight) {
    return inFlight
  }

  const operation = (async (): Promise<AuthStatus> => {
    // Start auth flow
    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, {
      ...options,
      ...(signal ? { signal } : {}),
      runtime,
    })

    // If no auth URL needed, already authenticated
    if (!authorizationUrl) {
      return "authenticated"
    }

    let oauthState: string | undefined
    try {
      // Get the state that was already generated and stored in startAuth().
      // Keep this lookup and its abort check inside the cleanup boundary because
      // startAuth has already reserved callback state at this point.
      oauthState = runtimeState.pendingAuthStates.get(getPendingAuthKey(serverName, authStorageOptions))
      throwIfAborted(signal)
      if (!oauthState) {
        throw new Error("OAuth state not found - this should not happen")
      }

      // Register the callback BEFORE opening the browser.
      const callbackPromise = waitForCallback(oauthState)
      void callbackPromise.catch(() => {})

      // Open browser. Always surface the URL first so remote/headless users can copy it
      // even when the OS browser handoff is unavailable or invisible.
      if (options.onAuthorizationUrl) {
        await abortable(Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), signal)
      } else {
        console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
      }
      try {
        await abortable(open(authorizationUrl), signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        console.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error })
      }

      // Wait for callback
      const callbackResult = await abortable(callbackPromise, signal)

      // The callback server accepted only the flow-local reserved state.
      throwIfAborted(signal)

      // Complete the auth
      return await completeAuth(serverName, callbackResult, {
        ...options,
        ...(signal ? { signal } : {}),
        runtime,
      })
    } catch (error) {
      if (oauthState) cancelPendingCallback(oauthState)
      try {
        await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OAuth cancellation cleanup failed")
      }
      throw error
    }
  })()

  runtimeState.pendingAuthentications.set(authKey, operation)

  try {
    return await operation
  } finally {
    if (runtimeState.pendingAuthentications.get(authKey) === operation) {
      runtimeState.pendingAuthentications.delete(authKey)
    }
  }
}

/**
 * Remove all OAuth credentials for a server.
 * 
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string, options: AuthenticateOptions = {}): Promise<void> {
  const runtime = getRuntime(options)
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const authStorageOptions = options.authStorageOptions ?? {}
  const oauthState = await getOAuthState(serverName, authStorageOptions)
  throwIfAborted(signal)
  if (oauthState) {
    cancelPendingCallback(oauthState)
  }
  await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
  throwIfAborted(signal)
  for (const [key, request] of getRuntimeState(runtime).requests) {
    if (request.serverName === serverName) getRuntimeState(runtime).requests.delete(key)
  }
  clearAllCredentials(serverName, authStorageOptions)
  await clearOAuthState(serverName, authStorageOptions)
  throwIfAborted(signal)
  console.log(`MCP Auth: Removed credentials for ${serverName}`)
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
  for (const pendingAuth of Array.from(state.pendingAuths.values())) {
    await clearPendingAuth(runtime, pendingAuth.serverName, undefined, pendingAuth.authStorageOptions)
  }
  state.pendingAuthentications.clear()
  state.requests.clear()
  activeRuntimes.delete(runtime)

  if (activeRuntimes.size === 0) {
    await stopCallbackServer()
  }
}
