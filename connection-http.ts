import type {
  AuthProvider,
  FetchLike,
  OAuthClientProvider,
  Transport,
} from "@modelcontextprotocol/client";
import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ManagedClient } from "./connection-runtime.ts";
import type { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { recordOAuthDiscovery, supportsOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { getAuthBaseDir, type AuthStorageOptions } from "./mcp-auth.ts";
import {
  coordinateOAuthRefresh,
  recordProactiveRefreshOutcome,
  shouldAttemptProactiveRefresh,
} from "./mcp-oauth-refresh.ts";
import { isAbortError } from "./runtime-owner.ts";
import { isServerDisabled, isNonInteractiveOAuth, type ServerDefinition } from "./types.ts";
import {
  resolveServerUrl,
  resolveCommandSecretsRecord,
  resolveCommandSecret,
  resolveBearerToken,
} from "./utils.ts";
import type { ConnectionLifecycle } from "./connection-lifecycle.ts";
import { ownOAuthProvider } from "./connection-oauth-ownership.ts";

type HttpConnectionOptions = {
  runtime: typeof ConnectionRuntime;
  definition: ServerDefinition;
  serverName: string;
  client: ManagedClient;
  legacySse: boolean;
  implicitOAuth: boolean;
  onAuthChallenge: (error: Error) => void;
  authStorageOptions: AuthStorageOptions;
  oauthRuntime: McpOAuthRuntime | undefined;
  lifecycle: ConnectionLifecycle;
};

type InteractiveAuthProvider = AuthProvider &
  Pick<McpOAuthProvider, "redirectUrl" | "clientMetadata">;

function isCommandSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("!") && !value.startsWith("!!");
}

function resolveHttpRequestInit(
  definition: ServerDefinition,
  serverName: string,
): Pick<RequestInit, "headers"> | undefined {
  const hasCommandHeader = Object.values(definition.headers ?? {}).some(isCommandSecret);
  const headers =
    resolveCommandSecretsRecord(
      definition.headers,
      (key) => `MCP server "${serverName}" HTTP header "${key}"`,
    ) ?? {};
  const commandBearer = isCommandSecret(definition.bearerToken)
    ? definition.bearerToken
    : undefined;
  const authorization = resolveHttpAuthorization(definition, serverName, commandBearer);
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  }
  if (hasCommandHeader || commandBearer !== undefined) {
    try {
      // Native Headers validates command output without exposing its contents.
      const validated = new Headers(headers);
      return Object.keys(headers).length > 0 ? { headers: validated } : undefined;
    } catch {
      throw new Error(
        `Failed to resolve MCP server "${serverName}" HTTP command secret: command returned an invalid header value`,
      );
    }
  }
  return Object.keys(headers).length > 0 ? { headers } : undefined;
}

function resolveHttpAuthorization(
  definition: ServerDefinition,
  serverName: string,
  commandBearer: string | undefined,
): string | undefined {
  if (definition.auth !== "bearer") {
    return undefined;
  }
  const token =
    commandBearer !== undefined
      ? resolveCommandSecret(commandBearer, `MCP server "${serverName}" HTTP bearer token`)
      : resolveBearerToken(definition);
  return token !== undefined && token.length > 0 ? `Bearer ${token}` : undefined;
}

function extractBearerToken(
  input: Parameters<FetchLike>[0],
  init: RequestInit | undefined,
): string | undefined {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (headers === undefined) {
    return undefined;
  }
  const authorization = new Headers(headers).get("authorization");
  if (authorization === null || !/^Bearer\s+/i.test(authorization)) {
    return undefined;
  }
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 ? token : undefined;
}

class HttpConnection {
  private readonly generation: number;
  private readonly serverUrl: string;
  private readonly storageBase: string;
  private issuer: string | undefined;
  private lastResourceMetadataUrl: URL | undefined;
  private readonly responseTokens = new WeakMap<Response, string>();
  private transportClosed = false;
  private readonly transport: Transport;
  private readonly provider: McpOAuthProvider | undefined;

  private readonly options: HttpConnectionOptions;

  constructor(options: HttpConnectionOptions) {
    this.options = options;
    this.generation = options.lifecycle.closeGenerations.get(options.serverName) ?? 0;
    // The caller's validated HTTP branch establishes the URL.
    this.serverUrl = resolveServerUrl(options.definition) ?? "";
    this.storageBase = getAuthBaseDir(options.authStorageOptions);
    const { runtime, definition, serverName, client, legacySse } = this.options;
    const requestInit = resolveHttpRequestInit(definition, serverName);
    const provider = this.createProvider();
    this.provider = provider;
    client.oauthProvider = provider;
    const transportAuth = this.transportAuth(provider);
    const transportOptions = {
      ...(requestInit !== undefined ? { requestInit } : {}),
      ...(transportAuth !== undefined ? { authProvider: transportAuth } : {}),
      skipIssuerMetadataValidation:
        definition.oauth !== false && definition.oauth?.skipIssuerMetadataValidation === true,
      fetch: this.createFetch(provider),
    };
    const url = new URL(this.serverUrl);
    if (legacySse) {
      // oxlint-disable-next-line typescript/no-deprecated -- QX-024: retain the native legacy SSE fallback.
      this.transport = new runtime.SSEClientTransport(url, transportOptions);
    } else {
      this.transport = new runtime.StreamableHTTPClientTransport(url, {
        ...transportOptions,
        reconnectionScheduler: (reconnect, delay) => {
          const timer = setTimeout(() => {
            if (!this.transportClosed) {
              reconnect();
            }
          }, delay);
          timer.unref();
          return () => clearTimeout(timer);
        },
        ...(supportsOAuth(definition) && !isNonInteractiveOAuth(definition.oauth)
          ? { onInsufficientScope: "throw" as const }
          : {}),
      });
    }
  }

  private active(): boolean {
    const { lifecycle, oauthRuntime, serverName } = this.options;
    return (
      !lifecycle.stopped &&
      lifecycle.runtimeSignal?.aborted !== true &&
      oauthRuntime?.signal.aborted !== true &&
      (lifecycle.closeGenerations.get(serverName) ?? 0) === this.generation
    );
  }

  private createProvider(): McpOAuthProvider | undefined {
    const { runtime, definition, serverName, implicitOAuth } = this.options;
    if (!supportsOAuth(definition) || !(definition.auth === "oauth" || implicitOAuth)) {
      return undefined;
    }
    return new runtime.McpOAuthProvider({
      serverName,
      serverUrl: this.serverUrl,
      config: runtime.extractOAuthConfig(definition),
      callbacks: {
        onRedirect: async () => {
          // startAuth captures the URL; connection setup must not prompt or log it.
        },
        onDiscoveryState: (state) => {
          this.issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
          if (state.resourceMetadataUrl !== undefined && state.resourceMetadataUrl !== "") {
            try {
              this.lastResourceMetadataUrl = new URL(state.resourceMetadataUrl);
            } catch {
              // Ignore malformed cached metadata URLs.
            }
          }
          // Without an OAuth runtime this connection keeps no OAuth bookkeeping;
          // hosts that enable OAuth always attach one before connecting.
          if (this.active() && this.options.oauthRuntime !== undefined) {
            runtime.bindOAuthRequestIssuer(
              {
                serverName,
                serverUrl: this.serverUrl,
                storageBase: this.storageBase,
                runtime: this.options.oauthRuntime,
              },
              this.issuer,
            );
          }
        },
      },
      storageOptions: this.options.authStorageOptions,
      runtimeSignal: this.options.oauthRuntime?.signal,
    });
  }

  private createFetch(provider: McpOAuthProvider | undefined): FetchLike {
    const { client, runtime } = this.options;
    return (input, init) =>
      client.ownNative(async () => {
        if (this.transportClosed) {
          throw new Error("MCP transport is closed");
        }
        const bearerToken = provider ? extractBearerToken(input, init) : undefined;
        const response = await runtime.trackToolTransportFailure(
          input,
          provider
            ? {
                ...init,
                signal: init?.signal
                  ? AbortSignal.any([init.signal, provider.lifetimeSignal])
                  : provider.signal,
              }
            : init,
        );
        if (bearerToken !== undefined) {
          this.responseTokens.set(response, bearerToken);
        }
        // Fetch resolves at headers. Keep actual auth/discovery body reads owned,
        // without treating the idle SSE stream as a perpetual request.
        for (const method of ["text", "json"] as const) {
          const read = response[method].bind(response);
          response[method] = () => client.ownNative(read);
        }
        return response;
      });
  }

  private runAuthRefresh(
    provider: McpOAuthProvider,
    owned: OAuthClientProvider,
    params: {
      serverUrl: URL;
      fetchFn: FetchLike;
      resourceMetadataUrl?: URL | undefined;
      scope?: string | undefined;
    },
    refreshSignal: AbortSignal,
  ): Promise<"AUTHORIZED" | "REDIRECT"> {
    const { definition, runtime } = this.options;
    return provider.runWithIsolatedSignal(refreshSignal, () =>
      runtime.auth(owned, {
        serverUrl: params.serverUrl,
        fetchFn: params.fetchFn,
        ...(params.resourceMetadataUrl !== undefined
          ? { resourceMetadataUrl: params.resourceMetadataUrl }
          : {}),
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
        skipIssuerMetadataValidation:
          definition.oauth !== false && definition.oauth?.skipIssuerMetadataValidation === true,
      }),
    );
  }

  private async refreshProactively(
    provider: McpOAuthProvider,
    owned: OAuthClientProvider,
    currentAccessToken: string,
  ): Promise<void> {
    const { serverName, runtime } = this.options;
    const identity = { serverName, serverUrl: this.serverUrl };
    const fetchFn = this.createFetch(provider);
    try {
      await coordinateOAuthRefresh({
        identity,
        provider,
        rejectedAccessToken: currentAccessToken,
        proactive: true,
        signal: provider.signal,
        isUnauthorizedError: (error) => error instanceof runtime.UnauthorizedError,
        runRefresh: (refreshSignal) =>
          this.runAuthRefresh(
            provider,
            owned,
            {
              serverUrl: new URL(this.serverUrl),
              fetchFn,
              resourceMetadataUrl: this.lastResourceMetadataUrl,
            },
            refreshSignal,
          ),
      });
    } catch (error) {
      if (isAbortError(error, provider.signal)) {
        throw error;
      }
      // Fall back to sending the current token so any server 401 supplies WWW-Authenticate metadata.
      recordProactiveRefreshOutcome(identity, "failed");
    }
  }

  private transportAuth(
    provider: McpOAuthProvider | undefined,
  ): InteractiveAuthProvider | OAuthClientProvider | undefined {
    if (!provider) {
      return undefined;
    }
    const { client, definition, runtime, serverName, oauthRuntime } = this.options;
    const owned = ownOAuthProvider(client, provider);
    if (isNonInteractiveOAuth(definition.oauth)) {
      return owned;
    }
    const identity = { serverName, serverUrl: this.serverUrl };
    // Own the entire native 401 auth promise, including PKCE between provider calls.
    // Noninteractive transports keep the native OAuthClientProvider 403 policy.
    return {
      get redirectUrl() {
        return provider.redirectUrl;
      },
      get clientMetadata() {
        return owned.clientMetadata;
      },
      token: () =>
        client.ownNative(async () => {
          const current = await owned.tokens();
          if (!current) {
            return;
          }
          if (shouldAttemptProactiveRefresh(identity, current)) {
            await this.refreshProactively(provider, owned, current.access_token);
            return (await owned.tokens())?.access_token;
          }
          return current.access_token;
        }),
      onUnauthorized: (context) =>
        client.ownNative(async () => {
          const { resourceMetadataUrl, scope } = runtime.extractWWWAuthenticateParams(
            context.response,
          );
          if (resourceMetadataUrl) {
            this.lastResourceMetadataUrl = resourceMetadataUrl;
          }
          if (this.active() && oauthRuntime !== undefined) {
            recordOAuthDiscovery(
              {
                serverName,
                serverUrl: this.serverUrl,
                storageBase: this.storageBase,
                runtime: oauthRuntime,
              },
              {
                ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
                ...(scope !== undefined && scope !== "" ? { scope } : {}),
              },
            );
          }
          const rejectedAccessToken = this.responseTokens.get(context.response);
          provider.invalidateTokenCache();
          const result = await coordinateOAuthRefresh({
            identity,
            provider,
            rejectedAccessToken,
            signal: provider.signal,
            isUnauthorizedError: (error) => error instanceof runtime.UnauthorizedError,
            runRefresh: (refreshSignal) =>
              this.runAuthRefresh(
                provider,
                owned,
                {
                  serverUrl: context.serverUrl,
                  fetchFn: context.fetchFn,
                  resourceMetadataUrl,
                  scope,
                },
                refreshSignal,
              ),
          });
          if (result !== "AUTHORIZED") {
            throw new runtime.UnauthorizedError();
          }
        }),
    };
  }

  private observeChallenge(): void {
    const { definition, runtime, serverName, oauthRuntime, onAuthChallenge } = this.options;
    if (!supportsOAuth(definition)) {
      return;
    }
    const previous = this.transport.onerror;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-010: native Transport exposes a callback, not EventTarget.
    this.transport.onerror = (error) => {
      previous?.(error);
      if (
        !this.active() ||
        isServerDisabled(definition) ||
        !supportsOAuth(definition) ||
        !runtime.isOAuthChallenge(error) ||
        oauthRuntime === undefined
      ) {
        return;
      }
      runtime.recordOAuthChallenge(
        {
          serverName,
          serverUrl: this.serverUrl,
          storageBase: this.storageBase,
          runtime: oauthRuntime,
        },
        error,
      );
      this.bindChallengeIssuer();
      onAuthChallenge(error);
    };
  }

  private bindChallengeIssuer(): void {
    const { runtime, serverName, oauthRuntime } = this.options;
    if (oauthRuntime !== undefined && this.issuer !== undefined && this.issuer.length > 0) {
      const request = runtime.getOAuthRequest(
        serverName,
        this.serverUrl,
        this.storageBase,
        oauthRuntime,
      );
      if (request && (request.issuer === undefined || request.issuer.length === 0)) {
        request.issuer = this.issuer;
      }
    }
  }

  create(): { transport: Transport; oauthProvider: boolean } {
    const { transport, provider } = this;
    const { runtime } = this.options;
    // First layer of transport-callback patching; the fixed order is http (here) →
    // tool-transport → mcp-trace → connection-handshake. Every wrapper must call the
    // previous handler, and none are ever restored; the SDK chains what it finds at connect.
    if (provider) {
      const send = transport.send.bind(transport);
      transport.send = (message, sendOptions) =>
        provider.runWithSignal(sendOptions?.requestSignal, () => send(message, sendOptions));
    }
    const close = transport.close.bind(transport);
    transport.close = () => {
      this.transportClosed = true;
      provider?.deactivate();
      return close();
    };
    this.observeChallenge();
    runtime.trackToolTransport(transport, true);
    return { transport, oauthProvider: provider !== undefined };
  }
}

export function createHttpConnection(options: HttpConnectionOptions): {
  transport: Transport;
  oauthProvider: boolean;
} {
  return new HttpConnection(options).create();
}
