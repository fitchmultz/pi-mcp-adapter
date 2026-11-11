/**
 * User-facing OAuth completion, browser authentication and credential removal.
 * The SDK owns the native authentication protocol.
 */
import {
  auth as runSdkAuth,
  UnauthorizedError,
  isStrictScopeSuperset,
} from "@modelcontextprotocol/client";
import open from "open";
import {
  waitForCallback,
  cancelPendingCallback,
  takeCallbackResult,
} from "./mcp-callback-server.ts";
import {
  getAuthForUrl,
  clearAllCredentials,
  getOAuthState,
  clearOAuthState,
  getAuthBaseDir,
  type AuthStorageOptions,
} from "./mcp-auth.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import {
  clearPendingAuth,
  getPendingAuthKey,
  getRuntimeState,
  useRuntime,
  pendingAuthState,
  type AuthStatus,
  type AuthenticateOptions,
  type PendingAuth,
  type McpOAuthRuntime,
} from "./mcp-oauth-runtime.ts";
import { getOAuthRequest } from "./mcp-oauth-request.ts";
import {
  validateCallbackIssuer,
  parseAuthorizationRedirectInput,
  type AuthorizationResponseInput,
  type AuthorizationCodeInput,
} from "./mcp-oauth-response.ts";
import { startAuth } from "./mcp-oauth-start.ts";

export { startAuth } from "./mcp-oauth-start.ts";
export { extractOAuthConfig } from "./mcp-oauth-discovery.ts";
export {
  getOAuthRequest,
  isOAuthChallenge,
  recordOAuthChallenge,
  bindOAuthRequestIssuer,
} from "./mcp-oauth-request.ts";
export {
  parseAuthorizationRedirectInput,
  type AuthorizationCodeInput,
} from "./mcp-oauth-response.ts";
export {
  createOAuthRuntime,
  hasPendingAuth,
  pendingAuthState,
  shutdownOAuth,
  supportsOAuth,
  useRuntime,
  type AuthStatus,
  type AuthenticateOptions,
  type McpOAuthRuntime,
} from "./mcp-oauth-runtime.ts";

/**
 * Complete OAuth authentication from pasted input or a captured browser callback.
 */
export async function completeAuthFromInput(
  serverName: string,
  input: string | undefined,
  options: AuthenticateOptions,
): Promise<AuthStatus> {
  const runtime = useRuntime(options.runtime);
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {};
  const signal = combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal;
  throwIfAborted(signal);
  const oauthState = pendingAuthState(runtime, serverName, fallbackAuthStorageOptions);
  throwIfAborted(signal);
  const parsed =
    input === undefined ? undefined : parseAuthorizationRedirectInput(input, oauthState);
  return completeAuth(serverName, parsed, options);
}

type CompletionContext = {
  runtime: McpOAuthRuntime;
  serverName: string;
  pendingAuth: PendingAuth;
  authStorageOptions: AuthStorageOptions;
  oauthState: string | undefined;
  signal: AbortSignal;
};

function completionContext(serverName: string, options: AuthenticateOptions): CompletionContext {
  const runtime = useRuntime(options.runtime);
  const state = getRuntimeState(runtime);
  const fallback = options.authStorageOptions ?? {};
  const signal = combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal;
  throwIfAborted(signal);
  const pendingAuth = state.pendingAuths.get(getPendingAuthKey(serverName, fallback));
  if (!pendingAuth) {
    throw new Error(
      `No pending OAuth flow for server: ${serverName}. Run auth-start for this server first.`,
    );
  }
  const oauthState = pendingAuth.callbackState;
  throwIfAborted(signal);
  return {
    runtime,
    serverName,
    pendingAuth,
    authStorageOptions: pendingAuth.authStorageOptions,
    oauthState,
    signal,
  };
}

function completionResponse(
  context: CompletionContext,
  authorizationCode?: string | AuthorizationResponseInput,
): AuthorizationResponseInput {
  const { oauthState, serverName } = context;
  const response =
    typeof authorizationCode === "string"
      ? { code: authorizationCode }
      : (authorizationCode ??
        (oauthState !== undefined && oauthState !== ""
          ? takeCallbackResult(oauthState)
          : undefined));
  if (!response) {
    throw new Error(
      `No OAuth callback received yet for ${serverName}. Finish authorization in the browser, then retry auth-complete. ` +
        'If the browser cannot reach this Pi session\'s callback, pass args: { redirectUrl: "FULL_REDIRECT_URL" } instead.',
    );
  }
  return response;
}

async function clearSatisfiedChallenge(context: CompletionContext): Promise<void> {
  const { pendingAuth, serverName, runtime, authStorageOptions } = context;
  const request = pendingAuth.request;
  if (!request) {
    return;
  }
  const requiredScope = request.challenge?.requiredScope;
  if (
    requiredScope === undefined ||
    requiredScope === "" ||
    request !==
      getOAuthRequest(
        serverName,
        pendingAuth.serverUrl,
        getAuthBaseDir(authStorageOptions),
        runtime,
      )
  ) {
    return;
  }
  const issuedScope = (
    await Promise.resolve(getAuthForUrl(serverName, pendingAuth.serverUrl, authStorageOptions))
  )?.tokens?.scope;
  if (issuedScope !== undefined && !isStrictScopeSuperset(requiredScope, issuedScope)) {
    delete request.challenge;
  }
}

async function issueAuthorizationCode(
  context: CompletionContext,
  response: AuthorizationCodeInput,
): Promise<void> {
  const { pendingAuth, signal } = context;
  const result = await abortable(
    runSdkAuth(pendingAuth.authProvider, {
      serverUrl: pendingAuth.serverUrl,
      authorizationCode: response.code,
      ...(response.iss !== undefined ? { iss: response.iss } : {}),
      ...pendingAuth.discovery,
    }),
    signal,
  );
  throwIfAborted(signal);
  if (result !== "AUTHORIZED") {
    throw new UnauthorizedError("Failed to authorize");
  }
  await clearSatisfiedChallenge(context);
}

async function cleanupFailedCompletion(
  context: CompletionContext,
  primary: unknown,
): Promise<void> {
  try {
    await clearPendingAuth(
      context.runtime,
      context.serverName,
      context.oauthState,
      context.authStorageOptions,
    );
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], "OAuth completion cleanup failed", {
        cause: cleanupError,
      });
    }
    throw cleanupError;
  }
}

/** Complete OAuth authentication with an explicit code or a captured callback. */
export async function completeAuth(
  serverName: string,
  authorizationCode: string | AuthorizationResponseInput | undefined,
  options: AuthenticateOptions,
): Promise<AuthStatus> {
  const context = completionContext(serverName, options);
  const response = completionResponse(context, authorizationCode);
  // RFC 9207: a server that advertises `iss` support but omits it keeps the flow open for a retry.
  let keepPendingForRetry =
    response.iss === undefined && context.pendingAuth.callbackIssuer.issParameterSupported === true;
  try {
    validateCallbackIssuer(serverName, context.pendingAuth.callbackIssuer, response);
    if ("error" in response) {
      keepPendingForRetry = true;
      throw new Error(
        (response.errorDescription ?? "") !== ""
          ? `${response.error}: ${response.errorDescription ?? ""}`
          : response.error,
      );
    }
    await issueAuthorizationCode(context, response);
  } catch (error) {
    if (!keepPendingForRetry) {
      await cleanupFailedCompletion(context, error);
    }
    throw error;
  }
  if (!keepPendingForRetry) {
    await clearPendingAuth(
      context.runtime,
      serverName,
      context.oauthState,
      context.authStorageOptions,
    );
  }
  return "authenticated";
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
  definition: ServerEntry | undefined,
  options: AuthenticateOptions,
): Promise<AuthStatus> {
  if (isServerDisabled(definition)) {
    throw new Error(`MCP server "${serverName}" is disabled`);
  }
  const runtime = useRuntime(options.runtime);
  const runtimeState = getRuntimeState(runtime);
  const authStorageOptions = options.authStorageOptions ?? {};
  const signal = combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal;
  throwIfAborted(signal);
  const authKey = JSON.stringify([serverName, serverUrl, getAuthBaseDir(authStorageOptions)]);
  const inFlight = runtimeState.pendingAuthentications.get(authKey);
  if (inFlight) {
    return inFlight;
  }

  const operation = authenticateOnce(serverName, serverUrl, definition, {
    ...options,
    signal,
    runtime,
  });

  runtimeState.pendingAuthentications.set(authKey, operation);

  try {
    return await operation;
  } finally {
    if (runtimeState.pendingAuthentications.get(authKey) === operation) {
      runtimeState.pendingAuthentications.delete(authKey);
    }
  }
}

async function authenticateOnce(
  serverName: string,
  serverUrl: string,
  definition: ServerEntry | undefined,
  options: AuthenticateOptions,
): Promise<AuthStatus> {
  const runtime = useRuntime(options.runtime);
  const authStorageOptions = options.authStorageOptions ?? {};
  const signal = combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal;
  // Start auth flow
  const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, {
    ...options,
    signal,
    runtime,
  });

  // If no auth URL needed, already authenticated
  if (authorizationUrl === "") {
    return "authenticated";
  }

  let oauthState: string | undefined;
  try {
    // Get the state that was already generated and stored in startAuth().
    // Keep this lookup and its abort check inside the cleanup boundary because
    // startAuth has already reserved callback state at this point.
    oauthState = pendingAuthState(runtime, serverName, authStorageOptions);
    throwIfAborted(signal);
    if (oauthState === undefined || oauthState === "") {
      throw new Error("OAuth state not found - this should not happen");
    }

    // Register the callback BEFORE opening the browser.
    const callbackPromise = waitForCallback(oauthState);
    callbackPromise.catch(() => {
      // The callback is awaited after browser handoff; attach rejection ownership now.
    });

    await showAuthorizationUrl(serverName, authorizationUrl, options, signal);

    // Wait for callback
    const callbackResult = await abortable(callbackPromise, signal);

    // The callback server accepted only the flow-local reserved state.
    throwIfAborted(signal);

    // Complete the auth
    return await completeAuth(serverName, callbackResult, {
      ...options,
      signal,
      runtime,
    });
  } catch (error) {
    if (oauthState !== undefined && oauthState !== "") {
      cancelPendingCallback(oauthState);
    }
    try {
      await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth cancellation cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

async function showAuthorizationUrl(
  serverName: string,
  authorizationUrl: string,
  options: AuthenticateOptions,
  signal?: AbortSignal,
): Promise<void> {
  // Open browser. Always surface the URL first so remote/headless users can copy it
  // even when the OS browser handoff is unavailable or invisible.
  if (options.onAuthorizationUrl) {
    await abortable(Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), signal);
  } else {
    console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`);
  }
  try {
    await abortable(open(authorizationUrl), signal);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    console.warn(
      `MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`,
      { error },
    );
  }
}

/**
 * Remove all OAuth credentials for a server.
 *
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string, options: AuthenticateOptions): Promise<void> {
  const runtime = useRuntime(options.runtime);
  const signal = combineAbortSignals(runtime.signal, options.signal) ?? runtime.signal;
  throwIfAborted(signal);
  const authStorageOptions = options.authStorageOptions ?? {};
  const oauthState = await Promise.resolve(getOAuthState(serverName, authStorageOptions));
  throwIfAborted(signal);
  if (oauthState !== undefined && oauthState !== "") {
    cancelPendingCallback(oauthState);
  }
  await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
  throwIfAborted(signal);
  for (const [key, request] of getRuntimeState(runtime).requests) {
    if (request.serverName === serverName) {
      getRuntimeState(runtime).requests.delete(key);
    }
  }
  clearAllCredentials(serverName, authStorageOptions);
  clearOAuthState(serverName, authStorageOptions);
  await Promise.resolve();
  throwIfAborted(signal);
  console.log(`MCP Auth: Removed credentials for ${serverName}`);
}
