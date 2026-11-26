/**
 * MCP OAuth Provider
 *
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  UnauthorizedError,
  type FetchLike,
  type AddClientAuthentication,
  type OAuthClientProvider,
  type OAuthClientInformationContext,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type OAuthDiscoveryState,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";
import {
  getAuthForUrl,
  updateTokens,
  updateClientInfo,
  clearAllCredentials,
  clearClientInfo,
  clearCodeVerifier,
  clearTokens,
  clearTokensIfMatching,
  type AuthEntry,
  type AuthIdentity,
  type AuthStorageOptions,
  type StoredTokens,
  type StoredClientInfo,
  type TokenSnapshot,
} from "./mcp-auth.ts";
import { ProviderTokenCache } from "./mcp-oauth-refresh.ts";
import {
  applyTokenClientAuthentication,
  clientCredentialsTokenParams,
  prepareCrossAppTokenParams,
} from "./mcp-oauth-client-auth.ts";
import { resolveCommandSecret } from "./utils.ts";
import { isNonInteractiveOAuth } from "./types.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { getOAuthCallbackPath, getOAuthCallbackPort } from "./mcp-oauth-callback-config.ts";
import {
  validateOAuthClientMetadataUrl,
  validateOAuthPrivateKeyJwt,
  validateOAuthCrossAppAccess,
  selectClientMetadataUrl,
  configuredClientMetadata,
  addAuthorizationParams,
  addConfiguredScope,
  type McpOAuthConfig,
} from "./mcp-oauth-config.ts";
export {
  validateOAuthClientMetadataUrl,
  validateOAuthPrivateKeyJwt,
  validateOAuthCrossAppAccess,
  issuersMatch,
  loopbackRedirectsMatch,
  type McpOAuthConfig,
} from "./mcp-oauth-config.ts";
import {
  canUseStoredClient,
  hasStoredIssuerMismatch,
  storedClientInformation,
  clientRegistration,
  storedTokenInformation,
  toStoredTokens,
} from "./mcp-oauth-registration.ts";

/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>;
  onDiscoveryState?: (state: OAuthDiscoveryState) => void;
}

interface McpOAuthProviderOptions {
  serverName: string;
  serverUrl: string;
  config: McpOAuthConfig;
  callbacks: McpOAuthCallbacks;
  storageOptions?: AuthStorageOptions;
  runtimeSignal?: AbortSignal | undefined;
  initialState?: string;
}

/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /**
   * Callback URL captured at construction, including the port bound at that
   * moment. Constructing a provider is only valid after reserveCallback() has
   * bound the shared callback server, so the snapshot matches the port the
   * browser will actually be redirected to; later port changes do not rebind
   * an existing provider.
   */
  private readonly redirectUrlSnapshot: string | undefined;
  readonly clientMetadataUrl?: string;
  private readonly controller = new AbortController();
  readonly lifetimeSignal: AbortSignal;
  private readonly requestSignals = new AsyncLocalStorage<AbortSignal | undefined>();
  private flowAuthorizationServerUrl: string | undefined;
  private flowResourceUrl: string | undefined;
  private flowClientInfo: StoredClientInfo | undefined;
  private flowCodeVerifier: string | undefined;
  private flowDiscoveryState: OAuthDiscoveryState | undefined;
  private flowIssuerMismatch = false;
  private flowState: string | undefined;
  private lastTokenGrantType: string | undefined;
  private readonly tokenCache = new ProviderTokenCache();

  private readonly identity: AuthIdentity;
  private readonly config: McpOAuthConfig;
  private readonly callbacks: McpOAuthCallbacks;
  private readonly storageOptions: AuthStorageOptions;

  constructor(options: McpOAuthProviderOptions) {
    const {
      serverName,
      serverUrl,
      config,
      callbacks,
      storageOptions = {},
      runtimeSignal,
      initialState,
    } = options;
    this.identity = { serverName, serverUrl };
    this.config = config;
    this.callbacks = callbacks;
    this.storageOptions = storageOptions;
    validateOAuthClientMetadataUrl(config.clientMetadataUrl);
    validateOAuthPrivateKeyJwt(config);
    validateOAuthCrossAppAccess(config);
    this.lifetimeSignal =
      combineAbortSignals(runtimeSignal, this.controller.signal) ?? this.controller.signal;
    this.flowState = initialState;
    this.redirectUrlSnapshot = isNonInteractiveOAuth(config)
      ? undefined
      : (config.redirectUri ??
        `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`);
    const metadataUrl = selectClientMetadataUrl(config, this.redirectUrl);
    if (metadataUrl !== undefined) {
      this.clientMetadataUrl = metadataUrl;
    }
  }

  private get isNonInteractive(): boolean {
    return isNonInteractiveOAuth(this.config);
  }

  private get discoveredIssuer(): string | undefined {
    return (
      this.flowDiscoveryState?.authorizationServerMetadata?.issuer ??
      this.flowDiscoveryState?.authorizationServerUrl
    );
  }

  get signal(): AbortSignal {
    return (
      combineAbortSignals(this.lifetimeSignal, this.requestSignals.getStore()) ??
      this.lifetimeSignal
    );
  }

  runWithSignal<T>(signal: AbortSignal | undefined, operation: () => T): T {
    this.lifetimeSignal.throwIfAborted();
    return this.requestSignals.run(
      combineAbortSignals(this.requestSignals.getStore(), signal),
      operation,
    );
  }

  runWithIsolatedSignal<T>(signal: AbortSignal | undefined, operation: () => T): T {
    this.lifetimeSignal.throwIfAborted();
    return this.requestSignals.run(signal, operation);
  }

  get lastObservedTokenSnapshot(): TokenSnapshot | undefined {
    return this.tokenCache.lastObserved;
  }

  get currentCachedTokens(): StoredTokens | undefined {
    return this.tokenCache.currentCachedTokens;
  }

  invalidateTokenCache(): void {
    this.tokenCache.invalidate();
  }

  async reloadTokensFromStorage(): Promise<StoredTokens | undefined> {
    return await this.tokenCache.reload(this.identity, this.storageOptions);
  }

  deactivate(): void {
    this.controller.abort(new Error("OAuth flow is no longer active"));
    this.requestSignals.disable();
  }

  private assertStoredIssuerBindings(
    entry: AuthEntry | undefined,
    issuer: string | undefined,
  ): void {
    if (this.flowIssuerMismatch || hasStoredIssuerMismatch(entry, issuer)) {
      this.flowIssuerMismatch = true;
      throw new Error(
        `OAuth authorization server issuer changed for ${this.identity.serverName}; clear credentials before authenticating again`,
      );
    }
  }

  private throwIfInactive(): void {
    this.signal.throwIfAborted();
  }

  /**
   * The redirect URL for OAuth callbacks.
   * This must match the redirect_uri in client metadata.
   */
  get redirectUrl(): string | undefined {
    return this.redirectUrlSnapshot;
  }

  /**
   * Client metadata for dynamic registration.
   * Describes this client to the OAuth authorization server.
   */
  get clientMetadata(): OAuthClientMetadata {
    return configuredClientMetadata(this.config, this.redirectUrl);
  }

  /**
   * Get client information (for pre-registered or dynamically registered clients).
   * Returns undefined if no client info exists or if the server URL has changed.
   */
  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    this.throwIfInactive();
    const issuer = context?.issuer ?? this.discoveredIssuer;
    const stored = await getAuthForUrl(this.identity, this.storageOptions);
    this.throwIfInactive();
    this.assertStoredIssuerBindings(stored, issuer);
    // Rejected discovery must not become the runtime's issuer binding.
    if (this.flowDiscoveryState) {
      this.callbacks.onDiscoveryState?.(this.flowDiscoveryState);
    }

    // Check config first (pre-registered client). Store only its issuer binding.
    // The configured secret stays in config and never enters the credential store.
    if (this.config.clientId !== undefined && this.config.clientId !== "") {
      return await this.configuredClientInformation(this.config.clientId, issuer, stored);
    }

    return await this.savedClientInformation(stored, issuer);
  }

  private async savedClientInformation(
    stored: AuthEntry | undefined,
    issuer: string | undefined,
  ): Promise<StoredOAuthClientInformation | undefined> {
    // Keep client registration associated with this in-flight flow even if
    // another runtime writes the shared persistent entry for the same name.
    const clientInfo = this.flowClientInfo ?? stored?.clientInfo;
    if (clientInfo) {
      if (!canUseStoredClient(clientInfo, this.config, issuer)) {
        return undefined;
      }
      if (issuer !== undefined && issuer !== "" && clientInfo.issuer === undefined) {
        clientInfo.issuer = issuer;
        this.flowClientInfo = clientInfo;
        await updateClientInfo(this.identity, clientInfo, this.storageOptions);
      }
      // Return all registration metadata and the local issuer extension.
      // Keep the SDK's view and the stored issuer binding consistent.
      return storedClientInformation(clientInfo);
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined;
  }

  private async configuredClientInformation(
    clientId: string,
    issuer: string | undefined,
    stored: AuthEntry | undefined,
  ): Promise<StoredOAuthClientInformation> {
    await this.bindConfiguredClient(clientId, issuer, stored);
    const clientSecret =
      this.config.clientSecret?.startsWith("!") === true
        ? await resolveCommandSecret(
            this.config.clientSecret,
            `MCP server "${this.identity.serverName}" OAuth clientSecret`,
            this.signal,
          )
        : this.config.clientSecret;
    this.throwIfInactive();
    return {
      client_id: clientId,
      client_secret: clientSecret,
      ...(issuer !== undefined ? { issuer } : {}),
    };
  }

  private async bindConfiguredClient(
    clientId: string,
    issuer: string | undefined,
    stored: AuthEntry | undefined,
  ): Promise<void> {
    const storedClient = stored?.clientInfo?.clientId === clientId ? stored.clientInfo : undefined;
    if (
      issuer !== undefined &&
      issuer !== "" &&
      (storedClient?.issuer !== issuer || storedClient.configPreRegistered !== true)
    ) {
      await updateClientInfo(
        this.identity,
        { clientId: clientId, issuer, configPreRegistered: true },
        this.storageOptions,
      );
    }
  }

  /**
   * Save client information from dynamic registration.
   */
  async saveClientInformation(
    info: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    this.throwIfInactive();
    const issuer = context?.issuer ?? this.discoveredIssuer ?? info.issuer;
    if (
      this.config.clientId !== undefined &&
      this.config.clientId !== "" &&
      info.client_id === this.config.clientId
    ) {
      await updateClientInfo(
        this.identity,
        {
          clientId: info.client_id,
          ...(issuer !== undefined ? { issuer } : {}),
          configPreRegistered: true,
        },
        this.storageOptions,
      );
      return;
    }

    const clientInfo = clientRegistration(info, {
      issuer,
      redirectUrl: this.redirectUrl,
      clientMetadataUrl: this.clientMetadataUrl,
      documentSupported:
        this.flowDiscoveryState?.authorizationServerMetadata
          ?.client_id_metadata_document_supported === true,
    });
    this.flowClientInfo = clientInfo;
    await updateClientInfo(this.identity, clientInfo, this.storageOptions);
  }

  private readCachedTokens(
    context: OAuthClientInformationContext | undefined,
    issuer: string | undefined,
  ): StoredTokens | undefined {
    return context === undefined && issuer === undefined
      ? this.tokenCache.getFresh(this.identity)
      : undefined;
  }

  /**
   * Get stored OAuth tokens.
   * Returns undefined if no tokens exist or if the server URL has changed.
   */
  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    // Legacy cancellation notifications still need their stored bearer token
    // after the request signal aborts. Only provider shutdown ends this read.
    this.lifetimeSignal.throwIfAborted();
    const issuer = context?.issuer ?? this.discoveredIssuer;
    const cached = this.readCachedTokens(context, issuer);
    if (cached) {
      await Promise.resolve();
      this.lifetimeSignal.throwIfAborted();
      return storedTokenInformation(cached);
    }
    // Use getAuthForUrl to validate tokens are for the current server URL.
    const entry = await getAuthForUrl(this.identity, this.storageOptions);
    this.lifetimeSignal.throwIfAborted();
    if (!entry?.tokens) {
      this.tokenCache.clearAll();
      return undefined;
    }
    this.assertStoredIssuerBindings(entry, issuer);
    if (issuer !== undefined && issuer !== "" && entry.tokens.issuer === undefined) {
      entry.tokens.issuer = issuer;
      await updateTokens(this.identity, entry.tokens, this.storageOptions);
    }
    this.tokenCache.record(this.identity, entry.tokens, { pin: context !== undefined });
    return storedTokenInformation(entry.tokens);
  }

  private clearDiscoveryState(): void {
    this.flowDiscoveryState = undefined;
    this.flowAuthorizationServerUrl = undefined;
    this.flowResourceUrl = undefined;
  }

  /**
   * Save OAuth tokens.
   */
  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const grantType = this.lastTokenGrantType;
    this.lastTokenGrantType = undefined;
    const issuer = context?.issuer ?? this.discoveredIssuer ?? tokens.issuer;
    const storedTokens = toStoredTokens(tokens, issuer);
    const preserveOnRefresh =
      grantType === "refresh_token" ||
      (grantType === undefined && !this.isNonInteractive && this.flowState === undefined);
    this.throwIfInactive();
    const saved = await updateTokens(this.identity, storedTokens, this.storageOptions, {
      preserveOnRefresh,
    });
    this.tokenCache.record(this.identity, saved, { clearPin: grantType !== undefined });
    // Discovery must survive the browser redirect so the callback can verify
    // the authorization server that minted the code. Once token issuance
    // succeeds, clear it so a later 401 re-reads PRM and can observe an
    // authorization-server migration.
    this.clearDiscoveryState();
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
      throw new Error("redirectToAuthorization is not used for noninteractive OAuth flows");
    }
    // No flow-local state means we're on the post-refresh authorize fallback.
    this.throwIfInactive();
    if (this.flowState === undefined || this.flowState === "") {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.identity.serverName}`,
      );
    }
    // URL is passed to callback, not logged (may contain sensitive params)
    await this.callbacks.onRedirect(
      addAuthorizationParams(authorizationUrl, this.config.authorizationParams),
    );
  }

  /**
   * Save the PKCE code verifier.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.throwIfInactive();
    this.flowCodeVerifier = codeVerifier;
  }

  /**
   * Get the stored PKCE code verifier.
   * @throws Error if no code verifier is stored
   */
  async codeVerifier(): Promise<string> {
    if (this.isNonInteractive) {
      throw new Error("codeVerifier is not used for noninteractive OAuth flows");
    }
    this.throwIfInactive();
    if (this.flowCodeVerifier === undefined || this.flowCodeVerifier === "") {
      throw new Error(`No code verifier saved for MCP server: ${this.identity.serverName}`);
    }
    return this.flowCodeVerifier;
  }

  /**
   * Keep discovery with the in-flight PKCE verifier. The callback leg uses it
   * to validate the authorization response issuer before token exchange.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.throwIfInactive();
    this.flowDiscoveryState = structuredClone(state);
  }

  // Native auth calls this on every attempt, before stored issuer checks and resource selection.
  saveAuthorizationServerUrl(issuer: string): void {
    this.throwIfInactive();
    this.flowAuthorizationServerUrl = issuer;
    this.flowResourceUrl = undefined;
  }

  saveResourceUrl(resource: string): void {
    this.throwIfInactive();
    this.flowResourceUrl = resource;
  }

  readonly fetch: FetchLike = (input, init) =>
    fetch(input, {
      ...init,
      signal: combineAbortSignals(init?.signal ?? undefined, this.signal) ?? this.signal,
    });

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.throwIfInactive();
    return this.flowDiscoveryState ? structuredClone(this.flowDiscoveryState) : undefined;
  }

  /**
   * Save the OAuth state parameter for CSRF protection.
   */
  async saveState(state: string): Promise<void> {
    this.throwIfInactive();
    this.flowState = state;
  }

  /**
   * Get the stored OAuth state parameter.
   * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
   */
  async state(): Promise<string> {
    if (this.isNonInteractive) {
      throw new Error("state is not used for noninteractive OAuth flows");
    }
    this.throwIfInactive();
    if (this.flowState === undefined || this.flowState === "") {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.identity.serverName}`,
      );
    }
    return this.flowState;
  }

  /**
   * Invalidate credentials when authentication fails.
   * Clears tokens, client info, or all credentials based on the type.
   */
  async invalidateCredentials(
    type: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    this.throwIfInactive();
    switch (type) {
      case "all":
        this.flowClientInfo = undefined;
        this.flowCodeVerifier = undefined;
        this.clearDiscoveryState();
        this.flowIssuerMismatch = false;
        this.flowState = undefined;
        this.tokenCache.clearAll();
        await clearAllCredentials(this.identity, this.storageOptions);
        break;
      case "client":
        this.flowClientInfo = undefined;
        await clearClientInfo(this.identity, this.storageOptions);
        break;
      case "tokens": {
        const target = this.tokenCache.takeInvalidationTarget();
        if (target) {
          await clearTokensIfMatching(this.identity, target, this.storageOptions);
        } else {
          await clearTokens(this.identity, this.storageOptions);
        }
        break;
      }
      case "verifier":
        await clearCodeVerifier(this.identity, this.storageOptions);
        break;
      case "discovery":
        this.clearDiscoveryState();
        break;
    }
  }

  /**
   * Adds configured scope and client authentication to native token requests.
   */
  addClientAuthentication: AddClientAuthentication = async (headers, params, url, metadata) => {
    this.throwIfInactive();
    this.lastTokenGrantType = params.get("grant_type") ?? undefined;
    addConfiguredScope(params, this.config);
    const clientInfo = await this.clientInformation(
      this.config.privateKeyJwt && metadata?.issuer !== undefined && metadata.issuer !== ""
        ? { issuer: metadata.issuer }
        : undefined,
    );
    this.throwIfInactive();
    if (!clientInfo) {
      return;
    }
    await applyTokenClientAuthentication(
      this.config.privateKeyJwt,
      clientInfo,
      () => this.throwIfInactive(),
      this.signal,
    )(headers, params, url, metadata);
  };

  prepareTokenRequest(scope?: string): URLSearchParams | Promise<URLSearchParams> | undefined {
    const requestedScope = scope ?? this.config.scope;
    if (this.config.crossAppAccess) {
      return prepareCrossAppTokenParams(
        this.config.crossAppAccess,
        {
          audience: this.flowAuthorizationServerUrl,
          resource: this.flowResourceUrl,
          scope: requestedScope,
          signal: this.signal,
        },
        this.fetch,
        () => this.throwIfInactive(),
      );
    }
    return this.isNonInteractive ? clientCredentialsTokenParams(requestedScope) : undefined;
  }
}

export {
  DEFAULT_OAUTH_CALLBACK_PORT,
  DEFAULT_OAUTH_CALLBACK_PATH,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  setOAuthCallbackPath,
  setOAuthCallbackPort,
} from "./mcp-oauth-callback-config.ts";
