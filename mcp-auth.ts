/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored in the operating system credential store.
 * Legacy plaintext entries are imported from $FITCH_MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json
 * when set, otherwise <Pi agent dir>/fitch-mcp-adapter/mcp-oauth/sha256-<server-hash>/tokens.json,
 * then the plaintext file is removed.
 */

import { readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { getAdapterPath, getAgentPath } from "./agent-dir.ts";
import { resolveConfiguredOAuthDir } from "./config.ts";

import { getAuthSecretStore, withAuthSecretLock, type AuthSecretStore } from "./keyring-store.ts";
import {
  linuxKeyringRecoveryAuthSecretStore,
  shouldAttemptLinuxKeyringRecovery,
} from "./keyring-recovery.ts";
import {
  OAuthCredentialStoreError,
  formatOAuthCredentialStoreUnavailable,
} from "./credential-store-errors.ts";
export {
  OAuthCredentialStoreError,
  formatOAuthCredentialStoreUnavailable,
} from "./credential-store-errors.ts";
import {
  validateAuthEntry,
  type AuthEntry,
  type AuthIdentity,
  type AuthStorageOptions,
  type OAuthCredentialStatus,
  type StoredClientInfo,
  type StoredTokens,
} from "./auth-record-types.ts";
import {
  getAuthEntryAccount,
  getLegacyAuthEntryAccount,
  parseJsonPayload,
  readSecureAuthPayloadFromStore,
  removeAuthEntryFromStore,
  writeSecureAuthEntryToStore,
} from "./credential-payloads.ts";
export type {
  AuthEntry,
  AuthIdentity,
  AuthStorageOptions,
  OAuthCredentialStatus,
  StoredClientInfo,
  StoredTokens,
} from "./auth-record-types.ts";

const AUTH_SECRET_SERVICE = "fitch-mcp-adapter.oauth";
const LEGACY_AUTH_SECRET_SERVICE = "pi-mcp-adapter.oauth";
const storageRevisions = new Map<string, number>();

export interface TokenSnapshot {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
}

export interface UpdateTokensOptions {
  /** Preserve stored refreshToken and scope when omitted by a same-issuer refresh response. */
  preserveOnRefresh?: boolean;
}

function bumpAuthStorageRevision(identity: AuthIdentity): void {
  const account = getAuthEntryAccount(identity);
  storageRevisions.set(account, (storageRevisions.get(account) ?? 0) + 1);
}

/** Monotonic in-process revision for this credential identity; used to invalidate token caches. */
export function getAuthStorageRevision(identity: AuthIdentity): number {
  return storageRevisions.get(getAuthEntryAccount(identity)) ?? 0;
}

function issuersCompatible(existing: string | undefined, incoming: string | undefined): boolean {
  if (existing === undefined || existing === "" || incoming === undefined || incoming === "") {
    return true;
  }
  return (
    existing === incoming ||
    (existing.endsWith("/") && existing.slice(0, -1) === incoming) ||
    (incoming.endsWith("/") && incoming.slice(0, -1) === existing)
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function mergeRefreshedTokens(
  existing: StoredTokens | undefined,
  incoming: StoredTokens,
): StoredTokens {
  if (!existing || !issuersCompatible(existing.issuer, incoming.issuer)) {
    return incoming;
  }
  const merged: StoredTokens = { ...incoming };
  const refreshToken = nonEmpty(incoming.refreshToken) ?? nonEmpty(existing.refreshToken);
  const scope = nonEmpty(incoming.scope) ?? nonEmpty(existing.scope);
  if (refreshToken !== undefined) {
    merged.refreshToken = refreshToken;
  } else {
    delete merged.refreshToken;
  }
  if (scope !== undefined) {
    merged.scope = scope;
  }
  return merged;
}

function withCredentialLock<T>(
  identity: AuthIdentity,
  action: OAuthCredentialStoreError["operation"],
  operation: () => Promise<T>,
): Promise<T> {
  return withAuthSecretLock(
    AUTH_SECRET_SERVICE,
    getLegacyAuthEntryAccount(identity.serverName),
    action,
    operation,
  );
}

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd()): AuthStorageOptions {
  const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
  return baseDir !== undefined && baseDir.length > 0
    ? { baseDir: join(baseDir, "fitch-mcp-adapter") }
    : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
  const override = process.env.FITCH_MCP_OAUTH_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return options.baseDir ?? getAdapterPath("mcp-oauth");
}

/**
 * Get the legacy server-specific directory path.
 */
function getServerDir(serverName: unknown, options?: AuthStorageOptions): string {
  if (typeof serverName !== "string") {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const storageKey = getLegacyAuthEntryAccount(serverName);
  return join(getAuthBaseDir(options), storageKey);
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: unknown, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), "tokens.json");
}

class InvalidOAuthCredentialRecordError extends Error {
  override readonly name = "InvalidOAuthCredentialRecordError";
}

async function parseAuthEntryPayload(
  serverName: string,
  payload: string,
  source: string,
): Promise<AuthEntry> {
  const entry = await validateAuthEntry(parseJsonPayload(serverName, payload, source));
  if (!entry) {
    throw new InvalidOAuthCredentialRecordError(
      `Invalid OAuth credential record for ${serverName} at ${source}`,
    );
  }
  return entry;
}

async function readLegacyAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
): Promise<AuthEntry | undefined> {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const data = readFileSync(filePath, "utf-8");
  return await parseAuthEntryPayload(serverName, data, filePath);
}

function removeLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) {
    return;
  }
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(
      `Failed to remove legacy plaintext OAuth credentials for ${serverName} at ${filePath}`,
      { cause: error },
    );
  }

  const dir = getServerDir(serverName, options);
  try {
    rmSync(dir, { recursive: true });
  } catch {
    // Directory may contain future non-secret metadata; the plaintext file was already removed.
  }
}

async function withLinuxRecovery<T>(
  service: string,
  operation: (store: AuthSecretStore) => Promise<T>,
): Promise<T> {
  try {
    return await operation(getAuthSecretStore(service));
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    return await operation(linuxKeyringRecoveryAuthSecretStore(service));
  }
}

async function writeSecureAuthEntry(identity: AuthIdentity, entry: AuthEntry): Promise<void> {
  const storedEntry = { ...entry, serverUrl: identity.serverUrl };
  const account = getAuthEntryAccount(identity);
  await withLinuxRecovery(AUTH_SECRET_SERVICE, (store) =>
    writeSecureAuthEntryToStore(store, identity.serverName, account, storedEntry),
  );
}

async function readSecureAuthEntry(
  identity: AuthIdentity,
  service = AUTH_SECRET_SERVICE,
  legacy = false,
): Promise<AuthEntry | undefined> {
  const account = legacy
    ? getLegacyAuthEntryAccount(identity.serverName)
    : getAuthEntryAccount(identity);
  return await withLinuxRecovery(service, async (store) => {
    const stored = await readSecureAuthPayloadFromStore(store, identity.serverName, account);
    return stored === undefined
      ? undefined
      : await parseAuthEntryPayload(identity.serverName, stored.payload, stored.source);
  });
}

async function removeSecureAuthEntry(identity: AuthIdentity, legacy = false): Promise<void> {
  const account = legacy
    ? getLegacyAuthEntryAccount(identity.serverName)
    : getAuthEntryAccount(identity);
  await withLinuxRecovery(AUTH_SECRET_SERVICE, (store) =>
    removeAuthEntryFromStore(store, identity.serverName, account),
  );
}

async function consumeMatchingLegacy(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  if (matchesIdentity(await readSecureAuthEntry(identity, AUTH_SECRET_SERVICE, true), identity)) {
    await removeSecureAuthEntry(identity, true);
  }
  await removeMatchingLegacyPlaintext(identity, options);
}

function matchesIdentity(entry: AuthEntry | undefined, identity: AuthIdentity): entry is AuthEntry {
  return entry !== undefined && entry.serverUrl !== "" && entry.serverUrl === identity.serverUrl;
}

async function removeMatchingLegacyPlaintext(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  if (matchesIdentity(await readLegacyAuthEntry(identity.serverName, options), identity)) {
    removeLegacyAuthEntry(identity.serverName, options);
  }
}

async function readAuthEntry(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
  behavior: { migrateLegacy?: boolean } = {},
): Promise<AuthEntry | undefined> {
  const scoped = await readSecureAuthEntry(identity);
  if (scoped !== undefined) {
    return matchesIdentity(scoped, identity) ? scoped : undefined;
  }
  const secure = await readSecureAuthEntry(identity, AUTH_SECRET_SERVICE, true);
  const legacy = matchesIdentity(secure, identity)
    ? secure
    : await readLegacyAuthEntry(identity.serverName, options);
  if (!matchesIdentity(legacy, identity)) {
    return undefined;
  }
  if (behavior.migrateLegacy !== false) {
    await writeSecureAuthEntry(identity, legacy);
    if (JSON.stringify(await readSecureAuthEntry(identity)) !== JSON.stringify(legacy)) {
      throw new Error(`Failed to verify migrated OAuth credentials for ${identity.serverName}`);
    }
    await consumeMatchingLegacy(identity, options);
  }
  return legacy;
}

function getLegacyAuthBaseDir(): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : getAgentPath("mcp-oauth");
}

/** Promote current credentials first; historical sources are copied only when absent. */
export async function migrateLegacyAuthEntry(
  identity: AuthIdentity,
  legacyDirectory = getLegacyAuthBaseDir(),
  options?: AuthStorageOptions,
): Promise<"copied" | "existing" | "absent"> {
  return await withCredentialLock(identity, "write", () =>
    copyLegacyAuthEntry(identity, legacyDirectory, options),
  );
}

async function copyLegacyAuthEntry(
  identity: AuthIdentity,
  legacyDirectory: string,
  options?: AuthStorageOptions,
): Promise<"copied" | "existing" | "absent"> {
  if (
    (await readSecureAuthEntry(identity)) !== undefined ||
    (await readAuthEntry(identity, options)) !== undefined
  ) {
    return "existing";
  }
  let entry = await readSecureAuthEntry(identity, LEGACY_AUTH_SECRET_SERVICE, true);
  if (!matchesIdentity(entry, identity)) {
    const path = join(
      legacyDirectory,
      getLegacyAuthEntryAccount(identity.serverName),
      "tokens.json",
    );
    if (!existsSync(path)) {
      return "absent";
    }
    entry = await parseAuthEntryPayload(identity.serverName, readFileSync(path, "utf8"), path);
  }
  if (!matchesIdentity(entry, identity)) {
    return "absent";
  }
  await writeSecureAuthEntry(identity, entry);
  if (JSON.stringify(await readSecureAuthEntry(identity)) !== JSON.stringify(entry)) {
    throw new Error(`Failed to verify migrated OAuth credentials for ${identity.serverName}`);
  }
  return "copied";
}

/** Read or import credentials for exactly this configured name and URL. */
export async function getAuthEntry(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<AuthEntry | undefined> {
  const probe = await withCredentialLock(identity, "read", async () => {
    const scoped = await readSecureAuthEntry(identity);
    if (scoped !== undefined) {
      return {
        entry: matchesIdentity(scoped, identity) ? scoped : undefined,
        needsMigration: false,
      };
    }
    const legacySecure = await readSecureAuthEntry(identity, AUTH_SECRET_SERVICE, true);
    if (matchesIdentity(legacySecure, identity)) {
      return { entry: undefined, needsMigration: true };
    }
    const legacyPlaintext = await readLegacyAuthEntry(identity.serverName, options);
    return { entry: undefined, needsMigration: matchesIdentity(legacyPlaintext, identity) };
  });
  if (!probe.needsMigration) {
    return probe.entry;
  }
  // Migration writes. Release the read lock, then recheck the destination under a write lock.
  return await withCredentialLock(identity, "write", () => readAuthEntry(identity, options));
}

export async function getAuthForUrl(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<AuthEntry | undefined> {
  return await getAuthEntry(identity, options);
}

/** Inspect without migration; unavailable storage is not reported as missing. */
export async function inspectAuthForUrl(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<OAuthCredentialStatus> {
  try {
    const entry = await withCredentialLock(identity, "read", () =>
      readAuthEntry(identity, options, { migrateLegacy: false }),
    );
    return entry === undefined ? { status: "absent" } : { status: "present", entry };
  } catch (error) {
    if (error instanceof OAuthCredentialStoreError) {
      return { status: "unavailable", message: formatOAuthCredentialStoreUnavailable(error) };
    }
    if (error instanceof InvalidOAuthCredentialRecordError) {
      return { status: "unavailable", message: error.message };
    }
    throw error;
  }
}

/** Save a copy whose stored URL always comes from the credential identity. */
export async function saveAuthEntry(
  identity: AuthIdentity,
  entry: Readonly<AuthEntry>,
  options?: AuthStorageOptions,
): Promise<void> {
  await withCredentialLock(identity, "write", () => writeAuthEntry(identity, entry, options));
}

async function writeAuthEntry(
  identity: AuthIdentity,
  entry: Readonly<AuthEntry>,
  options?: AuthStorageOptions,
): Promise<void> {
  await writeSecureAuthEntry(identity, entry);
  await consumeMatchingLegacy(identity, options);
  bumpAuthStorageRevision(identity);
}

/** Consume matching automatic-import sources so logout cannot restore them. */
export async function removeAuthEntry(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await withCredentialLock(identity, "remove", async () => {
    await removeSecureAuthEntry(identity);
    await consumeMatchingLegacy(identity, options);
    bumpAuthStorageRevision(identity);
  });
}

export async function updateTokens(
  identity: AuthIdentity,
  tokens: StoredTokens,
  options?: AuthStorageOptions,
  updateOptions?: UpdateTokensOptions,
): Promise<StoredTokens> {
  return await withCredentialLock(identity, "write", async () => {
    const entry = (await readAuthEntry(identity, options)) ?? {};
    const nextTokens =
      updateOptions?.preserveOnRefresh === true
        ? mergeRefreshedTokens(entry.tokens, tokens)
        : tokens;
    entry.tokens = nextTokens;
    await writeAuthEntry(identity, entry, options);
    return nextTokens;
  });
}

export async function updateClientInfo(
  identity: AuthIdentity,
  clientInfo: StoredClientInfo,
  options?: AuthStorageOptions,
): Promise<void> {
  await withCredentialLock(identity, "write", async () => {
    const entry = (await readAuthEntry(identity, options)) ?? {};
    entry.clientInfo = clientInfo;
    await writeAuthEntry(identity, entry, options);
  });
}

export async function getOAuthState(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<string | undefined> {
  return (await getAuthEntry(identity, options))?.oauthState;
}

export async function clearAllCredentials(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await removeAuthEntry(identity, options);
}

async function clearField(
  identity: AuthIdentity,
  field: "codeVerifier" | "oauthState" | "clientInfo" | "tokens",
  options?: AuthStorageOptions,
): Promise<void> {
  await withCredentialLock(identity, "write", async () => {
    const entry = await readAuthEntry(identity, options);
    if (entry) {
      delete entry[field];
      await writeAuthEntry(identity, entry, options);
    }
  });
}

export async function clearCodeVerifier(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await clearField(identity, "codeVerifier", options);
}

export async function clearOAuthState(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await clearField(identity, "oauthState", options);
}

export async function clearClientInfo(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await clearField(identity, "clientInfo", options);
}

export async function clearTokens(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): Promise<void> {
  await clearField(identity, "tokens", options);
}

/**
 * Conditionally clear stored tokens only if storage still holds the exact failing snapshot.
 * Prevents a stale refresh failure from wiping newer tokens written by another request or session.
 */
export async function clearTokensIfMatching(
  identity: AuthIdentity,
  expected: TokenSnapshot,
  options?: AuthStorageOptions,
): Promise<boolean> {
  return await withCredentialLock(identity, "write", async () => {
    const entry = await readAuthEntry(identity, options);
    const current = entry?.tokens;
    if (
      !entry ||
      !current ||
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    delete entry.tokens;
    await writeAuthEntry(identity, entry, options);
    return true;
  });
}
