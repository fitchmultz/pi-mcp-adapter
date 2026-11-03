import { validateClientMetadataUrl, type OAuthClientMetadata } from "@modelcontextprotocol/client";
import {
  isNonInteractiveOAuth,
  type OAuthPrivateKeyJwtConfig,
  type OAuthCrossAppAccessConfig,
} from "./types.ts";
import sharedClientMetadata from "./docs/client-metadata.json" with { type: "json" };

/** Validate explicit document URLs without echoing possible credentials in errors. */
export function validateOAuthClientMetadataUrl(value: string | false | undefined): void {
  if (value === undefined || value === false) {
    return;
  }
  try {
    if (typeof value !== "string" || value === "") {
      throw new Error();
    }
    validateClientMetadataUrl(value);
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || unsafeMetadataSpelling(value)) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "OAuth clientMetadataUrl must be an HTTPS URL with a non-root path and no userinfo, fragment or dot segments",
    );
  }
}

function unsafeMetadataSpelling(value: string): boolean {
  const raw = value.match(/^[^:]+:[/\\]*([^/\\?#]*)([^?#]*)/);
  return (
    raw?.[1]?.includes("@") === true ||
    value.includes("#") ||
    /[/\\](?:\.|%2e){1,2}(?=[/\\]|$)/i.test(raw?.[2] ?? "")
  );
}

/** Only the port may differ; keep raw host, path and query spelling exact. */
export function loopbackRedirectsMatch(first: string, second: unknown): boolean {
  if (typeof second !== "string") {
    return false;
  }
  const port = /^([^:/?#]+:\/\/[^/\\?#@]+):\d+(?=[/\\?#]|$)/;
  if (!port.test(first) || !port.test(second) || first.includes("#") || second.includes("#")) {
    return false;
  }
  try {
    return (
      [new URL(first), new URL(second)].every(
        (url) =>
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          Number(url.port) > 0,
      ) && first.replace(port, "$1") === second.replace(port, "$1")
    );
  } catch {
    return false;
  }
}

export function issuersMatch(first: string, second: string): boolean {
  return (
    first === second ||
    (first.endsWith("/") && first.slice(0, -1) === second) ||
    (second.endsWith("/") && second.slice(0, -1) === first)
  );
}

/** Configuration options for OAuth */
export interface McpOAuthConfig {
  skipIssuerMetadataValidation?: boolean;
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  privateKeyJwt?: OAuthPrivateKeyJwtConfig;
  crossAppAccess?: OAuthCrossAppAccessConfig;
  scope?: string;
  authorizationParams?: Record<string, string>;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
  /** Custom client document URL; false disables automatic CIMD for new registrations. */
  clientMetadataUrl?: string | false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate shapes and method conflicts without resolving or disclosing key sources. */
export function validateOAuthPrivateKeyJwt(config: McpOAuthConfig): void {
  const jwt: unknown = config.privateKeyJwt;
  if (jwt === undefined) {
    return;
  }
  if (!isRecord(jwt)) {
    throw new Error("OAuth privateKeyJwt must be an object");
  }
  validateJwtKey(jwt);
  validateJwtOptions(jwt);
  if (config.clientSecret !== undefined) {
    throw new Error("OAuth privateKeyJwt cannot be combined with clientSecret");
  }
  if (
    (config.clientId ?? "") === "" &&
    (typeof config.clientMetadataUrl !== "string" ||
      config.clientMetadataUrl === sharedClientMetadata.client_id)
  ) {
    throw new Error(
      "OAuth privateKeyJwt requires a configured clientId or custom clientMetadataUrl, not the shared browser identity",
    );
  }
}

function validateJwtKey(jwt: Record<string, unknown>): void {
  const key = jwt.privateKey;
  const validKey = typeof key === "string" ? key.trim() !== "" : isRecord(key);
  if (!validKey) {
    throw new Error("OAuth privateKeyJwt.privateKey must be a nonempty string or JWK object");
  }
  if (
    typeof jwt.algorithm !== "string" ||
    jwt.algorithm.trim() === "" ||
    /^(?:HS|none$)/i.test(jwt.algorithm)
  ) {
    throw new Error("OAuth privateKeyJwt.algorithm must be an asymmetric JOSE algorithm");
  }
}

function validateJwtOptions(jwt: Record<string, unknown>): void {
  if (
    jwt.audience !== undefined &&
    (typeof jwt.audience !== "string" || jwt.audience.trim() === "")
  ) {
    throw new Error("OAuth privateKeyJwt.audience must be a nonempty string");
  }
  if (
    jwt.lifetimeSeconds !== undefined &&
    (typeof jwt.lifetimeSeconds !== "number" ||
      !Number.isSafeInteger(jwt.lifetimeSeconds) ||
      jwt.lifetimeSeconds <= 0)
  ) {
    throw new Error("OAuth privateKeyJwt.lifetimeSeconds must be a positive integer");
  }
  if (jwt.claims !== undefined && !isRecord(jwt.claims)) {
    throw new Error("OAuth privateKeyJwt.claims must be an object");
  }
}

export function validateOAuthCrossAppAccess(config: McpOAuthConfig): void {
  const crossApp: unknown = config.crossAppAccess;
  if (crossApp === undefined) {
    return;
  }
  if (!isRecord(crossApp)) {
    throw new Error("OAuth crossAppAccess must be an object");
  }
  validateCrossAppSources(crossApp);
  if (config.grantType !== undefined) {
    throw new Error("OAuth crossAppAccess selects the JWT-bearer grant; omit grantType");
  }
  if ("audience" in crossApp || "resource" in crossApp) {
    throw new Error(
      "OAuth crossAppAccess uses the discovered MCP issuer and resource; overrides are not supported",
    );
  }
}

function validateCrossAppSources(crossApp: Record<string, unknown>): void {
  for (const field of ["idpUrl", "clientId", "idToken", "clientSecret"]) {
    if (field === "clientSecret" && crossApp[field] === undefined) {
      continue;
    }
    const source = crossApp[field];
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error(`OAuth crossAppAccess.${field} must be a nonempty string`);
    }
  }
}

export function selectClientMetadataUrl(
  config: McpOAuthConfig,
  redirectUrl?: string,
): string | undefined {
  if (config.clientMetadataUrl === false || config.clientSecret !== undefined) {
    return undefined;
  }
  if (
    config.clientMetadataUrl !== undefined &&
    config.clientMetadataUrl !== "" &&
    config.clientMetadataUrl !== sharedClientMetadata.client_id
  ) {
    return config.clientMetadataUrl;
  }
  if (isNonInteractiveOAuth(config) || config.privateKeyJwt !== undefined) {
    return undefined;
  }
  return sharedMetadataUrl(config, redirectUrl);
}

function sharedMetadataUrl(config: McpOAuthConfig, redirectUrl?: string): string | undefined {
  const nameMatches =
    config.clientName === undefined || config.clientName === sharedClientMetadata.client_name;
  const uriMatches =
    config.clientUri === undefined || config.clientUri === sharedClientMetadata.client_uri;
  if (
    nameMatches &&
    uriMatches &&
    sharedClientMetadata.redirect_uris.some((uri) => loopbackRedirectsMatch(uri, redirectUrl))
  ) {
    return sharedClientMetadata.client_id;
  }
  return undefined;
}

export function configuredClientMetadata(
  config: McpOAuthConfig,
  redirectUrl?: string,
): OAuthClientMetadata {
  if (isNonInteractiveOAuth(config)) {
    return {
      client_name: config.clientName ?? "Pi Coding Agent",
      client_uri: config.clientUri ?? "https://github.com/fitchmultz/pi-mcp-adapter",
      redirect_uris: [],
      grant_types: [
        config.crossAppAccess
          ? "urn:ietf:params:oauth:grant-type:jwt-bearer"
          : "client_credentials",
      ],
      token_endpoint_auth_method: configuredAuthMethod(config),
    };
  }

  if (redirectUrl === undefined || redirectUrl === "") {
    throw new Error("redirectUrl is required for authorization_code flow");
  }

  return {
    redirect_uris: [redirectUrl],
    client_name: config.clientName ?? "Pi Coding Agent",
    client_uri: config.clientUri ?? "https://github.com/fitchmultz/pi-mcp-adapter",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: configuredAuthMethod(config),
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
  };
}

export function configuredAuthMethod(
  config: McpOAuthConfig,
): "private_key_jwt" | "client_secret_post" | "none" {
  if (config.privateKeyJwt) {
    return "private_key_jwt";
  }
  return (config.clientSecret ?? "") !== "" ? "client_secret_post" : "none";
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
]);

export function addAuthorizationParams(
  authorizationUrl: URL,
  params: Record<string, string> | undefined,
): URL {
  if (!params) {
    return authorizationUrl;
  }
  const nextUrl = new URL(authorizationUrl.toString());
  for (const [key, value] of Object.entries(params)) {
    if (reservedAuthorizationParams.has(key) || nextUrl.searchParams.has(key)) {
      throw new Error(
        `OAuth authorizationParams.${key} cannot override an authorization flow parameter`,
      );
    }
    nextUrl.searchParams.set(key, value);
  }
  return nextUrl;
}

export function addConfiguredScope(params: URLSearchParams, config: McpOAuthConfig): void {
  if (
    params.get("grant_type") === "authorization_code" &&
    !params.has("scope") &&
    config.scope !== undefined &&
    config.scope !== ""
  ) {
    params.set("scope", config.scope);
  }
}

export function oauthModeLabel(config: McpOAuthConfig): string {
  if (config.privateKeyJwt) {
    return "privateKeyJwt";
  }
  return config.crossAppAccess ? "crossAppAccess" : "client_credentials";
}
