import type * as Zod from "zod";

async function createAuthRecordSchemas() {
  const { z } = await import("zod");
  const tokens = z.looseObject({
    accessToken: z.string(),
    refreshToken: z.string().exactOptional(),
    expiresAt: z.number().exactOptional(), // Unix timestamp in seconds
    scope: z.string().exactOptional(),
    issuer: z.string().exactOptional(),
  });
  const clientInfo = z.looseObject({
    clientId: z.string(),
    clientSecret: z.string().exactOptional(),
    clientIdIssuedAt: z.number().exactOptional(),
    clientSecretExpiresAt: z.number().exactOptional(),
    // The OAuth flow validates legacy redirect metadata before reusing a registration.
    redirectUris: z.unknown().exactOptional(),
    // Only a positively identified CIMD registration permits loopback port changes.
    registrationType: z.literal("cimd").exactOptional(),
    issuer: z.string().exactOptional(),
    // Secretless issuer stubs require the matching configured client identity.
    configPreRegistered: z.boolean().exactOptional(),
  });
  const entry = z.looseObject({
    tokens: tokens.exactOptional(),
    clientInfo: clientInfo.exactOptional(),
    codeVerifier: z.string().exactOptional(),
    oauthState: z.string().exactOptional(),
    serverUrl: z.string().exactOptional(),
  });
  return { tokens, clientInfo, entry };
}

type AuthRecordSchemas = Awaited<ReturnType<typeof createAuthRecordSchemas>>;
let schemas: AuthRecordSchemas | undefined;

export type StoredTokens = Zod.infer<AuthRecordSchemas["tokens"]>;
export type StoredClientInfo = Zod.infer<AuthRecordSchemas["clientInfo"]>;
export type AuthEntry = Zod.infer<AuthRecordSchemas["entry"]>;

function matchesAuthEntry(schema: AuthRecordSchemas["entry"], value: unknown): value is AuthEntry {
  return schema.safeParse(value).success;
}

/** Structural validation leaves parsed records untouched, preserving legacy JSON property order. */
export async function validateAuthEntry(value: unknown): Promise<AuthEntry | undefined> {
  schemas ??= await createAuthRecordSchemas();
  return matchesAuthEntry(schemas.entry, value) ? value : undefined;
}

/** Credentials belong to one configured name and exact, unnormalized URL. */
export interface AuthIdentity {
  readonly serverName: string;
  readonly serverUrl: string;
}

export interface AuthStorageOptions {
  /** Legacy plaintext import directory. Persistent secrets no longer use this as their store. */
  baseDir?: string;
}

export type OAuthCredentialStatus =
  | { status: "present"; entry: AuthEntry }
  | { status: "absent" }
  | { status: "unavailable"; message: string };

export function isTokenExpired(
  tokens: { readonly expiresAt?: number | undefined },
  nowSeconds = Date.now() / 1000,
): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt !== 0 && tokens.expiresAt <= nowSeconds;
}
