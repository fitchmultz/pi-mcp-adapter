/** OAuth token storage format */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in seconds
  scope?: string;
  /** SEP-2352 authorization-server issuer binding */
  issuer?: string;
}

/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  redirectUris?: string[];
  /** Positively identified native CIMD registration; permits loopback port changes. */
  registrationType?: "cimd";
  /** SEP-2352 authorization-server issuer binding */
  issuer?: string;
  /**
   * True when this entry is a secretless SEP-2352 issuer stub persisted for a
   * config-pre-registered client (written by the config-clientId path of
   * saveClientInformation). Such a stub is only usable when paired with the
   * config that supplies the client secret; it must never be served as
   * standalone client information.
   */
  configPreRegistered?: boolean;
}

/** Complete auth entry for a server */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string; // Track the URL these credentials are for
}

export interface AuthStorageOptions {
  /** Legacy plaintext import directory. Persistent secrets no longer use this as their store. */
  baseDir?: string;
}

export type OAuthCredentialStatus =
  | { status: "present"; entry: AuthEntry }
  | { status: "absent" }
  | { status: "unavailable"; message: string };
