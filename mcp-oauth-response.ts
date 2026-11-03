import { validateAuthorizationResponseIssuer } from "@modelcontextprotocol/client";
import type { CallbackIssuer } from "./mcp-oauth-runtime.ts";

export function validateCallbackIssuer(
  serverName: string,
  context: CallbackIssuer,
  response: { iss?: string; error?: string },
): void {
  if ((response.error ?? "") !== "" && context.expectedIssuer === undefined) {
    throw new Error("Cannot verify the OAuth error callback issuer");
  }
  try {
    validateAuthorizationResponseIssuer({
      expectedIssuer: context.expectedIssuer ?? context.fallbackIssuer,
      issParameterSupported: context.issParameterSupported === true,
      iss: response.iss,
    });
  } catch {
    if (response.iss === undefined && context.issParameterSupported === true) {
      throw new Error(
        `The authorization server for ${serverName} requires the RFC 9207 "iss" parameter. ` +
          "Paste the full redirect URL from the browser address bar (not just the authorization code).",
      );
    }
    throw new Error(
      `The OAuth authorization response issuer does not match the discovered issuer for ${serverName}.`,
    );
  }
}

function mergeFragmentParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search);
  if (url.hash === "") {
    return params;
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  for (const [key, value] of new URLSearchParams(hash)) {
    if (!params.has(key)) {
      params.set(key, value);
    }
  }
  return params;
}

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    return mergeFragmentParams(new URL(input));
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query);
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined;
  }
}

function validateResponseState(params: URLSearchParams, expectedState?: string): void {
  const state = params.get("state");
  if ((expectedState ?? "") !== "" && (state ?? "") === "") {
    throw new Error("OAuth state missing from redirect URL");
  }
  if ((expectedState ?? "") !== "" && state !== expectedState) {
    throw new Error("OAuth state mismatch - potential CSRF attack");
  }
}

function parameterResponse(params: URLSearchParams): AuthorizationResponseInput | undefined {
  const error = params.get("error");
  const iss = params.get("iss");
  if (error !== null && error !== "") {
    const description = params.get("error_description");
    return {
      error,
      ...(description !== null ? { errorDescription: description } : {}),
      ...(iss !== null ? { iss } : {}),
    };
  }
  const code = params.get("code");
  return code !== null && code !== "" ? { code, ...(iss !== null ? { iss } : {}) } : undefined;
}

/** Authorization code plus the optional RFC 9207 `iss` callback parameter. */
export interface AuthorizationCodeInput {
  code: string;
  iss?: string;
}

/**
 * Extract an OAuth authorization code (and the RFC 9207 `iss` parameter, when
 * present) from either a raw code, a query string, or the full localhost
 * redirect URL copied from the browser address bar.
 */
export type AuthorizationResponseInput =
  | AuthorizationCodeInput
  | { error: string; errorDescription?: string; iss?: string; code?: never };

export function parseAuthorizationRedirectInput(
  input: string,
  expectedState?: string,
): AuthorizationResponseInput {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Authorization code or redirect URL is required");
  }

  const params = getSearchParamsFromInput(trimmed);
  if (params) {
    validateResponseState(params, expectedState);
    const response = parameterResponse(params);
    if (response) {
      return response;
    }
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return { code: trimmed };
  }

  throw new Error("Could not find an OAuth authorization code in the provided input");
}
