import {
  InsufficientScopeError,
  UnauthorizedError,
  SdkHttpError,
  computeScopeUnion,
} from "@modelcontextprotocol/client";
import { issuersMatch } from "./mcp-oauth-config.ts";
import {
  getRuntimeState,
  getLegacyRuntime,
  type McpOAuthRuntime,
  type OAuthRequest,
} from "./mcp-oauth-runtime.ts";

export function isOAuthChallenge(
  error: unknown,
): error is InsufficientScopeError | UnauthorizedError | SdkHttpError {
  return (
    error instanceof InsufficientScopeError ||
    error instanceof UnauthorizedError ||
    (error instanceof SdkHttpError && error.status === 401)
  );
}

export function getOAuthRequest(
  serverName: string,
  serverUrl: string,
  storageBase: string,
  runtime: McpOAuthRuntime = getLegacyRuntime(),
): OAuthRequest | undefined {
  if (runtime.signal.aborted) {
    return undefined;
  }
  const request = getRuntimeState(runtime).requests.get(JSON.stringify([serverName, storageBase]));
  return request?.serverUrl === serverUrl ? request : undefined;
}

/** Observe native challenges only; no credential reads or auth work here. */
export function recordOAuthChallenge(
  serverName: string,
  serverUrl: string,
  storageBase: string,
  error: unknown,
  runtime: McpOAuthRuntime = getLegacyRuntime(),
): void {
  if (runtime.signal.aborted || !isOAuthChallenge(error)) {
    return;
  }
  const previous = getOAuthRequest(serverName, serverUrl, storageBase, runtime);
  const request: OAuthRequest = { ...previous, serverName, serverUrl };
  if (error instanceof InsufficientScopeError) {
    request.challenge = scopeChallenge(previous, error);
  }
  getRuntimeState(runtime).requests.set(JSON.stringify([serverName, storageBase]), request);
}

function scopeChallenge(
  previous: OAuthRequest | undefined,
  error: InsufficientScopeError,
): NonNullable<OAuthRequest["challenge"]> {
  const requiredScope = computeScopeUnion(previous?.challenge?.requiredScope, error.requiredScope);
  const resourceMetadataUrl = error.resourceMetadataUrl ?? previous?.challenge?.resourceMetadataUrl;
  return {
    ...(requiredScope !== undefined && requiredScope !== "" ? { requiredScope } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
  };
}

export function bindOAuthRequestIssuer(
  serverName: string,
  serverUrl: string,
  storageBase: string,
  issuer: string,
  runtime: McpOAuthRuntime = getLegacyRuntime(),
): void {
  const request = getOAuthRequest(serverName, serverUrl, storageBase, runtime);
  if (!request) {
    return;
  }
  if (
    request.issuer !== undefined &&
    request.issuer !== "" &&
    !issuersMatch(request.issuer, issuer)
  ) {
    throw new Error(
      `OAuth authorization server issuer changed for ${serverName}; clear credentials before authenticating again`,
    );
  }
  request.issuer = issuer;
}
