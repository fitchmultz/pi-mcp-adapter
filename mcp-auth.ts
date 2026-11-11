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

import { getAuthSecretStore, type AuthSecretStore } from "./keyring-store.ts";
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
  isAuthEntry,
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

function parseAuthEntryPayload(serverName: string, payload: string, source: string): AuthEntry {
  const entry = parseJsonPayload(serverName, payload, source);
  if (!isAuthEntry(entry)) {
    throw new InvalidOAuthCredentialRecordError(
      `Invalid OAuth credential record for ${serverName} at ${source}`,
    );
  }
  return entry;
}

function readLegacyAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const data = readFileSync(filePath, "utf-8");
  return parseAuthEntryPayload(serverName, data, filePath);
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

function writeSecureAuthEntry(identity: AuthIdentity, entry: AuthEntry): void {
  const storedEntry = { ...entry, serverUrl: identity.serverUrl };
  const account = getAuthEntryAccount(identity);
  try {
    writeSecureAuthEntryToStore(
      getAuthSecretStore(AUTH_SECRET_SERVICE),
      identity.serverName,
      account,
      storedEntry,
    );
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    writeSecureAuthEntryToStore(
      linuxKeyringRecoveryAuthSecretStore(AUTH_SECRET_SERVICE),
      identity.serverName,
      account,
      storedEntry,
    );
  }
}

function readSecureAuthEntry(
  identity: AuthIdentity,
  service = AUTH_SECRET_SERVICE,
  legacy = false,
): AuthEntry | undefined {
  const account = legacy
    ? getLegacyAuthEntryAccount(identity.serverName)
    : getAuthEntryAccount(identity);
  function read(store: AuthSecretStore): AuthEntry | undefined {
    const stored = readSecureAuthPayloadFromStore(store, identity.serverName, account);
    return stored === undefined
      ? undefined
      : parseAuthEntryPayload(identity.serverName, stored.payload, stored.source);
  }
  try {
    return read(getAuthSecretStore(service));
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    return read(linuxKeyringRecoveryAuthSecretStore(service));
  }
}

function removeSecureAuthEntry(identity: AuthIdentity, legacy = false): void {
  const account = legacy
    ? getLegacyAuthEntryAccount(identity.serverName)
    : getAuthEntryAccount(identity);
  try {
    removeAuthEntryFromStore(getAuthSecretStore(AUTH_SECRET_SERVICE), identity.serverName, account);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    removeAuthEntryFromStore(
      linuxKeyringRecoveryAuthSecretStore(AUTH_SECRET_SERVICE),
      identity.serverName,
      account,
    );
  }
}

function consumeMatchingLegacy(identity: AuthIdentity, options?: AuthStorageOptions): void {
  if (matchesIdentity(readSecureAuthEntry(identity, AUTH_SECRET_SERVICE, true), identity)) {
    removeSecureAuthEntry(identity, true);
  }
  removeMatchingLegacyPlaintext(identity, options);
}

function matchesIdentity(entry: AuthEntry | undefined, identity: AuthIdentity): entry is AuthEntry {
  return entry !== undefined && entry.serverUrl !== "" && entry.serverUrl === identity.serverUrl;
}

function removeMatchingLegacyPlaintext(identity: AuthIdentity, options?: AuthStorageOptions): void {
  if (matchesIdentity(readLegacyAuthEntry(identity.serverName, options), identity)) {
    removeLegacyAuthEntry(identity.serverName, options);
  }
}

function readAuthEntry(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
  behavior: { migrateLegacy?: boolean } = {},
): AuthEntry | undefined {
  const scoped = readSecureAuthEntry(identity);
  if (scoped !== undefined) {
    return matchesIdentity(scoped, identity) ? scoped : undefined;
  }
  const secure = readSecureAuthEntry(identity, AUTH_SECRET_SERVICE, true);
  const legacy = matchesIdentity(secure, identity)
    ? secure
    : readLegacyAuthEntry(identity.serverName, options);
  if (!matchesIdentity(legacy, identity)) {
    return undefined;
  }
  if (behavior.migrateLegacy !== false) {
    writeSecureAuthEntry(identity, legacy);
    if (JSON.stringify(readSecureAuthEntry(identity)) !== JSON.stringify(legacy)) {
      throw new Error(`Failed to verify migrated OAuth credentials for ${identity.serverName}`);
    }
    consumeMatchingLegacy(identity, options);
  }
  return legacy;
}

function getLegacyAuthBaseDir(): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  return override !== undefined && override.length > 0 ? override : getAgentPath("mcp-oauth");
}

/** Copy-only upgrade from the old service; an existing scoped record always wins. */
export function migrateLegacyAuthEntry(
  identity: AuthIdentity,
  legacyDirectory = getLegacyAuthBaseDir(),
): "copied" | "existing" | "absent" {
  if (readSecureAuthEntry(identity) !== undefined) {
    return "existing";
  }
  let entry = readSecureAuthEntry(identity, LEGACY_AUTH_SECRET_SERVICE, true);
  if (!matchesIdentity(entry, identity)) {
    const path = join(
      legacyDirectory,
      getLegacyAuthEntryAccount(identity.serverName),
      "tokens.json",
    );
    if (!existsSync(path)) {
      return "absent";
    }
    entry = parseAuthEntryPayload(identity.serverName, readFileSync(path, "utf8"), path);
  }
  if (!matchesIdentity(entry, identity)) {
    return "absent";
  }
  writeSecureAuthEntry(identity, entry);
  if (JSON.stringify(readSecureAuthEntry(identity)) !== JSON.stringify(entry)) {
    throw new Error(`Failed to verify migrated OAuth credentials for ${identity.serverName}`);
  }
  return "copied";
}

/** Read or import credentials for exactly this configured name and URL. */
export function getAuthEntry(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  return readAuthEntry(identity, options);
}

export function getAuthForUrl(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  return getAuthEntry(identity, options);
}

/** Inspect without migration; unavailable storage is not reported as missing. */
export function inspectAuthForUrl(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): OAuthCredentialStatus {
  try {
    const entry = readAuthEntry(identity, options, { migrateLegacy: false });
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
export function saveAuthEntry(
  identity: AuthIdentity,
  entry: Readonly<AuthEntry>,
  options?: AuthStorageOptions,
): void {
  writeSecureAuthEntry(identity, entry);
  consumeMatchingLegacy(identity, options);
}

/** Consume matching automatic-import sources so logout cannot restore them. */
export function removeAuthEntry(identity: AuthIdentity, options?: AuthStorageOptions): void {
  removeSecureAuthEntry(identity);
  consumeMatchingLegacy(identity, options);
}

export function updateTokens(
  identity: AuthIdentity,
  tokens: StoredTokens,
  options?: AuthStorageOptions,
): void {
  const entry = getAuthEntry(identity, options) ?? {};
  entry.tokens = tokens;
  saveAuthEntry(identity, entry, options);
}

export function updateClientInfo(
  identity: AuthIdentity,
  clientInfo: StoredClientInfo,
  options?: AuthStorageOptions,
): void {
  const entry = getAuthEntry(identity, options) ?? {};
  entry.clientInfo = clientInfo;
  saveAuthEntry(identity, entry, options);
}

export function getOAuthState(
  identity: AuthIdentity,
  options?: AuthStorageOptions,
): string | undefined {
  return getAuthEntry(identity, options)?.oauthState;
}

export function clearAllCredentials(identity: AuthIdentity, options?: AuthStorageOptions): void {
  removeAuthEntry(identity, options);
}

function clearField(
  identity: AuthIdentity,
  field: "codeVerifier" | "oauthState" | "clientInfo" | "tokens",
  options?: AuthStorageOptions,
): void {
  const entry = getAuthEntry(identity, options);
  if (entry) {
    delete entry[field];
    saveAuthEntry(identity, entry, options);
  }
}

export function clearCodeVerifier(identity: AuthIdentity, options?: AuthStorageOptions): void {
  clearField(identity, "codeVerifier", options);
}

export function clearOAuthState(identity: AuthIdentity, options?: AuthStorageOptions): void {
  clearField(identity, "oauthState", options);
}

export function clearClientInfo(identity: AuthIdentity, options?: AuthStorageOptions): void {
  clearField(identity, "clientInfo", options);
}

export function clearTokens(identity: AuthIdentity, options?: AuthStorageOptions): void {
  clearField(identity, "tokens", options);
}
