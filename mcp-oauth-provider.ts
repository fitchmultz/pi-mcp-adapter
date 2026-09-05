/**
 * MCP OAuth Provider
 * 
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import {
  UnauthorizedError,
  OAuthError,
  OAuthErrorCode,
  createPrivateKeyJwtAuth,
  discoverAndRequestJwtAuthGrant,
  type FetchLike,
  validateClientMetadataUrl,
  type AddClientAuthentication,
  type OAuthClientProvider,
  type OAuthClientInformationContext,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client"
import type {
  OAuthClientMetadata,
} from "@modelcontextprotocol/client"
import {
  getAuthForUrl,
  updateTokens,
  updateClientInfo,
  clearAllCredentials,
  clearClientInfo,
  clearCodeVerifier,
  clearTokens,
  type AuthEntry,
  type AuthStorageOptions,
  type StoredTokens,
  type StoredClientInfo,
} from "./mcp-auth.ts"
import { resolveCommandSecret } from "./utils.ts"
import { isNonInteractiveOAuth, type OAuthPrivateKeyJwtConfig, type OAuthCrossAppAccessConfig } from "./types.ts"
import { combineAbortSignals } from "./runtime-owner.ts"
import sharedClientMetadata from "./docs/client-metadata.json" with { type: "json" }

/** Validate explicit document URLs without echoing possible credentials in errors. */
export function validateOAuthClientMetadataUrl(value: string | false | undefined): void {
  if (value === undefined || value === false) return
  try {
    if (typeof value !== "string" || !value) throw new Error()
    validateClientMetadataUrl(value)
    const url = new URL(value)
    const raw = value.match(/^[^:]+:[/\\]*([^/\\?#]*)([^?#]*)/)
    if (url.username || url.password || raw?.[1]?.includes("@") || value.includes("#")
      || /[/\\](?:\.|%2e){1,2}(?=[/\\]|$)/i.test(raw?.[2] ?? "")) throw new Error()
  } catch {
    throw new Error("OAuth clientMetadataUrl must be an HTTPS URL with a non-root path and no userinfo, fragment or dot segments")
  }
}

/** Only the port may differ; keep raw host, path and query spelling exact. */
export function loopbackRedirectsMatch(first: string, second: unknown): boolean {
  if (typeof second !== "string") return false
  const port = /^([^:/?#]+:\/\/[^/\\?#@]+):\d+(?=[/\\?#]|$)/
  if (!port.test(first) || !port.test(second) || first.includes("#") || second.includes("#")) return false
  try {
    return [new URL(first), new URL(second)].every(url => url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && Number(url.port) > 0)
      && first.replace(port, "$1") === second.replace(port, "$1")
  } catch {
    return false
  }
}

export function issuersMatch(first: string, second: string): boolean {
  return first === second
    || (first.endsWith("/") && first.slice(0, -1) === second)
    || (second.endsWith("/") && second.slice(0, -1) === first)
}

// Callback server configuration
const DEFAULT_OAUTH_CALLBACK_PORT = 19876
const DEFAULT_OAUTH_CALLBACK_PATH = "/callback"

let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT

if (process.env.MCP_OAUTH_CALLBACK_PORT) {
  const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10)
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    configuredOAuthCallbackPort = parsedPort
  }
}

let oauthCallbackPort = configuredOAuthCallbackPort
let oauthCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH

export function getConfiguredOAuthCallbackPort(): number {
  return configuredOAuthCallbackPort
}

export function getOAuthCallbackPort(): number {
  return oauthCallbackPort
}

export function setOAuthCallbackPort(port: number): void {
  oauthCallbackPort = port
}

export function getOAuthCallbackPath(): string {
  return oauthCallbackPath
}

export function setOAuthCallbackPath(path: string): void {
  oauthCallbackPath = path.startsWith("/") ? path : `/${path}`
}

/** Configuration options for OAuth */
export interface McpOAuthConfig {
  skipIssuerMetadataValidation?: boolean
  grantType?: "authorization_code" | "client_credentials"
  clientId?: string
  clientSecret?: string
  privateKeyJwt?: OAuthPrivateKeyJwtConfig
  crossAppAccess?: OAuthCrossAppAccessConfig
  scope?: string
  authorizationParams?: Record<string, string>
  redirectUri?: string
  clientName?: string
  clientUri?: string
  /** Custom client document URL; false disables automatic CIMD for new registrations. */
  clientMetadataUrl?: string | false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Validate shapes and method conflicts without resolving or disclosing key sources. */
export function validateOAuthPrivateKeyJwt(config: McpOAuthConfig): void {
  const jwt = config.privateKeyJwt
  if (jwt === undefined) return
  if (!isRecord(jwt)) throw new Error("OAuth privateKeyJwt must be an object")
  if (!(typeof jwt.privateKey === "string" ? jwt.privateKey.trim() : isRecord(jwt.privateKey))) {
    throw new Error("OAuth privateKeyJwt.privateKey must be a nonempty string or JWK object")
  }
  if (typeof jwt.algorithm !== "string" || !jwt.algorithm.trim() || /^(?:HS|none$)/i.test(jwt.algorithm)) {
    throw new Error("OAuth privateKeyJwt.algorithm must be an asymmetric JOSE algorithm")
  }
  if (jwt.audience !== undefined && (typeof jwt.audience !== "string" || !jwt.audience.trim())) {
    throw new Error("OAuth privateKeyJwt.audience must be a nonempty string")
  }
  if (jwt.lifetimeSeconds !== undefined && (!Number.isSafeInteger(jwt.lifetimeSeconds) || jwt.lifetimeSeconds <= 0)) {
    throw new Error("OAuth privateKeyJwt.lifetimeSeconds must be a positive integer")
  }
  if (jwt.claims !== undefined && !isRecord(jwt.claims)) throw new Error("OAuth privateKeyJwt.claims must be an object")
  if (config.clientSecret !== undefined) throw new Error("OAuth privateKeyJwt cannot be combined with clientSecret")
  if (!config.clientId && (typeof config.clientMetadataUrl !== "string" || config.clientMetadataUrl === sharedClientMetadata.client_id)) {
    throw new Error("OAuth privateKeyJwt requires a configured clientId or custom clientMetadataUrl, not the shared browser identity")
  }
}

export function validateOAuthCrossAppAccess(config: McpOAuthConfig): void {
  const crossApp = config.crossAppAccess
  if (crossApp === undefined) return
  if (!isRecord(crossApp)) throw new Error("OAuth crossAppAccess must be an object")
  for (const field of ["idpUrl", "clientId", "idToken", "clientSecret"] as const) {
    if (field === "clientSecret" && crossApp[field] === undefined) continue
    if (typeof crossApp[field] !== "string" || !crossApp[field].trim()) {
      throw new Error(`OAuth crossAppAccess.${field} must be a nonempty string`)
    }
  }
  if (config.grantType !== undefined) throw new Error("OAuth crossAppAccess selects the JWT-bearer grant; omit grantType")
  if ("audience" in crossApp || "resource" in crossApp) throw new Error("OAuth crossAppAccess uses the discovered MCP issuer and resource; overrides are not supported")
}

const reservedAuthorizationParams = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
])

function addAuthorizationParams(authorizationUrl: URL, params: Record<string, string> | undefined): URL {
  if (!params) return authorizationUrl
  const nextUrl = new URL(authorizationUrl.toString())
  for (const [key, value] of Object.entries(params)) {
    if (reservedAuthorizationParams.has(key) || nextUrl.searchParams.has(key)) {
      throw new Error(`OAuth authorizationParams.${key} cannot override an authorization flow parameter`)
    }
    nextUrl.searchParams.set(key, value)
  }
  return nextUrl
}

/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
  onDiscoveryState?: (state: OAuthDiscoveryState) => void
}

/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly redirectUrlSnapshot: string | undefined
  readonly clientMetadataUrl?: string
  private readonly controller = new AbortController()
  readonly lifetimeSignal: AbortSignal
  private readonly requestSignals = new AsyncLocalStorage<AbortSignal | undefined>()
  private flowAuthorizationServerUrl: string | undefined
  private flowResourceUrl: string | undefined
  private flowClientInfo: StoredClientInfo | undefined
  private flowCodeVerifier: string | undefined
  private flowDiscoveryState: OAuthDiscoveryState | undefined
  private flowIssuerMismatch = false
  private flowState: string | undefined

  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private storageOptions: AuthStorageOptions = {},
    runtimeSignal?: AbortSignal,
    initialState?: string,
  ) {
    validateOAuthClientMetadataUrl(config.clientMetadataUrl)
    validateOAuthPrivateKeyJwt(config)
    validateOAuthCrossAppAccess(config)
    this.lifetimeSignal = combineAbortSignals(runtimeSignal, this.controller.signal)!
    this.flowState = initialState
    this.redirectUrlSnapshot = isNonInteractiveOAuth(config)
      ? undefined
      : config.redirectUri ?? `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`
    if (config.clientMetadataUrl !== false && config.clientSecret === undefined) {
      if (config.clientMetadataUrl && config.clientMetadataUrl !== sharedClientMetadata.client_id) {
        this.clientMetadataUrl = config.clientMetadataUrl
      } else if (!this.isNonInteractive && !config.privateKeyJwt
        && (config.clientName === undefined || config.clientName === sharedClientMetadata.client_name)
        && (config.clientUri === undefined || config.clientUri === sharedClientMetadata.client_uri)
        && sharedClientMetadata.redirect_uris.some(uri => loopbackRedirectsMatch(uri, this.redirectUrl))) {
        this.clientMetadataUrl = sharedClientMetadata.client_id
      }
    }
  }

  private get isNonInteractive(): boolean {
    return isNonInteractiveOAuth(this.config)
  }

  private get discoveredIssuer(): string | undefined {
    return this.flowDiscoveryState?.authorizationServerMetadata?.issuer
      ?? this.flowDiscoveryState?.authorizationServerUrl
  }

  get signal(): AbortSignal {
    return combineAbortSignals(this.lifetimeSignal, this.requestSignals.getStore())!
  }

  runWithSignal<T>(signal: AbortSignal | undefined, operation: () => T): T {
    this.lifetimeSignal.throwIfAborted()
    return this.requestSignals.run(combineAbortSignals(this.requestSignals.getStore(), signal), operation)
  }

  deactivate(): void {
    this.controller.abort(new Error("OAuth flow is no longer active"))
    this.requestSignals.disable()
  }

  private assertStoredIssuerBindings(entry: AuthEntry | undefined, issuer: string | undefined): void {
    if (this.flowIssuerMismatch) {
      throw new Error(
        `OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`,
      )
    }
    if (!entry || !issuer) return

    const storedIssuers = [entry.clientInfo?.issuer, entry.tokens?.issuer]
      .filter((storedIssuer): storedIssuer is string => storedIssuer !== undefined)
    if (storedIssuers.some(storedIssuer => !issuersMatch(storedIssuer, issuer))) {
      this.flowIssuerMismatch = true
      throw new Error(
        `OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`,
      )
    }
  }

  private throwIfInactive(): void {
    this.signal.throwIfAborted()
  }

  /**
   * The redirect URL for OAuth callbacks.
   * This must match the redirect_uri in client metadata.
   */
  get redirectUrl(): string | undefined {
    return this.redirectUrlSnapshot
  }

  /**
   * Client metadata for dynamic registration.
   * Describes this client to the OAuth authorization server.
   */
  get clientMetadata(): OAuthClientMetadata {
    if (this.isNonInteractive) {
      return {
        client_name: this.config.clientName ?? "Pi Coding Agent",
        client_uri: this.config.clientUri ?? "https://github.com/nicobailon/pi-mcp-adapter",
        redirect_uris: [],
        grant_types: [this.config.crossAppAccess ? "urn:ietf:params:oauth:grant-type:jwt-bearer" : "client_credentials"],
        token_endpoint_auth_method: this.config.privateKeyJwt ? "private_key_jwt" : this.config.clientSecret ? "client_secret_post" : "none",
      }
    }

    const redirectUrl = this.redirectUrl
    if (!redirectUrl) {
      throw new Error("redirectUrl is required for authorization_code flow")
    }

    return {
      redirect_uris: [redirectUrl],
      client_name: this.config.clientName ?? "Pi Coding Agent",
      client_uri: this.config.clientUri ?? "https://github.com/nicobailon/pi-mcp-adapter",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.privateKeyJwt ? "private_key_jwt" : this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope !== undefined ? { scope: this.config.scope } : {}),
    }
  }

  /**
   * Get client information (for pre-registered or dynamically registered clients).
   * Returns undefined if no client info exists or if the server URL has changed.
   */
  async clientInformation(context?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = context?.issuer ?? this.discoveredIssuer
    const stored = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions)
    this.assertStoredIssuerBindings(stored, issuer)
    // Rejected discovery must not become the runtime's issuer binding.
    if (this.flowDiscoveryState) this.callbacks.onDiscoveryState?.(this.flowDiscoveryState)

    // Check config first (pre-registered client). Store only its issuer binding.
    // The configured secret stays in config and never enters the credential store.
    if (this.config.clientId) {
      const storedClient = stored?.clientInfo?.clientId === this.config.clientId
        ? stored.clientInfo
        : undefined
      if (issuer && (storedClient?.issuer !== issuer || storedClient.configPreRegistered !== true)) {
        updateClientInfo(
          this.serverName,
          { clientId: this.config.clientId, issuer, configPreRegistered: true },
          this.serverUrl,
          this.storageOptions,
        )
      }
      const clientSecret = this.config.clientSecret?.startsWith("!")
        ? resolveCommandSecret(
          this.config.clientSecret,
          `MCP server "${this.serverName}" OAuth clientSecret`,
        )
        : this.config.clientSecret
      return {
        client_id: this.config.clientId,
        client_secret: clientSecret,
        ...(issuer !== undefined ? { issuer } : {}),
      }
    }

    // Keep client registration associated with this in-flight flow even if
    // another runtime writes the shared persistent entry for the same name.
    const clientInfo = this.flowClientInfo ?? stored?.clientInfo
    if (clientInfo) {
      // A stored SEP-2352 issuer stub for a config-pre-registered client
      // (identified by the explicit marker, or by the legacy stub shape of
      // {clientId, issuer} with no registration metadata) is only meaningful
      // when the config supplies the matching client secret. Since we reach
      // this branch only when config.clientId is absent, serving the stub
      // would let a token refresh go out with a client_id but no secret,
      // causing invalid_client and credential invalidation. Return undefined
      // so callers treat this as "no client info".
      const isConfigStub = clientInfo.configPreRegistered === true
        || (clientInfo.clientSecret === undefined
          && clientInfo.clientIdIssuedAt === undefined
          && clientInfo.clientSecretExpiresAt === undefined
          && clientInfo.redirectUris === undefined)
      if (isConfigStub) {
        return undefined
      }
      if ((this.config.privateKeyJwt || this.isNonInteractive) && clientInfo.registrationType === "cimd" && clientInfo.clientId === sharedClientMetadata.client_id) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, `OAuth ${this.config.privateKeyJwt ? "privateKeyJwt" : this.config.crossAppAccess ? "crossAppAccess" : "client_credentials"} cannot use the saved shared browser registration; configure its own clientId or replace that login`)
      }
      // Check if client secret has expired
      if (clientInfo.clientSecretExpiresAt && clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        return undefined
      }
      if (issuer && clientInfo.issuer && !issuersMatch(clientInfo.issuer, issuer)) {
        return undefined
      }
      if (issuer && clientInfo.issuer === undefined) {
        clientInfo.issuer = issuer
        this.flowClientInfo = clientInfo
        updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions)
      }
      // Return all registration metadata and the local issuer extension.
      // Keep the SDK's view and the stored issuer binding consistent.
      return {
        client_id: clientInfo.clientId,
        client_secret: clientInfo.clientSecret,
        ...(clientInfo.clientIdIssuedAt !== undefined
          ? { client_id_issued_at: clientInfo.clientIdIssuedAt }
          : {}),
        ...(clientInfo.clientSecretExpiresAt !== undefined
          ? { client_secret_expires_at: clientInfo.clientSecretExpiresAt }
          : {}),
        ...(clientInfo.redirectUris !== undefined
          ? { redirect_uris: clientInfo.redirectUris }
          : {}),
        ...(clientInfo.issuer !== undefined ? { issuer: clientInfo.issuer } : {}),
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  /**
   * Save client information from dynamic registration.
   */
  async saveClientInformation(info: StoredOAuthClientInformation, context?: OAuthClientInformationContext): Promise<void> {
    this.throwIfInactive()
    const issuer = context?.issuer ?? this.discoveredIssuer ?? info.issuer
    if (this.config.clientId && info.client_id === this.config.clientId) {
      updateClientInfo(
        this.serverName,
        {
          clientId: info.client_id,
          ...(issuer !== undefined ? { issuer } : {}),
          configPreRegistered: true,
        },
        this.serverUrl,
        this.storageOptions,
      )
      return
    }

    const redirectUris = ("redirect_uris" in info ? info.redirect_uris : undefined)
      ?? (this.redirectUrl ? [this.redirectUrl] : [])
    const clientInfo: StoredClientInfo = {
      clientId: info.client_id,
      ...(info.client_secret !== undefined ? { clientSecret: info.client_secret } : {}),
      ...(info.client_id_issued_at !== undefined ? { clientIdIssuedAt: info.client_id_issued_at } : {}),
      ...(info.client_secret_expires_at !== undefined ? { clientSecretExpiresAt: info.client_secret_expires_at } : {}),
      redirectUris,
      // Native CIMD saves only client_id + issuer; DCR's full schema requires redirect_uris.
      ...(info.client_id === this.clientMetadataUrl && !("redirect_uris" in info)
        && this.flowDiscoveryState?.authorizationServerMetadata?.client_id_metadata_document_supported === true
        ? { registrationType: "cimd" as const } : {}),
      ...(issuer !== undefined ? { issuer } : {}),
    }
    this.flowClientInfo = clientInfo
    updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions)
  }

  /**
   * Get stored OAuth tokens.
   * Returns undefined if no tokens exist or if the server URL has changed.
   */
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    // Use getAuthForUrl to validate tokens are for the current server URL.
    const entry = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions)
    if (!entry?.tokens) return undefined
    const issuer = context?.issuer ?? this.discoveredIssuer
    this.assertStoredIssuerBindings(entry, issuer)
    if (issuer && entry.tokens.issuer === undefined) {
      entry.tokens.issuer = issuer
      updateTokens(this.serverName, entry.tokens, this.serverUrl, this.storageOptions)
    }

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
      ...(entry.tokens.issuer !== undefined ? { issuer: entry.tokens.issuer } : {}),
    }
  }

  /**
   * Save OAuth tokens.
   */
  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const issuer = context?.issuer ?? this.discoveredIssuer ?? tokens.issuer
    const storedTokens: StoredTokens = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
      // Preserve expiry even when expires_in is 0 (e.g. the SDK re-saving an
      // already-expired token) so expired tokens stay expired instead of
      // being persisted as never-expiring.
      ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      ...(issuer !== undefined ? { issuer } : {}),
    }
    this.throwIfInactive()
    updateTokens(this.serverName, storedTokens, this.serverUrl, this.storageOptions)
    // Discovery must survive the browser redirect so the callback can verify
    // the authorization server that minted the code. Once token issuance
    // succeeds, clear it so a later 401 re-reads PRM and can observe an
    // authorization-server migration.
    this.flowDiscoveryState = undefined
    this.flowAuthorizationServerUrl = undefined
    this.flowResourceUrl = undefined
  }

  /**
   * Redirect the user to the authorization URL.
   * This opens the browser for the user to authenticate.
   *
   * Throws UnauthorizedError when called outside of a user-initiated flow
   * (no oauthState saved by startAuth). That path is reached when the SDK
   * falls through from a failed refresh into a fresh authorization_code
   * flow, which library hosts cannot complete in-process.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.isNonInteractive) {
      throw new Error("redirectToAuthorization is not used for noninteractive OAuth flows")
    }
    // No flow-local state means we're on the post-refresh authorize fallback.
    this.throwIfInactive()
    if (!this.flowState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    // URL is passed to callback, not logged (may contain sensitive params)
    await this.callbacks.onRedirect(addAuthorizationParams(authorizationUrl, this.config.authorizationParams))
  }

  /**
   * Save the PKCE code verifier.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.throwIfInactive()
    this.flowCodeVerifier = codeVerifier
  }

  /**
   * Get the stored PKCE code verifier.
   * @throws Error if no code verifier is stored
   */
  async codeVerifier(): Promise<string> {
    if (this.isNonInteractive) {
      throw new Error("codeVerifier is not used for noninteractive OAuth flows")
    }
    this.throwIfInactive()
    if (!this.flowCodeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`)
    }
    return this.flowCodeVerifier
  }

  /**
   * Keep discovery with the in-flight PKCE verifier. The callback leg uses it
   * to validate the authorization response issuer before token exchange.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.throwIfInactive()
    this.flowDiscoveryState = structuredClone(state)
  }

  // Native auth calls this on every attempt, before stored issuer checks and resource selection.
  saveAuthorizationServerUrl(issuer: string): void {
    this.throwIfInactive()
    this.flowAuthorizationServerUrl = issuer
    this.flowResourceUrl = undefined
  }

  saveResourceUrl(resource: string): void {
    this.throwIfInactive()
    this.flowResourceUrl = resource
  }

  readonly fetch: FetchLike = (input, init) => fetch(input, {
    ...init, signal: combineAbortSignals(init?.signal ?? undefined, this.signal)!,
  })

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.throwIfInactive()
    return this.flowDiscoveryState ? structuredClone(this.flowDiscoveryState) : undefined
  }

  /**
   * Save the OAuth state parameter for CSRF protection.
   */
  async saveState(state: string): Promise<void> {
    this.throwIfInactive()
    this.flowState = state
  }

  /**
   * Get the stored OAuth state parameter.
   * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
   */
  async state(): Promise<string> {
    if (this.isNonInteractive) {
      throw new Error("state is not used for noninteractive OAuth flows")
    }
    this.throwIfInactive()
    if (!this.flowState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    return this.flowState
  }

  /**
   * Invalidate credentials when authentication fails.
   * Clears tokens, client info, or all credentials based on the type.
   */
  async invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.throwIfInactive()
    switch (type) {
      case "all":
        this.flowClientInfo = undefined
        this.flowCodeVerifier = undefined
        this.flowDiscoveryState = undefined
        this.flowAuthorizationServerUrl = undefined
        this.flowResourceUrl = undefined
        this.flowIssuerMismatch = false
        this.flowState = undefined
        clearAllCredentials(this.serverName, this.storageOptions)
        break
      case "client":
        this.flowClientInfo = undefined
        clearClientInfo(this.serverName, this.storageOptions)
        break
      case "tokens":
        clearTokens(this.serverName, this.storageOptions)
        break
      case "verifier":
        clearCodeVerifier(this.serverName, this.storageOptions)
        break
      case "discovery":
        this.flowDiscoveryState = undefined
        this.flowAuthorizationServerUrl = undefined
        this.flowResourceUrl = undefined
        break
    }
  }

  /**
   * Adds configured scope and client authentication to native token requests.
   */
  addClientAuthentication: AddClientAuthentication = async (headers, params, url, metadata) => {
    this.throwIfInactive()
    if (params.get("grant_type") === "authorization_code" && !params.has("scope") && this.config.scope) {
      params.set("scope", this.config.scope)
    }

    const clientInfo = await this.clientInformation(this.config.privateKeyJwt && metadata?.issuer ? { issuer: metadata.issuer } : undefined)
    this.throwIfInactive()
    if (!clientInfo) {
      return
    }

    const jwt = this.config.privateKeyJwt
    if (jwt) {
      if (clientInfo.client_secret !== undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, "OAuth privateKeyJwt cannot use a shared-secret client")
      }
      let privateKey = jwt.privateKey
      if (typeof privateKey === "string") {
        try {
          privateKey = resolveCommandSecret(privateKey, "OAuth privateKeyJwt.privateKey")
        } catch (error) {
          // This primitive's errors contain only the outcome, never command text or output.
          throw new OAuthError(OAuthErrorCode.InvalidRequest, (error as Error).message)
        }
      }
      try {
        if (typeof privateKey === "string" && privateKey.trimStart().startsWith("{")) privateKey = JSON.parse(privateKey)
        const { algorithm, ...options } = jwt
        await createPrivateKeyJwtAuth({
          ...options, privateKey, alg: algorithm, issuer: clientInfo.client_id, subject: clientInfo.client_id,
        })(headers, params, url, metadata)
      } catch {
        // Ordinary errors fall through into browser consent on native refresh; invalid_client erases credentials.
        throw new OAuthError(OAuthErrorCode.InvalidRequest, "OAuth privateKeyJwt could not sign an assertion; check the private key and algorithm")
      }
      this.throwIfInactive()
      params.set("client_id", clientInfo.client_id)
      return
    }

    const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? []
    const hasClientSecret = clientInfo.client_secret !== undefined
    let authMethod: "client_secret_basic" | "client_secret_post" | "none"

    if (supportedMethods.length === 0) {
      authMethod = hasClientSecret ? "client_secret_post" : "none"
    } else if (hasClientSecret && supportedMethods.includes("client_secret_basic")) {
      authMethod = "client_secret_basic"
    } else if (hasClientSecret && supportedMethods.includes("client_secret_post")) {
      authMethod = "client_secret_post"
    } else if (supportedMethods.includes("none")) {
      authMethod = "none"
    } else {
      authMethod = hasClientSecret ? "client_secret_post" : "none"
    }

    if (authMethod === "client_secret_basic") {
      if (!clientInfo.client_secret) {
        throw new Error("client_secret_basic authentication requires a client_secret")
      }
      headers.set("Authorization", `Basic ${Buffer.from(`${clientInfo.client_id}:${clientInfo.client_secret}`).toString("base64")}`)
      return
    }

    if (!params.has("client_id")) {
      params.set("client_id", clientInfo.client_id)
    }
    if (authMethod === "client_secret_post" && clientInfo.client_secret && !params.has("client_secret")) {
      params.set("client_secret", clientInfo.client_secret)
    }
  }

  private async prepareCrossAppRequest(scope?: string): Promise<URLSearchParams> {
    this.throwIfInactive()
    const audience = this.flowAuthorizationServerUrl
    const resource = this.flowResourceUrl
    if (!audience || !resource) throw new OAuthError(OAuthErrorCode.InvalidRequest, "OAuth crossAppAccess requires discovered MCP authorization server and protected resource metadata")
    const config = this.config.crossAppAccess!
    try {
      const result = await discoverAndRequestJwtAuthGrant({
        idpUrl: resolveCommandSecret(config.idpUrl, "OAuth crossAppAccess.idpUrl"),
        clientId: resolveCommandSecret(config.clientId, "OAuth crossAppAccess.clientId"),
        idToken: resolveCommandSecret(config.idToken, "OAuth crossAppAccess.idToken"),
        ...(config.clientSecret !== undefined ? { clientSecret: resolveCommandSecret(config.clientSecret, "OAuth crossAppAccess.clientSecret") } : {}),
        audience, resource, ...(scope ? { scope } : {}), fetchFn: this.fetch,
      })
      this.throwIfInactive()
      const params = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: result.jwtAuthGrant })
      if (scope) params.set("scope", scope)
      return params
    } catch {
      this.throwIfInactive()
      // IdP errors must not erase the MCP login or expose token-bearing responses/commands.
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "OAuth crossAppAccess could not obtain an IdP grant; check the IdP configuration and ID-token source")
    }
  }

  prepareTokenRequest(scope?: string): URLSearchParams | Promise<URLSearchParams> | undefined {
    if (this.config.crossAppAccess) return this.prepareCrossAppRequest(scope ?? this.config.scope)
    if (!this.isNonInteractive) {
      return undefined
    }

    const params = new URLSearchParams({ grant_type: "client_credentials" })
    const requestedScope = scope ?? this.config.scope
    if (requestedScope) {
      params.set("scope", requestedScope)
    }
    return params
  }
}

export { DEFAULT_OAUTH_CALLBACK_PORT, DEFAULT_OAUTH_CALLBACK_PATH }
