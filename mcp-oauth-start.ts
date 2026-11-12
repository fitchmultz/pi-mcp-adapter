import {
  auth as runSdkAuth,
  UnauthorizedError,
  computeScopeUnion,
  isStrictScopeSuperset,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import type { McpOAuthConfig } from "./mcp-oauth-config.ts";
import { ensureCallbackServer, releaseCallbackServer } from "./mcp-callback-server.ts";
import {
  getAuthForUrl,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  clearOAuthState,
  getAuthBaseDir,
  type AuthEntry,
  type AuthStorageOptions,
} from "./mcp-auth.ts";
import { isServerDisabled, isNonInteractiveOAuth, type ServerEntry } from "./types.ts";
import { formatTerminalError } from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import {
  clearPendingAuth,
  getPendingAuthKey,
  getRuntimeState,
  useRuntime,
  type AuthDiscovery,
  type AuthenticateOptions,
  type CallbackIssuer,
  type McpOAuthRuntime,
  type PendingAuth,
  type OAuthRequest,
} from "./mcp-oauth-runtime.ts";
import { getOAuthRequest, bindOAuthRequestIssuer } from "./mcp-oauth-request.ts";
import {
  extractOAuthConfig,
  probeAuthDiscovery,
  parseOAuthRedirectUri,
} from "./mcp-oauth-discovery.ts";
import { matchesStoredRedirect } from "./mcp-oauth-registration.ts";
import { validateCallbackIssuer } from "./mcp-oauth-response.ts";

const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
type StartContext = {
  serverName: string;
  serverUrl: string;
  definition: ServerEntry | undefined;
  config: McpOAuthConfig;
  runtime: McpOAuthRuntime;
  authStorageOptions: AuthStorageOptions;
  signal: AbortSignal;
  generation: number;
};

function applyConfiguredScope(discovery: AuthDiscovery, config: McpOAuthConfig): AuthDiscovery {
  return {
    ...discovery,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    ...(config.skipIssuerMetadataValidation !== undefined
      ? { skipIssuerMetadataValidation: config.skipIssuerMetadataValidation }
      : {}),
  };
}

function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resetIncompleteRegistration(
  context: StartContext,
  storedAuth?: AuthEntry,
): Promise<void> {
  if (
    context.config.crossAppAccess ||
    !storedAuth?.clientInfo ||
    storedAuth.tokens ||
    (context.config.clientId ?? "") !== ""
  ) {
    return;
  }
  clearClientInfo(context.serverName, context.authStorageOptions);
  clearCodeVerifier(context.serverName, context.authStorageOptions);
  clearOAuthState(context.serverName, context.authStorageOptions);
  await Promise.resolve();
}

async function startNonInteractive(context: StartContext): Promise<{ authorizationUrl: string }> {
  const { serverName, serverUrl, config, authStorageOptions, signal } = context;
  const storedAuth = await Promise.resolve(
    getAuthForUrl(serverName, serverUrl, authStorageOptions),
  );
  await resetIncompleteRegistration(context, storedAuth);
  const authProvider = new McpOAuthProvider({
    serverName,
    serverUrl,
    config,
    callbacks: {
      onRedirect: async () => {
        throw new Error("Browser redirect is not used for noninteractive OAuth flows");
      },
    },
    storageOptions: authStorageOptions,
    runtimeSignal: signal,
  });
  try {
    const discovery = applyConfiguredScope(
      await probeAuthDiscovery(serverUrl, context.definition, signal),
      config,
    );
    throwIfAborted(signal);
    const result = await abortable(
      runSdkAuth(authProvider, { serverUrl, ...discovery, fetchFn: authProvider.fetch }),
      signal,
    );
    throwIfAborted(signal);
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize");
    }
    return { authorizationUrl: "" };
  } finally {
    authProvider.deactivate();
  }
}

function issuerBinding(context: StartContext) {
  const callbackIssuer: CallbackIssuer = {};
  return {
    callbackIssuer,
    validate: (response: { iss?: string; error?: string }): void =>
      validateCallbackIssuer(context.serverName, callbackIssuer, response),
    onDiscoveryState: (state: OAuthDiscoveryState): void => {
      callbackIssuer.expectedIssuer = state.authorizationServerMetadata?.issuer;
      callbackIssuer.fallbackIssuer = state.authorizationServerUrl;
      callbackIssuer.issParameterSupported =
        state.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true;
      bindOAuthRequestIssuer(
        {
          serverName: context.serverName,
          serverUrl: context.serverUrl,
          storageBase: getAuthBaseDir(context.authStorageOptions),
          runtime: context.runtime,
        },
        callbackIssuer.expectedIssuer ?? state.authorizationServerUrl,
      );
    },
  };
}
type IssuerBinding = ReturnType<typeof issuerBinding>;

async function reserveCallback(
  context: StartContext,
  oauthState: string,
  binding: IssuerBinding,
  redirectCallback: ReturnType<typeof parseOAuthRedirectUri> | undefined,
): Promise<void> {
  const { config, serverName, authStorageOptions, signal } = context;
  try {
    await ensureCallbackServer({
      strictPort: (config.clientId ?? "") !== "" || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
      validate: binding.validate,
      ...(redirectCallback
        ? {
            port: redirectCallback.port,
            callbackHost: redirectCallback.callbackHost,
            callbackPath: redirectCallback.callbackPath,
          }
        : {}),
    });
    throwIfAborted(signal);
  } catch (error) {
    releaseCallbackServer(oauthState);
    try {
      clearOAuthState(serverName, authStorageOptions);
      await Promise.resolve();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

function challengeDiscovery(
  discovery: AuthDiscovery,
  request: OAuthRequest | undefined,
  storedAuth: AuthEntry | undefined,
): AuthDiscovery {
  if (!request?.challenge) {
    return discovery;
  }
  const scope = computeScopeUnion(
    discovery.scope,
    request.requestedScope,
    storedAuth?.tokens?.scope,
    request.challenge.requiredScope,
  );
  return {
    ...discovery,
    ...(scope !== undefined && scope !== "" ? { scope } : {}),
    ...(request.challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: request.challenge.resourceMetadataUrl }
      : {}),
  };
}

function createInteractiveFlow(
  context: StartContext,
  binding: IssuerBinding,
  request: OAuthRequest | undefined,
  initial: { discovery: AuthDiscovery; oauthState: string },
) {
  let discovery = initial.discovery;
  let capturedUrl: URL | undefined;
  const flowConfig = {
    ...context.config,
    ...(request?.challenge && (discovery.scope ?? "") !== "" ? { scope: discovery.scope } : {}),
  };
  const authProvider = new McpOAuthProvider({
    serverName: context.serverName,
    serverUrl: context.serverUrl,
    config: flowConfig,
    callbacks: {
      onRedirect: (url) => {
        capturedUrl = url;
        const requestedScope = url.searchParams.get("scope") ?? undefined;
        if (requestedScope !== undefined && requestedScope !== "") {
          discovery = { ...discovery, scope: requestedScope };
          if (request?.challenge) {
            flowConfig.scope = requestedScope;
          }
        }
        const current = getOAuthRequest(
          context.serverName,
          context.serverUrl,
          getAuthBaseDir(context.authStorageOptions),
          context.runtime,
        );
        const scope = computeScopeUnion(current?.requestedScope, requestedScope);
        if (current && scope !== undefined && scope !== "") {
          current.requestedScope = scope;
        }
      },
      onDiscoveryState: binding.onDiscoveryState,
    },
    storageOptions: context.authStorageOptions,
    runtimeSignal: context.runtime.signal,
    initialState: initial.oauthState,
  });
  return {
    authProvider,
    get discovery() {
      return discovery;
    },
    get capturedUrl() {
      return capturedUrl;
    },
  };
}
type InteractiveFlow = ReturnType<typeof createInteractiveFlow>;

async function recoverRedirectRegistration(
  context: StartContext,
  storedAuth: AuthEntry | undefined,
  redirectUrl: string | undefined,
): Promise<void> {
  if (!storedAuth?.clientInfo || (context.config.clientId ?? "") !== "") {
    return;
  }
  if (!storedAuth.tokens) {
    await resetIncompleteRegistration(context, storedAuth);
    return;
  }
  if (matchesStoredRedirect(storedAuth.clientInfo, redirectUrl ?? "")) {
    return;
  }
  clearClientInfo(context.serverName, context.authStorageOptions);
  clearTokens(context.serverName, context.authStorageOptions);
  clearCodeVerifier(context.serverName, context.authStorageOptions);
  clearOAuthState(context.serverName, context.authStorageOptions);
  await Promise.resolve();
}

async function authorizeInteractive(
  context: StartContext,
  flow: InteractiveFlow,
  request: OAuthRequest | undefined,
  storedAuth: AuthEntry | undefined,
): Promise<boolean> {
  const result = await abortable(
    runSdkAuth(flow.authProvider, {
      serverUrl: context.serverUrl,
      ...flow.discovery,
      ...(request?.challenge
        ? {
            forceReauthorization: isStrictScopeSuperset(
              flow.discovery.scope,
              storedAuth?.tokens?.scope,
            ),
          }
        : {}),
    }),
    context.signal,
  );
  throwIfAborted(context.signal);
  return result === "AUTHORIZED";
}

async function startInteractive(
  context: StartContext,
  request: OAuthRequest | undefined,
): Promise<{ authorizationUrl: string }> {
  // Validate explicit redirects before allocating flow state.
  const redirectCallback =
    context.config.redirectUri !== undefined
      ? parseOAuthRedirectUri(context.config.redirectUri)
      : undefined;
  const oauthState = generateState();
  const binding = issuerBinding(context);
  // The callback reservation must precede provider construction: the provider
  // snapshots the bound callback port, and a provider built before the
  // reservation would register clients against a port nobody listens on.
  await reserveCallback(context, oauthState, binding, redirectCallback);
  let authProvider: McpOAuthProvider | undefined;
  try {
    const storedAuth = await Promise.resolve(
      getAuthForUrl(context.serverName, context.serverUrl, context.authStorageOptions),
    );
    const discovery = challengeDiscovery(
      applyConfiguredScope(
        await probeAuthDiscovery(context.serverUrl, context.definition, context.signal),
        context.config,
      ),
      request,
      storedAuth,
    );
    throwIfAborted(context.signal);
    const flow = createInteractiveFlow(context, binding, request, { discovery, oauthState });
    authProvider = flow.authProvider;
    await recoverRedirectRegistration(context, storedAuth, authProvider.redirectUrl);
    throwIfAborted(context.signal);
    if (await authorizeInteractive(context, flow, request, storedAuth)) {
      authProvider.deactivate();
      releaseCallbackServer(oauthState);
      clearOAuthState(context.serverName, context.authStorageOptions);
      await Promise.resolve();
      return { authorizationUrl: "" };
    }
    if (!flow.capturedUrl) {
      throw new UnauthorizedError("OAuth authorization URL was not provided");
    }
    const authorizationUrl = flow.capturedUrl.toString();
    await setPendingAuth(
      context,
      {
        serverName: context.serverName,
        authProvider,
        serverUrl: context.serverUrl,
        authorizationUrl,
        discovery: flow.discovery,
        callbackIssuer: { ...binding.callbackIssuer },
        authStorageOptions: context.authStorageOptions,
        ...(request ? { request } : {}),
      },
      oauthState,
    );
    return { authorizationUrl };
  } catch (error) {
    authProvider?.deactivate();
    try {
      await clearPendingAuth(
        context.runtime,
        context.serverName,
        oauthState,
        context.authStorageOptions,
      );
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** Start native OAuth, reserving a browser callback only for interactive flows. */
export async function startAuth(
  serverName: string,
  serverUrl: string,
  definition: ServerEntry | undefined,
  options: AuthenticateOptions,
): Promise<{ authorizationUrl: string }> {
  if (isServerDisabled(definition)) {
    throw new Error(`MCP server "${serverName}" is disabled`);
  }
  const runtime = useRuntime(options.runtime);
  const state = getRuntimeState(runtime);
  const context: StartContext = {
    serverName,
    serverUrl,
    definition,
    runtime,
    config: definition ? extractOAuthConfig(definition) : {},
    authStorageOptions: options.authStorageOptions ?? {},
    signal: combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal,
    generation: state.generation,
  };
  throwIfAborted(context.signal);
  if (isNonInteractiveOAuth(context.config)) {
    return startNonInteractive(context);
  }
  const request = getOAuthRequest(
    serverName,
    serverUrl,
    getAuthBaseDir(context.authStorageOptions),
    runtime,
  );
  const existing = state.pendingAuths.get(
    getPendingAuthKey(serverName, context.authStorageOptions),
  );
  if (existing?.serverUrl === serverUrl) {
    return { authorizationUrl: existing.authorizationUrl };
  }
  return startInteractive(context, request);
}

async function setPendingAuth(
  context: StartContext,
  pendingAuth: Omit<PendingAuth, "callbackState" | "cleanupTimer">,
  oauthState: string,
): Promise<void> {
  const { runtime, serverName, signal, generation } = context;
  const state = getRuntimeState(runtime);
  const key = getPendingAuthKey(serverName, pendingAuth.authStorageOptions);
  await clearPendingAuth(runtime, serverName, undefined, pendingAuth.authStorageOptions);
  throwIfAborted(signal);
  if (generation !== state.generation) {
    throw new Error("OAuth runtime stopped");
  }
  const cleanupTimer = setTimeout(() => {
    clearPendingAuth(runtime, serverName, oauthState, pendingAuth.authStorageOptions).catch(
      (error: unknown) => {
        console.error(`MCP Auth: Timed-out flow cleanup failed: ${formatTerminalError(error)}`);
      },
    );
  }, MANUAL_AUTH_TIMEOUT_MS);
  cleanupTimer.unref();
  state.pendingAuths.set(key, { ...pendingAuth, callbackState: oauthState, cleanupTimer });
}
