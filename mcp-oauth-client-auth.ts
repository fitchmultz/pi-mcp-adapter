import {
  discoverAndRequestJwtAuthGrant,
  type FetchLike,
  createPrivateKeyJwtAuth,
  OAuthError,
  OAuthErrorCode,
  type AddClientAuthentication,
  type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { isRecord } from "./mcp-oauth-config.ts";
import { resolveCommandSecret } from "./utils.ts";
import type { OAuthPrivateKeyJwtConfig, OAuthCrossAppAccessConfig } from "./types.ts";

export async function requestCrossAppGrant(
  config: OAuthCrossAppAccessConfig,
  binding: { audience: string; resource: string; scope: string | undefined },
  fetchFn: FetchLike,
): ReturnType<typeof discoverAndRequestJwtAuthGrant> {
  const { audience, resource, scope } = binding;
  return await discoverAndRequestJwtAuthGrant({
    idpUrl: resolveCommandSecret(config.idpUrl, "OAuth crossAppAccess.idpUrl"),
    clientId: resolveCommandSecret(config.clientId, "OAuth crossAppAccess.clientId"),
    idToken: resolveCommandSecret(config.idToken, "OAuth crossAppAccess.idToken"),
    ...(config.clientSecret !== undefined
      ? {
          clientSecret: resolveCommandSecret(
            config.clientSecret,
            "OAuth crossAppAccess.clientSecret",
          ),
        }
      : {}),
    audience,
    resource,
    ...(scope !== undefined && scope !== "" ? { scope } : {}),
    fetchFn,
  });
}

function resolvePrivateKey(jwt: OAuthPrivateKeyJwtConfig): OAuthPrivateKeyJwtConfig["privateKey"] {
  if (typeof jwt.privateKey !== "string") {
    return jwt.privateKey;
  }
  try {
    return resolveCommandSecret(jwt.privateKey, "OAuth privateKeyJwt.privateKey");
  } catch (error) {
    // This resolver reports outcomes without command text or output.
    throw new OAuthError(
      OAuthErrorCode.InvalidRequest,
      error instanceof Error ? error.message : "OAuth privateKeyJwt private-key resolution failed",
    );
  }
}

function parsePrivateKey(
  key: OAuthPrivateKeyJwtConfig["privateKey"],
): OAuthPrivateKeyJwtConfig["privateKey"] {
  if (typeof key !== "string" || !key.trimStart().startsWith("{")) {
    return key;
  }
  const parsed: unknown = JSON.parse(key);
  if (isRecord(parsed)) {
    return parsed;
  }
  throw new Error("Invalid JWK object");
}

export function privateKeyAuthentication(
  jwt: OAuthPrivateKeyJwtConfig,
  client: StoredOAuthClientInformation,
): AddClientAuthentication {
  return async (headers, params, url, metadata) => {
    if (client.client_secret !== undefined) {
      throw new OAuthError(
        OAuthErrorCode.InvalidRequest,
        "OAuth privateKeyJwt cannot use a shared-secret client",
      );
    }
    const key = resolvePrivateKey(jwt);
    try {
      const { algorithm, ...options } = jwt;
      await createPrivateKeyJwtAuth({
        ...options,
        privateKey: parsePrivateKey(key),
        alg: algorithm,
        issuer: client.client_id,
        subject: client.client_id,
      })(headers, params, url, metadata);
    } catch {
      throw new OAuthError(
        OAuthErrorCode.InvalidRequest,
        "OAuth privateKeyJwt could not sign an assertion; check the private key and algorithm",
      );
    }
  };
}

function secretAuthMethod(
  client: StoredOAuthClientInformation,
  metadata: TokenMetadata,
): "client_secret_basic" | "client_secret_post" | "none" {
  if (client.client_secret === undefined) {
    return "none";
  }
  const supported = metadata?.token_endpoint_auth_methods_supported ?? [];
  if (supported.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (supported.includes("client_secret_post") || !supported.includes("none")) {
    return "client_secret_post";
  }
  return "none";
}

type TokenMetadata = Parameters<AddClientAuthentication>[3];
export function secretAuthentication(
  client: StoredOAuthClientInformation,
  metadata?: TokenMetadata,
): AddClientAuthentication {
  const method = secretAuthMethod(client, metadata);
  return (headers, params) => {
    if (method === "client_secret_basic") {
      if (client.client_secret === undefined || client.client_secret === "") {
        throw new Error("client_secret_basic authentication requires a client_secret");
      }
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
      );
      return;
    }
    if (!params.has("client_id")) {
      params.set("client_id", client.client_id);
    }
    if (
      method === "client_secret_post" &&
      client.client_secret !== undefined &&
      client.client_secret !== "" &&
      !params.has("client_secret")
    ) {
      params.set("client_secret", client.client_secret);
    }
  };
}
