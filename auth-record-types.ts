import { createRequire } from "node:module";
import type * as Zod from "zod";

const require = createRequire(import.meta.url);

function createAuthRecordSchemas() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-021: load the declared Zod API only when credentials are read.
  const { z } = require("zod") as typeof Zod;
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

type AuthRecordSchemas = ReturnType<typeof createAuthRecordSchemas>;
let schemas: AuthRecordSchemas | undefined;

export type StoredTokens = Zod.infer<AuthRecordSchemas["tokens"]>;
export type StoredClientInfo = Zod.infer<AuthRecordSchemas["clientInfo"]>;
export type AuthEntry = Zod.infer<AuthRecordSchemas["entry"]>;

/** Structural validation leaves parsed records untouched, preserving legacy JSON property order. */
export function isAuthEntry(value: unknown): value is AuthEntry {
  schemas ??= createAuthRecordSchemas();
  return schemas.entry.safeParse(value).success;
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
