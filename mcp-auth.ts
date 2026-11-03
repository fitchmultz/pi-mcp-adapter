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

import { createHash } from "crypto";
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
const AUTH_SECRET_SERVICE = "fitch-mcp-adapter.oauth";
const LEGACY_AUTH_SECRET_SERVICE = "pi-mcp-adapter.oauth";
const AUTH_SECRET_CHUNK_SIZE = 1800;
const AUTH_CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked";

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

interface AuthEntryChunkManifest {
  [AUTH_CHUNK_MANIFEST_KEY]: 1;
  chunkCount: number;
  chunkDigest: string;
}

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

function getAuthEntryAccount(serverName: string): string {
  if (typeof serverName !== "string") {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: unknown, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), "tokens.json");
}

function parseJsonPayload(serverName: string, payload: string, source: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse OAuth credentials for ${serverName} from ${source}`, {
      cause: error,
    });
  }
}

function parseAuthEntryPayload(serverName: string, payload: string, source: string): AuthEntry {
  return parseJsonPayload(serverName, payload, source) as AuthEntry;
}

function isAuthEntryChunkManifest(value: unknown): value is AuthEntryChunkManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const manifest = value as Partial<AuthEntryChunkManifest>;
  return (
    manifest[AUTH_CHUNK_MANIFEST_KEY] === 1 &&
    typeof manifest.chunkCount === "number" &&
    Number.isInteger(manifest.chunkCount) &&
    manifest.chunkCount > 0 &&
    typeof manifest.chunkDigest === "string" &&
    /^[a-f0-9]{16}$/.test(manifest.chunkDigest)
  );
}

function getAuthEntryChunkAccount(
  account: string,
  manifest: AuthEntryChunkManifest,
  index: number,
): string {
  return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function getAuthEntryChunkAccounts(account: string, manifest: AuthEntryChunkManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) =>
    getAuthEntryChunkAccount(account, manifest, index),
  );
}

function readChunkManifestFromPayload(
  serverName: string,
  payload: string,
  source: string,
): AuthEntryChunkManifest | undefined {
  const parsed = parseJsonPayload(serverName, payload, source);
  return isAuthEntryChunkManifest(parsed) ? parsed : undefined;
}

function readExistingChunkManifest(
  store: AuthSecretStore,
  serverName: string,
  account: string,
): AuthEntryChunkManifest | undefined {
  try {
    const payload = store.read(account);
    return payload === undefined
      ? undefined
      : readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
  } catch {
    return undefined;
  }
}

function removeChunkPayloads(
  store: AuthSecretStore,
  account: string,
  manifest: AuthEntryChunkManifest,
): void {
  for (const chunkAccount of getAuthEntryChunkAccounts(account, manifest)) {
    store.remove(chunkAccount);
  }
}

function tryRemoveChunkPayloads(
  store: AuthSecretStore,
  account: string,
  manifest: AuthEntryChunkManifest | undefined,
): void {
  if (!manifest) {
    return;
  }
  try {
    removeChunkPayloads(store, account, manifest);
  } catch {
    // Stale chunk cleanup must not hide a successful credential write.
  }
}

function createChunkManifest(payload: string): AuthEntryChunkManifest {
  return {
    [AUTH_CHUNK_MANIFEST_KEY]: 1,
    chunkCount: Math.ceil(payload.length / AUTH_SECRET_CHUNK_SIZE),
    chunkDigest: createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16),
  };
}

function readChunkedAuthEntry(
  store: AuthSecretStore,
  serverName: string,
  account: string,
  manifest: AuthEntryChunkManifest,
): AuthEntry {
  const chunks = getAuthEntryChunkAccounts(account, manifest).map((chunkAccount) => {
    try {
      const chunk = store.read(chunkAccount);
      if (chunk === undefined) {
        throw new Error(`Missing OAuth credential chunk ${chunkAccount} for ${serverName}`);
      }
      return chunk;
    } catch (error) {
      throw new OAuthCredentialStoreError(
        `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
        "read",
        error,
      );
    }
  });
  return parseAuthEntryPayload(serverName, chunks.join(""), "OS secure credential store chunks");
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

function writeSecureAuthEntryToStore(
  store: AuthSecretStore,
  serverName: string,
  entry: AuthEntry,
): void {
  const account = getAuthEntryAccount(serverName);
  const payload = JSON.stringify(entry);
  const previousManifest = readExistingChunkManifest(store, serverName, account);
  const manifest =
    payload.length > AUTH_SECRET_CHUNK_SIZE ? createChunkManifest(payload) : undefined;

  try {
    if (manifest) {
      for (let index = 0; index < manifest.chunkCount; index++) {
        const chunk = payload.slice(
          index * AUTH_SECRET_CHUNK_SIZE,
          (index + 1) * AUTH_SECRET_CHUNK_SIZE,
        );
        store.write(getAuthEntryChunkAccount(account, manifest, index), chunk);
      }
      store.write(account, JSON.stringify(manifest));
    } else {
      // Compact: multiline secrets corrupt gnome-keyring plaintext (GKeyFile) collections.
      store.write(account, payload);
    }
    if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
      tryRemoveChunkPayloads(store, account, previousManifest);
    }
  } catch (error) {
    tryRemoveChunkPayloads(store, account, manifest);
    throw new OAuthCredentialStoreError(
      `Failed to write OAuth credentials for ${serverName} to the OS secure credential store`,
      "write",
      error,
    );
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
  const account = getAuthEntryAccount(serverName);
  let payload: string | undefined;
  try {
    payload = store.read(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
      "read",
      error,
    );
  }

  if (payload === undefined) {
    return undefined;
  }
  const manifest = readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
  return manifest
    ? readChunkedAuthEntry(store, serverName, account, manifest)
    : parseAuthEntryPayload(serverName, payload, "OS secure credential store");
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
function removeAuthEntryFromStore(store: AuthSecretStore, serverName: string): void {
  const account = getAuthEntryAccount(serverName);
  try {
    const payload = store.read(account);
    const manifest =
      payload === undefined
        ? undefined
        : readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
    if (manifest) {
      removeChunkPayloads(store, account, manifest);
    }
    store.remove(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the OS secure credential store`,
      "remove",
      error,
    );
  }
}

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
