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
import type {
  AuthEntry,
  AuthStorageOptions,
  OAuthCredentialStatus,
  StoredClientInfo,
  StoredTokens,
} from "./auth-record-types.ts";
import {
  getAuthEntryAccount,
  parseJsonPayload,
  readSecureAuthPayloadFromStore,
  removeAuthEntryFromStore,
  writeSecureAuthEntryToStore,
} from "./credential-payloads.ts";
export type {
  AuthEntry,
  AuthStorageOptions,
  OAuthCredentialStatus,
  StoredClientInfo,
  StoredTokens,
} from "./auth-record-types.ts";

const AUTH_SECRET_SERVICE = "fitch-mcp-adapter.oauth";
const LEGACY_AUTH_SECRET_SERVICE = "pi-mcp-adapter.oauth";

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd()): AuthStorageOptions {
  const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
  return baseDir ? { baseDir: join(baseDir, "fitch-mcp-adapter") } : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
  const override = process.env.FITCH_MCP_OAUTH_DIR?.trim();
  if (override) {
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
  const storageKey = getAuthEntryAccount(serverName);
  return join(getAuthBaseDir(options), storageKey);
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: unknown, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), "tokens.json");
}

function parseAuthEntryPayload(serverName: string, payload: string, source: string): AuthEntry {
  return parseJsonPayload(serverName, payload, source) as AuthEntry;
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

function writeSecureAuthEntry(serverName: string, entry: AuthEntry): void {
  try {
    writeSecureAuthEntryToStore(getAuthSecretStore(AUTH_SECRET_SERVICE), serverName, entry);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    writeSecureAuthEntryToStore(
      linuxKeyringRecoveryAuthSecretStore(AUTH_SECRET_SERVICE),
      serverName,
      entry,
    );
  }
}

function readSecureAuthEntryFromStore(
  store: AuthSecretStore,
  serverName: string,
): AuthEntry | undefined {
  const stored = readSecureAuthPayloadFromStore(store, serverName);
  return stored === undefined
    ? undefined
    : parseAuthEntryPayload(serverName, stored.payload, stored.source);
}

function readSecureAuthEntry(
  serverName: string,
  service = AUTH_SECRET_SERVICE,
): AuthEntry | undefined {
  try {
    return readSecureAuthEntryFromStore(getAuthSecretStore(service), serverName);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    return readSecureAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore(service), serverName);
  }
}

function readAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
  behavior: { migrateLegacy?: boolean } = {},
): AuthEntry | undefined {
  const entry = readSecureAuthEntry(serverName);
  if (entry !== undefined) {
    if (behavior.migrateLegacy !== false) {
      removeLegacyAuthEntry(serverName, options);
    }
    return entry;
  }
  const legacyEntry = readLegacyAuthEntry(serverName, options);
  if (!legacyEntry || behavior.migrateLegacy === false) {
    return legacyEntry;
  }
  writeSecureAuthEntry(serverName, legacyEntry);
  removeLegacyAuthEntry(serverName, options);
  return legacyEntry;
}

/** Explicit copy-only upgrade. Normal reads and logout never access the old service. */
export function migrateLegacyAuthEntry(
  serverName: string,
  legacyDirectory = process.env.MCP_OAUTH_DIR?.trim() || getAgentPath("mcp-oauth"),
): "copied" | "existing" | "absent" {
  if (readSecureAuthEntry(serverName) !== undefined) {
    return "existing";
  }
  let entry = readSecureAuthEntry(serverName, LEGACY_AUTH_SECRET_SERVICE);
  if (entry === undefined) {
    const path = join(legacyDirectory, getAuthEntryAccount(serverName), "tokens.json");
    if (!existsSync(path)) {
      return "absent";
    }
    entry = parseAuthEntryPayload(serverName, readFileSync(path, "utf8"), path);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid legacy OAuth entry for ${serverName}`);
  }
  writeSecureAuthEntry(serverName, entry);
  if (JSON.stringify(readSecureAuthEntry(serverName)) !== JSON.stringify(entry)) {
    throw new Error(`Failed to verify migrated OAuth credentials for ${serverName}`);
  }
  return "copied";
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  return readAuthEntry(serverName, options);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(
  serverName: string,
  serverUrl: string,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  const entry = getAuthEntry(serverName, options);
  if (!entry) {
    return undefined;
  }

  // If no serverUrl is stored, this is from an old version - consider it invalid
  if (!entry.serverUrl) {
    return undefined;
  }

  // If URL has changed, credentials are invalid
  if (entry.serverUrl !== serverUrl) {
    return undefined;
  }

  return entry;
}

/**
 * Inspect credentials for status-only UI paths without treating an unavailable
 * secure store as missing credentials. Authentication operations continue to
 * use getAuthForUrl() directly and therefore remain fail-closed.
 */
export function inspectAuthForUrl(
  serverName: string,
  serverUrl: string,
  options?: AuthStorageOptions,
): OAuthCredentialStatus {
  try {
    const entry = readAuthEntry(serverName, options, { migrateLegacy: false });
    if (!entry?.serverUrl || entry.serverUrl !== serverUrl) {
      return { status: "absent" };
    }
    return { status: "present", entry };
  } catch (error) {
    if (!(error instanceof OAuthCredentialStoreError)) {
      throw error;
    }
    return { status: "unavailable", message: formatOAuthCredentialStoreUnavailable(error) };
  }
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(
  serverName: string,
  entry: AuthEntry,
  serverUrl?: string,
  options?: AuthStorageOptions,
): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeSecureAuthEntry(serverName, entry);
  removeLegacyAuthEntry(serverName, options);
}

/**
 * Remove auth entry for a server.
 */
export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  try {
    removeAuthEntryFromStore(getAuthSecretStore(AUTH_SECRET_SERVICE), serverName);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw error;
    }
    removeAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore(AUTH_SECRET_SERVICE), serverName);
  }
  removeLegacyAuthEntry(serverName, options);
}

/**
 * Update tokens for a server.
 */
export function updateTokens(
  serverName: string,
  tokens: StoredTokens,
  serverUrl?: string,
  options?: AuthStorageOptions,
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
  serverName: string,
  clientInfo: StoredClientInfo,
  serverUrl?: string,
  options?: AuthStorageOptions,
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(
  serverName: string,
  options?: AuthStorageOptions,
): string | undefined {
  const entry = getAuthEntry(serverName, options);
  return entry?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string, options?: AuthStorageOptions): void {
  removeAuthEntry(serverName, options);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}
