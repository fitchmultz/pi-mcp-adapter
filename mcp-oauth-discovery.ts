import {
  Client,
  StreamableHTTPClientTransport,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/client";
import {
  validateOAuthClientMetadataUrl,
  validateOAuthPrivateKeyJwt,
  validateOAuthCrossAppAccess,
  type McpOAuthConfig,
} from "./mcp-oauth-config.ts";
import {
  isNonInteractiveOAuth,
  validateServerProtocolConfig,
  type OAuthConfig,
  type ServerEntry,
} from "./types.ts";
import {
  ADAPTER_VERSION,
  interpolateEnvRecord,
  interpolateEnvVars,
  normalizeRequestTimeoutMs,
} from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { AuthDiscovery } from "./mcp-oauth-runtime.ts";

function configuredString(value: unknown, field: string, trim = false): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`OAuth ${field} must be a string`);
  }
  const interpolated = interpolateEnvVars(value);
  if (!trim) {
    return interpolated;
  }
  const result = interpolated.trim();
  if (result === "") {
    throw new Error(`OAuth ${field} must not be empty`);
  }
  return result;
}

function clientConfiguration(oauth: OAuthConfig): McpOAuthConfig {
  const config: McpOAuthConfig = {};
  if (oauth.skipIssuerMetadataValidation !== undefined) {
    config.skipIssuerMetadataValidation = oauth.skipIssuerMetadataValidation;
  }
  if (oauth.grantType !== undefined) {
    config.grantType = oauth.grantType;
  }
  const id = configuredString(oauth.clientId, "clientId");
  if (id !== undefined) {
    config.clientId = id;
  }
  const secret: unknown = oauth.clientSecret;
  if (secret !== undefined) {
    if (typeof secret !== "string") {
      throw new Error("OAuth clientSecret must be a string");
    }
    config.clientSecret = secret.startsWith("!") ? secret : interpolateEnvVars(secret);
  }
  return config;
}

function documentConfiguration(value: unknown): Pick<McpOAuthConfig, "clientMetadataUrl"> {
  if (value === undefined) {
    return {};
  }
  if (value !== false && typeof value !== "string") {
    throw new Error("OAuth clientMetadataUrl must be a string or false");
  }
  const clientMetadataUrl = value === false ? false : interpolateEnvVars(value);
  validateOAuthClientMetadataUrl(clientMetadataUrl);
  return { clientMetadataUrl };
}

function authorizationParams(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OAuth authorizationParams must be an object");
  }
  const params: Record<string, string> = {};
  const entries: Array<[string, unknown]> = Object.entries(value);
  for (const [key, entry] of entries) {
    if (key === "") {
      throw new Error("OAuth authorizationParams keys must not be empty");
    }
    if (typeof entry !== "string") {
      throw new Error(`OAuth authorizationParams.${key} must be a string`);
    }
    params[key] = interpolateEnvVars(entry);
  }
  return params;
}

function authorizationConfiguration(oauth: OAuthConfig): McpOAuthConfig {
  const config: McpOAuthConfig = {};
  const scope = configuredString(oauth.scope, "scope");
  if (scope !== undefined) {
    config.scope = scope;
  }
  if (oauth.authorizationParams !== undefined) {
    config.authorizationParams = authorizationParams(oauth.authorizationParams);
  }
  const redirectUri = configuredString(oauth.redirectUri, "redirectUri", true);
  if (redirectUri !== undefined) {
    config.redirectUri = redirectUri;
  }
  const name = configuredString(oauth.clientName, "clientName", true);
  if (name !== undefined) {
    config.clientName = name;
  }
  const uri = configuredString(oauth.clientUri, "clientUri", true);
  if (uri !== undefined) {
    config.clientUri = uri;
  }
  return config;
}

/** Extract and validate configuration without evaluating lazy secret sources. */
export function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
  validateServerProtocolConfig(definition);
  if (definition.oauth === false) {
    return {};
  }
  const oauth = definition.oauth ?? {};
  const config: McpOAuthConfig = {
    ...clientConfiguration(oauth),
    ...documentConfiguration(oauth.clientMetadataUrl),
  };
  if (oauth.privateKeyJwt !== undefined) {
    config.privateKeyJwt = oauth.privateKeyJwt;
  }
  if (oauth.crossAppAccess !== undefined) {
    config.crossAppAccess = oauth.crossAppAccess;
  }
  validateOAuthPrivateKeyJwt(config);
  validateOAuthCrossAppAccess(config);
  return { ...config, ...authorizationConfiguration(oauth) };
}

function discoveryHeaders(definition?: ServerEntry): Headers {
  // Discovery must not execute config commands or send their source text.
  const headers = definition?.headers
    ? Object.fromEntries(
        Object.entries(definition.headers).filter(
          ([, value]) => !value.startsWith("!") || value.startsWith("!!"),
        ),
      )
    : undefined;
  return new Headers(interpolateEnvRecord(headers));
}

function discoveryCapabilities(definition?: ServerEntry): ConstructorParameters<typeof Client>[1] {
  if (!isNonInteractiveOAuth(definition?.oauth)) {
    return {};
  }
  const oauth = definition?.oauth;
  const crossAppAccess =
    oauth !== undefined && oauth !== false && oauth.crossAppAccess !== undefined;
  return {
    capabilities: {
      extensions: {
        [crossAppAccess
          ? "io.modelcontextprotocol/enterprise-managed-authorization"
          : "io.modelcontextprotocol/oauth-client-credentials"]: {},
      },
    },
  };
}

export async function probeAuthDiscovery(
  serverUrl: string,
  definition?: ServerEntry,
  signal?: AbortSignal,
): Promise<AuthDiscovery> {
  const headers = discoveryHeaders(definition);
  const timeout = normalizeRequestTimeoutMs(definition?.requestTimeoutMs) ?? 5000;
  const discoverySignal = combineAbortSignals(signal, AbortSignal.timeout(Math.ceil(timeout)));
  let discovery: AuthDiscovery = {};
  const client = new Client(
    { name: "pi-mcp-auth-discovery", version: ADAPTER_VERSION },
    {
      versionNegotiation: { mode: definition?.protocolVersion ?? "auto" },
      ...discoveryCapabilities(definition),
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      discovery = {
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        ...(scope !== undefined && scope !== "" ? { scope } : {}),
      };
      return response;
    },
  });
  try {
    await abortable(client.connect(transport, { timeout }), discoverySignal);
  } catch {
    if (signal?.aborted === true) {
      throwIfAborted(signal);
    }
  } finally {
    await (client.transport ? client.close() : transport.close());
  }
  return discovery;
}

function validateRedirectUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("OAuth redirectUri must not include username or password");
  }
  if (url.hash !== "") {
    throw new Error("OAuth redirectUri must not include a fragment");
  }
  if (url.port === "") {
    throw new Error("OAuth redirectUri must include an explicit numeric port");
  }
}

export function parseOAuthRedirectUri(redirectUri: string): {
  port: number;
  callbackHost: string;
  callbackPath: string;
} {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error });
  }
  validateRedirectUrl(url);
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port");
  }
  const hostname = url.hostname.toLowerCase();
  return {
    port,
    callbackHost: hostname === "[::1]" ? "::1" : hostname,
    callbackPath: url.pathname,
  };
}
