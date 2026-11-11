/**
 * MCP OAuth Callback Server
 *
 * HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import {
  DEFAULT_OAUTH_CALLBACK_PATH,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  setOAuthCallbackPath,
  setOAuthCallbackPort,
} from "./mcp-oauth-callback-config.ts";

/** Runs only as the success page's inline browser script, so it may use only browser globals. */
function closeAuthorizationWindow() {
  setTimeout(() => window.close(), 2000);
}

// HTML templates for callback responses
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Pi.</p>
  </div>
  <script>(${closeAuthorizationWindow.toString()})();</script>
</body>
</html>`;

const HTML_MANUAL_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Received</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Received</h1>
    <p>Return to Pi and run auth-complete for this server. No callback URL or code is needed.</p>
  </div>
</body>
</html>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`;

/** Result of a successful OAuth callback */
export interface OAuthCallbackResult {
  code: string;
  /** RFC 9207 `iss` authorization response parameter, when provided */
  iss?: string;
}

export type ValidateOAuthCallback = (response: { iss?: string; error?: string }) => void;

type CallbackOutcome = OAuthCallbackResult | { error: string; iss?: string };

/**
 * One callback state, from its flow's reservation until its waiter settles.
 *
 * A reservation lets the browser arrive before anyone waits; the flow then attaches a waiter. The
 * phase says which of those is true, so a single record carries the callback either way.
 */
type CallbackEntry =
  | {
      phase: "reserved";
      validate: ValidateOAuthCallback | undefined;
      outcome?: CallbackOutcome;
    }
  | {
      phase: "awaiting-callback";
      validate: ValidateOAuthCallback | undefined;
      resolve: (result: OAuthCallbackResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    };

/** Server singleton state */
let server: Server | undefined;
let bindingPromise: Promise<void> | undefined;
let stoppingPromise: Promise<void> | undefined;
let callbackGeneration = 0;
const callbacks = new Map<string, CallbackEntry>();

/** Timeout for callback completion (5 minutes) */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface EnsureCallbackServerOptions {
  strictPort?: boolean;
  port?: number;
  callbackHost?: string;
  callbackPath?: string;
  oauthState?: string;
  reserveState?: boolean;
  validate?: ValidateOAuthCallback;
}

const DEFAULT_OAUTH_CALLBACK_HOST = "localhost";
let callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html" });
  res.end(html);
}

function validateCallback(
  state: string,
  response: Parameters<ValidateOAuthCallback>[0],
  res: ServerResponse,
): boolean {
  const entry = callbacks.get(state);
  try {
    if (entry?.validate) {
      entry.validate(response);
    } else if ((response.error ?? "") !== "") {
      throw new Error("Cannot verify the OAuth error callback issuer");
    }
    return true;
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : "Invalid OAuth callback";
    sendHtml(res, 400, HTML_ERROR(message));
    if (entry?.phase === "awaiting-callback") {
      clearTimeout(entry.timeout);
      callbacks.delete(state);
      entry.reject(new Error(message));
    }
    return false;
  }
}

function providerErrorMessage(params: URLSearchParams, error: string): string {
  const description = params.get("error_description");
  return description !== null && description !== "" ? description : error;
}

function receiveProviderError(
  state: string,
  message: string,
  iss: string | null,
  res: ServerResponse,
): void {
  sendHtml(res, 200, HTML_ERROR(message));
  const entry = callbacks.get(state);
  if (entry?.phase === "awaiting-callback") {
    clearTimeout(entry.timeout);
    callbacks.delete(state);
    setTimeout(() => entry.reject(new Error(message)), 0);
  } else if (entry) {
    // Keep provider-controlled callback payloads out of tool output.
    entry.outcome = {
      error:
        "OAuth authorization was denied or failed. Finish authorization in the browser, then retry auth-complete.",
      ...(iss !== null ? { iss } : {}),
    };
  }
}

function receiveAuthorizationCode(
  state: string,
  result: OAuthCallbackResult,
  res: ServerResponse,
): void {
  const entry = callbacks.get(state);
  if (entry?.phase !== "awaiting-callback") {
    if (entry) {
      entry.outcome = result;
    }
    sendHtml(res, 200, HTML_MANUAL_SUCCESS);
    return;
  }
  clearTimeout(entry.timeout);
  callbacks.delete(state);
  entry.resolve(result);
  sendHtml(res, 200, HTML_SUCCESS);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(
    req.url === "" ? "/" : (req.url ?? "/"),
    `http://${String(req.headers.host)}`,
  );
  if (url.pathname !== getOAuthCallbackPath()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const state = url.searchParams.get("state");
  if (state === null || state === "") {
    sendHtml(res, 400, HTML_ERROR("Missing required state parameter - potential CSRF attack"));
    return;
  }
  if (!callbacks.has(state)) {
    sendHtml(res, 400, HTML_ERROR("Invalid or expired state parameter - potential CSRF attack"));
    return;
  }
  receiveCallback(state, url.searchParams, res);
}

function receiveCallback(state: string, params: URLSearchParams, res: ServerResponse): void {
  const iss = params.get("iss");
  const error = params.get("error");
  const response = {
    ...(iss !== null ? { iss } : {}),
    ...(error !== null && error !== "" ? { error } : {}),
  };
  if (!validateCallback(state, response, res)) {
    return;
  }
  if (error !== null && error !== "") {
    receiveProviderError(state, providerErrorMessage(params, error), iss, res);
    return;
  }
  const code = params.get("code");
  if (code === null || code === "") {
    sendHtml(res, 400, HTML_ERROR("No authorization code provided"));
    return;
  }
  receiveAuthorizationCode(state, { code, ...(iss !== null ? { iss } : {}) }, res);
}

/**
 * Ensure the callback server is running.
 * If strictPort is true, requires binding on the configured callback port.
 * If strictPort is false, asks the OS for an available local port.
 */
export async function ensureCallbackServer(
  options: EnsureCallbackServerOptions = {},
): Promise<void> {
  if (stoppingPromise) {
    throw new Error("OAuth callback server stopped");
  }
  const generation = callbackGeneration;
  for (let binding = bindingPromise; binding; binding = bindingPromise) {
    await binding;
    if (generation !== callbackGeneration) {
      throw new Error("OAuth callback server stopped");
    }
  }
  if (generation !== callbackGeneration) {
    throw new Error("OAuth callback server stopped");
  }

  const operation = ensureCallbackServerLocked(options);
  bindingPromise = operation;
  try {
    await operation;
  } finally {
    if (bindingPromise === operation) {
      bindingPromise = undefined;
    }
  }
}

type CallbackEndpoint = {
  requiredPort: number;
  strictPort: boolean;
  requestedHost: string;
  requestedPath: string;
};

function callbackEndpoint(options: EnsureCallbackServerOptions): CallbackEndpoint {
  const rawPath = options.callbackPath ?? DEFAULT_OAUTH_CALLBACK_PATH;
  const endpoint = {
    requiredPort: options.port ?? getConfiguredOAuthCallbackPort(),
    strictPort: options.strictPort === true,
    requestedHost: options.callbackHost ?? DEFAULT_OAUTH_CALLBACK_HOST,
    requestedPath: rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
  };
  if (options.reserveState === true && (options.oauthState ?? "") === "") {
    throw new Error("OAuth callback reservation requires an oauthState");
  }
  return endpoint;
}

function reserveCallback(options: EnsureCallbackServerOptions): string | undefined {
  const state = options.oauthState;
  if (options.reserveState === true && state !== undefined && state !== "") {
    callbacks.set(state, { phase: "reserved", validate: options.validate });
    return state;
  }
  return undefined;
}

function reuseCallbackServer(endpoint: CallbackEndpoint): boolean {
  if (!server) {
    return false;
  }
  const { strictPort, requiredPort, requestedHost, requestedPath } = endpoint;
  const needsRebind = strictPort && getOAuthCallbackPort() !== requiredPort;
  if (needsRebind || callbackServerHost !== requestedHost) {
    if (callbacks.size > 0) {
      throw new Error(
        `OAuth callback server is running on ${callbackServerHost}:${getOAuthCallbackPort()}, but strict callback endpoint ${requestedHost}:${requiredPort} is required and cannot be switched while authorizations are pending`,
      );
    }
    return false;
  }
  if (getOAuthCallbackPath() === requestedPath) {
    return true;
  }
  if (callbacks.size > 0) {
    throw new Error(
      `OAuth callback server is using path ${getOAuthCallbackPath()}, but callback path ${requestedPath} is required and cannot be switched while authorizations are pending`,
    );
  }
  setOAuthCallbackPath(requestedPath);
  return true;
}

function closeServer(listener: Server): Promise<void> {
  return new Promise((resolve) => {
    listener.close(() => resolve());
  });
}

async function bindCallbackServer(candidate: Server, endpoint: CallbackEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    candidate.once("error", reject);
    candidate.listen(
      endpoint.strictPort ? endpoint.requiredPort : 0,
      endpoint.requestedHost,
      resolve,
    );
  });
  if (endpoint.strictPort) {
    setOAuthCallbackPort(endpoint.requiredPort);
    return;
  }
  const address = candidate.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth callback server did not report an assigned port");
  }
  setOAuthCallbackPort(address.port);
}

function isAddressInUse(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"
  );
}

async function ensureCallbackServerLocked(
  options: EnsureCallbackServerOptions = {},
): Promise<void> {
  const endpoint = callbackEndpoint(options);
  if (reuseCallbackServer(endpoint)) {
    reserveCallback(options);
    return;
  }
  const previousServer = server;
  const candidateServer = createServer(handleRequest);
  let reservedState: string | undefined;
  try {
    await bindCallbackServer(candidateServer, endpoint);
    if (previousServer) {
      await closeServer(previousServer);
    }
    callbackServerHost = endpoint.requestedHost;
    setOAuthCallbackPath(endpoint.requestedPath);
    server = candidateServer;
    reservedState = reserveCallback(options);
    candidateServer.unref();
  } catch (error) {
    if (reservedState !== undefined) {
      callbacks.delete(reservedState);
    }
    await closeServer(candidateServer);
    if (endpoint.strictPort && isAddressInUse(error)) {
      throw new Error(
        `OAuth callback port ${endpoint.requiredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${endpoint.requiredPort}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function releaseCallbackServer(oauthState: string): void {
  callbacks.delete(oauthState);
}

/** Consume a validated manual callback without releasing the flow's reservation. */
export function takeCallbackResult(oauthState: string): CallbackOutcome | undefined {
  const entry = callbacks.get(oauthState);
  if (entry?.phase !== "reserved") {
    return undefined;
  }
  const outcome = entry.outcome;
  delete entry.outcome;
  return outcome;
}

/**
 * Wait for a callback with the given OAuth state.
 * Returns a promise that resolves with the authorization code and, when the
 * authorization server sends one, the RFC 9207 `iss` parameter.
 */
export function waitForCallback(oauthState: string): Promise<OAuthCallbackResult> {
  const reserved = callbacks.get(oauthState);
  callbacks.delete(oauthState);
  const outcome = reserved?.phase === "reserved" ? reserved.outcome : undefined;
  if (outcome) {
    return "error" in outcome ? Promise.reject(new Error(outcome.error)) : Promise.resolve(outcome);
  }
  const validate = reserved?.validate;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (callbacks.get(oauthState)?.phase === "awaiting-callback") {
        callbacks.delete(oauthState);
        reject(new Error("OAuth callback timeout - authorization took too long"));
      }
    }, CALLBACK_TIMEOUT_MS);

    callbacks.set(oauthState, { phase: "awaiting-callback", validate, resolve, reject, timeout });
  });
}

/**
 * Cancel a pending authorization by state.
 */
export function cancelPendingCallback(oauthState: string): void {
  const entry = callbacks.get(oauthState);
  callbacks.delete(oauthState);
  if (entry?.phase === "awaiting-callback") {
    clearTimeout(entry.timeout);
    entry.reject(new Error("Authorization cancelled"));
  }
}

/**
 * Stop the callback server and reject all pending authorizations.
 */
export function stopCallbackServer(): Promise<void> {
  if (stoppingPromise) {
    return stoppingPromise;
  }

  callbackGeneration += 1;
  const cleanup = (async () => {
    for (let binding = bindingPromise; binding; binding = bindingPromise) {
      try {
        await binding;
      } catch {
        // Shutdown drains failed bind attempts before clearing shared state.
      }
    }

    if (server) {
      await closeServer(server);
      server = undefined;
    }

    setOAuthCallbackPort(getConfiguredOAuthCallbackPort());
    callbackServerHost = DEFAULT_OAUTH_CALLBACK_HOST;
    setOAuthCallbackPath(DEFAULT_OAUTH_CALLBACK_PATH);

    // Reject all waiters (defer to allow any pending operations to complete)
    const waiting = [...callbacks.values()].filter((entry) => entry.phase === "awaiting-callback");
    callbacks.clear();
    setTimeout(() => {
      for (const entry of waiting) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("OAuth callback server stopped"));
      }
    }, 0);
  })();

  const operation = cleanup.finally(() => {
    if (stoppingPromise === operation) {
      stoppingPromise = undefined;
    }
  });
  stoppingPromise = operation;
  return operation;
}
