import {
  OAuthError,
  OAuthErrorCode,
  type StoredOAuthTokens,
  type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import type { StoredTokens, StoredClientInfo } from "./mcp-auth.ts";
import { isNonInteractiveOAuth } from "./types.ts";
import {
  loopbackRedirectsMatch,
  issuersMatch,
  oauthModeLabel,
  type McpOAuthConfig,
} from "./mcp-oauth-config.ts";
import sharedClientMetadata from "./docs/client-metadata.json" with { type: "json" };

export function matchesStoredRedirect(info: StoredClientInfo, redirect: string): boolean {
  const uris = info.redirectUris;
  return (
    Array.isArray(uris) &&
    (uris.includes(redirect) ||
      (info.registrationType === "cimd" &&
        uris.some((uri) => loopbackRedirectsMatch(redirect, uri))))
  );
}

function isConfiguredClientStub(clientInfo: StoredClientInfo): boolean {
  return (
    clientInfo.configPreRegistered === true ||
    (clientInfo.clientSecret === undefined &&
      clientInfo.clientIdIssuedAt === undefined &&
      clientInfo.clientSecretExpiresAt === undefined &&
      clientInfo.redirectUris === undefined)
  );
}

function validateStoredRegistration(clientInfo: StoredClientInfo, config: McpOAuthConfig): void {
  if (!(config.privateKeyJwt || isNonInteractiveOAuth(config))) {
    return;
  }
  if (
    clientInfo.registrationType === "cimd" &&
    clientInfo.clientId === sharedClientMetadata.client_id
  ) {
    throw new OAuthError(
      OAuthErrorCode.InvalidRequest,
      `OAuth ${oauthModeLabel(config)} cannot use the saved shared browser registration; configure its own clientId or replace that login`,
    );
  }
}

export function canUseStoredClient(
  clientInfo: StoredClientInfo,
  config: McpOAuthConfig,
  issuer?: string,
): boolean {
  if (isConfiguredClientStub(clientInfo)) {
    return false;
  }
  validateStoredRegistration(clientInfo, config);
  const expires = clientInfo.clientSecretExpiresAt;
  if (expires !== undefined && expires !== 0 && expires < Date.now() / 1000) {
    return false;
  }
  return compatibleIssuer(clientInfo.issuer, issuer);
}

function compatibleIssuer(stored: string | undefined, current: string | undefined): boolean {
  if (stored === undefined || stored === "" || current === undefined || current === "") {
    return true;
  }
  return issuersMatch(stored, current);
}

export function storedTokenInformation(tokens: StoredTokens): StoredOAuthTokens {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    refresh_token: tokens.refreshToken,
    expires_in:
      tokens.expiresAt !== undefined && tokens.expiresAt !== 0
        ? Math.max(0, Math.floor(tokens.expiresAt - Date.now() / 1000))
        : undefined,
    scope: tokens.scope,
    ...(tokens.issuer !== undefined ? { issuer: tokens.issuer } : {}),
  };
}

export function clientRegistration(
  info: StoredOAuthClientInformation,
  details: {
    issuer: string | undefined;
    redirectUrl: string | undefined;
    clientMetadataUrl: string | undefined;
    documentSupported: boolean;
  },
): StoredClientInfo {
  const redirectUris = registrationRedirects(info, details.redirectUrl);
  const clientInfo: StoredClientInfo = {
    clientId: info.client_id,
    ...(info.client_secret !== undefined ? { clientSecret: info.client_secret } : {}),
    ...(info.client_id_issued_at !== undefined
      ? { clientIdIssuedAt: info.client_id_issued_at }
      : {}),
    ...(info.client_secret_expires_at !== undefined
      ? { clientSecretExpiresAt: info.client_secret_expires_at }
      : {}),
    redirectUris,
    // Native CIMD saves only client_id + issuer; DCR's full schema requires redirect_uris.
    ...(info.client_id === details.clientMetadataUrl &&
    !("redirect_uris" in info) &&
    details.documentSupported
      ? { registrationType: "cimd" as const }
      : {}),
    ...(details.issuer !== undefined ? { issuer: details.issuer } : {}),
  };
  return clientInfo;
}

function registrationRedirects(info: StoredOAuthClientInformation, redirectUrl?: string): unknown {
  return (
    ("redirect_uris" in info ? info.redirect_uris : undefined) ??
    (redirectUrl !== undefined && redirectUrl !== "" ? [redirectUrl] : [])
  );
}

export function storedClientInformation(
  clientInfo: StoredClientInfo,
): StoredOAuthClientInformation {
  return {
    client_id: clientInfo.clientId,
    client_secret: clientInfo.clientSecret,
    ...(clientInfo.clientIdIssuedAt !== undefined
      ? { client_id_issued_at: clientInfo.clientIdIssuedAt }
      : {}),
    ...(clientInfo.clientSecretExpiresAt !== undefined
      ? { client_secret_expires_at: clientInfo.clientSecretExpiresAt }
      : {}),
    ...(clientInfo.redirectUris !== undefined ? { redirect_uris: clientInfo.redirectUris } : {}),
    ...(clientInfo.issuer !== undefined ? { issuer: clientInfo.issuer } : {}),
  };
}
