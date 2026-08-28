/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored as AES-256-GCM encrypted files at
 * $MCP_OAUTH_DIR/sha256-<server-hash>.enc when set, otherwise
 * <Pi agent dir>/mcp-oauth/sha256-<server-hash>.enc (settings.oauthDir is
 * honored through the same resolution). A single random 32-byte data
 * encryption key (DEK) for all servers lives in the operating system
 * credential store as one small item, so the OS prompts for keychain access
 * at most once per install instead of once per stored credential chunk.
 *
 * The adapter fails closed: when the OS credential store is unavailable there
 * is no DEK and no decryption, and credentials are never written in plaintext.
 *
 * One-way migration on first read imports legacy chunked keyring entries and
 * legacy plaintext $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json files into
 * the encrypted-file scheme, then removes the old entries.
 */

import { spawnSync } from 'child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { readFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { getAgentPath } from './agent-dir.ts';
import { resolveConfiguredOAuthDir } from './config.ts';

const require = createRequire(import.meta.url);
const AUTH_SECRET_SERVICE = 'pi-mcp-adapter.oauth';
/** Keyring account holding the shared base64-encoded 32-byte data encryption key. */
const AUTH_DEK_ACCOUNT = 'encryption-key.v1';
const AUTH_ENCRYPTED_FILE_VERSION = 1;
const TEST_AUTH_STORE_ENV = 'PI_MCP_ADAPTER_TEST_AUTH_STORE';
const KEYRING_RECOVERY_DISABLED_ENV = 'PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY';
const KEYRING_RECOVERY_KEYCTL_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL';
const KEYRING_RECOVERY_NODE_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE';
const KEYRING_RECOVERY_HELPER_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER';
const TEST_LINUX_KEYRING_RECOVERY_ENV = 'PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY';
const KEYRING_RECOVERY_TIMEOUT_MS = 10_000;
const AUTH_CHUNK_MANIFEST_KEY = '__piMcpAdapterOAuthChunked';

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
  /** OAuth credential directory: encrypted `.enc` files live here and legacy plaintext `tokens.json` is imported from here. */
  baseDir?: string;
}

export class OAuthCredentialStoreError extends Error {
  readonly code = 'OAUTH_CREDENTIAL_STORE_UNAVAILABLE';

  constructor(
    message: string,
    readonly operation: 'read' | 'write' | 'remove',
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'OAuthCredentialStoreError';
  }
}

export type OAuthCredentialStatus =
  | { status: 'present'; entry: AuthEntry }
  | { status: 'absent' }
  | { status: 'unavailable'; message: string };

function causeChainContains(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while ((typeof current === 'object' && current !== null) || typeof current === 'function') {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if ([candidate.name, candidate.message, candidate.code].some(value => typeof value === 'string' && pattern.test(value))) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

const DARWIN_KEYCHAIN_GUIDANCE = 'macOS is asking for your login keychain password (normally your Mac login password); click Always Allow to stop future prompts.';

function keyringAccessGuidance(): string {
  return process.platform === 'darwin' ? ` ${DARWIN_KEYCHAIN_GUIDANCE}` : '';
}

export function formatOAuthCredentialStoreUnavailable(error: OAuthCredentialStoreError): string {
  if (process.platform === 'linux' && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i)) {
    return 'OAuth credential store unavailable: the Linux session keyring may be revoked. Start Pi from a fresh login/keyring session and retry.';
  }
  if (process.platform === 'darwin') {
    return `OAuth credential store unavailable. ${DARWIN_KEYCHAIN_GUIDANCE}`;
  }
  return 'OAuth credential store unavailable. Configure or unlock the OS credential store and retry.';
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
type KeyringModule = { Entry: KeyringEntryConstructor };
type KeyringRequire = ((id: string) => unknown) & { resolve(id: string): string };

interface AuthSecretStore {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
}

interface AuthEntryChunkManifest {
  [AUTH_CHUNK_MANIFEST_KEY]: 1;
  chunkCount: number;
  chunkDigest: string;
}

let KeyringEntryClass: KeyringEntryConstructor | undefined;
const memoryAuthEntries = new Map<string, string>();

const memoryAuthSecretStore: AuthSecretStore = {
  read(account) {
    return memoryAuthEntries.get(account);
  },
  write(account, payload) {
    memoryAuthEntries.set(account, payload);
  },
  remove(account) {
    memoryAuthEntries.delete(account);
  },
};

const keyringAuthSecretStore: AuthSecretStore = {
  read(account) {
    return getKeyringEntry(account).getPassword() ?? undefined;
  },
  write(account, payload) {
    getKeyringEntry(account).setPassword(payload);
  },
  remove(account) {
    getKeyringEntry(account).deleteCredential();
  },
};

const unavailableAuthSecretStore: AuthSecretStore = {
  read() {
    throw new Error('simulated secure credential store unavailable');
  },
  write() {
    throw new Error('simulated secure credential store unavailable');
  },
  remove() {
    throw new Error('simulated secure credential store unavailable');
  },
};

function createKeyRevokedTestError(): Error {
  return new Error("Couldn't access platform storage: KeyRevoked", { cause: new Error('KeyRevoked') });
}

const keyRevokedAuthSecretStore: AuthSecretStore = {
  read() {
    throw createKeyRevokedTestError();
  },
  write() {
    throw createKeyRevokedTestError();
  },
  remove() {
    throw createKeyRevokedTestError();
  },
};

function getAuthSecretStore(): AuthSecretStore {
  if (process.env[TEST_AUTH_STORE_ENV] === 'memory') return memoryAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'unavailable') return unavailableAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'keyrevoked') return keyRevokedAuthSecretStore;
  return keyringAuthSecretStore;
}

let keychainAccessNoticeShown = false;

/**
 * The macOS keychain dialog names no password and no reason. Say what may be
 * about to happen once per process so a prompt never comes out of nowhere.
 */
function showKeychainAccessNoticeOnce(): void {
  if (keychainAccessNoticeShown || process.platform !== 'darwin') return;
  keychainAccessNoticeShown = true;
  console.warn(`pi-mcp-adapter: accessing the OS credential store for OAuth credentials. If ${DARWIN_KEYCHAIN_GUIDANCE}`);
}

function getKeyringEntry(account: string): KeyringEntry {
  try {
    KeyringEntryClass ??= loadKeyringEntryClass();
    const entry = new KeyringEntryClass(AUTH_SECRET_SERVICE, account);
    showKeychainAccessNoticeOnce();
    return entry;
  } catch (error) {
    throw new Error(`OAuth secure credential storage is unavailable. Configure the OS credential store and retry authentication.${keyringAccessGuidance()}`, { cause: error });
  }
}

function loadKeyringEntryClass(keyringRequire: KeyringRequire = require, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): KeyringEntryConstructor {
  try {
    return (keyringRequire('@napi-rs/keyring') as KeyringModule).Entry;
  } catch (loaderError) {
    try {
      return loadKeyringNativeBindingFallback(keyringRequire, platform, arch).Entry;
    } catch (fallbackError) {
      throw new Error(`Failed to load @napi-rs/keyring; absolute-path native binding fallback also failed: ${formatErrorMessage(fallbackError)}`, {
        cause: loaderError,
      });
    }
  }
}

function loadKeyringNativeBindingFallback(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringModule {
  const targets = getKeyringNativeBindingTargets(platform, arch);
  if (targets.length === 0) {
    throw new Error(`Unsupported @napi-rs/keyring native binding target: ${platform}-${arch}`);
  }

  let lastError: unknown;
  for (const target of targets) {
    try {
      const packageJsonPath = keyringRequire.resolve(`${target.packageName}/package.json`);
      return keyringRequire(join(dirname(packageJsonPath), target.bindingFile)) as KeyringModule;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getKeyringNativeBindingTargets(platform: NodeJS.Platform, arch: NodeJS.Architecture): { packageName: string; bindingFile: string }[] {
  return getKeyringNativeBindingSuffixes(platform, arch).map(suffix => ({
    packageName: `@napi-rs/keyring-${suffix}`,
    bindingFile: `keyring.${suffix}.node`,
  }));
}

function getKeyringNativeBindingSuffixes(platform: NodeJS.Platform, arch: NodeJS.Architecture): string[] {
  if (platform === 'darwin') {
    if (arch === 'arm64') return ['darwin-arm64'];
    if (arch === 'x64') return ['darwin-x64'];
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return ['win32-arm64-msvc'];
    if (arch === 'x64') return ['win32-x64-msvc'];
    if (arch === 'ia32') return ['win32-ia32-msvc'];
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return ['linux-arm64-gnu', 'linux-arm64-musl'];
    if (arch === 'arm') return ['linux-arm-gnueabihf'];
    if (arch === 'riscv64') return ['linux-riscv64-gnu'];
    if (arch === 'x64') return ['linux-x64-gnu', 'linux-x64-musl'];
  }
  if (platform === 'freebsd' && arch === 'x64') return ['freebsd-x64'];
  return [];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type KeyringRecoveryOperation = 'read' | 'write' | 'remove';

type KeyringRecoveryResponse =
  | { ok: true; found?: boolean; value?: string }
  | { ok: false; error?: string };

function isLinuxKeyringRecoveryEnabled(): boolean {
  if (process.env[KEYRING_RECOVERY_DISABLED_ENV] === '1') return false;
  return process.platform === 'linux' || process.env[TEST_LINUX_KEYRING_RECOVERY_ENV] === '1';
}

function shouldAttemptLinuxKeyringRecovery(error: unknown): boolean {
  return isLinuxKeyringRecoveryEnabled()
    && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i);
}

function runLinuxKeyringRecoveryOperation(operation: KeyringRecoveryOperation, account: string, payload?: string): KeyringRecoveryResponse {
  const keyctl = process.env[KEYRING_RECOVERY_KEYCTL_ENV]?.trim() || 'keyctl';
  const node = process.env[KEYRING_RECOVERY_NODE_ENV]?.trim() || 'node';
  const helper = process.env[KEYRING_RECOVERY_HELPER_ENV]?.trim()
    || fileURLToPath(new URL('./mcp-keyring-helper.cjs', import.meta.url));
  const request = JSON.stringify({ operation, service: AUTH_SECRET_SERVICE, account, payload });
  const result = spawnSync(keyctl, ['session', '-', node, helper], {
    input: `${request}\n`,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: KEYRING_RECOVERY_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Linux keyring recovery helper could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`Linux keyring recovery helper failed with exit code ${result.status ?? 'unknown'}`);
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout.trim()) as unknown;
  } catch (error) {
    throw new Error('Linux keyring recovery helper returned invalid JSON', { cause: error });
  }
  if (typeof response !== 'object' || response === null || typeof (response as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('Linux keyring recovery helper returned an invalid response');
  }
  const typedResponse = response as KeyringRecoveryResponse;
  if (typedResponse.ok === false) {
    throw new Error(typedResponse.error || 'Linux keyring recovery helper failed');
  }
  if (operation === 'read' && typedResponse.found === true && typeof typedResponse.value !== 'string') {
    throw new Error('Linux keyring recovery helper returned an invalid read response');
  }
  return typedResponse;
}

const linuxKeyringRecoveryAuthSecretStore: AuthSecretStore = {
  read(account) {
    const response = runLinuxKeyringRecoveryOperation('read', account);
    return response.ok && response.found === true ? response.value : undefined;
  },
  write(account, payload) {
    runLinuxKeyringRecoveryOperation('write', account, payload);
  },
  remove(account) {
    runLinuxKeyringRecoveryOperation('remove', account);
  },
};

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd()): AuthStorageOptions {
  const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
  return baseDir ? { baseDir } : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  if (override) return override;
  return options.baseDir ?? getAgentPath('mcp-oauth');
}

/**
 * Get the legacy server-specific directory path.
 */
function getServerDir(serverName: string, options?: AuthStorageOptions): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const storageKey = getAuthEntryAccount(serverName);
  return join(getAuthBaseDir(options), storageKey);
}

function getAuthEntryAccount(serverName: string): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  return `sha256-${createHash('sha256').update(serverName, 'utf8').digest('hex')}`;
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: string, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), 'tokens.json');
}

/** Path of the encrypted credential file for a server. */
export function getAuthEntryEncFilePath(serverName: string, options?: AuthStorageOptions): string {
  return join(getAuthBaseDir(options), `${getAuthEntryAccount(serverName)}.enc`);
}

function isAuthEntryChunkManifest(value: unknown): value is AuthEntryChunkManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<AuthEntryChunkManifest>;
  return manifest[AUTH_CHUNK_MANIFEST_KEY] === 1
    && typeof manifest.chunkCount === 'number'
    && Number.isInteger(manifest.chunkCount)
    && manifest.chunkCount > 0
    && manifest.chunkCount <= 64 // 1800-byte chunks cover ~115KB of credentials; also bounds retirement work
    && typeof manifest.chunkDigest === 'string'
    && /^[a-f0-9]{16}$/.test(manifest.chunkDigest);
}

function getAuthEntryChunkAccount(account: string, manifest: AuthEntryChunkManifest, index: number): string {
  return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function getAuthEntryChunkAccounts(account: string, manifest: AuthEntryChunkManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) => getAuthEntryChunkAccount(account, manifest, index));
}

// --- Data encryption key (DEK) ------------------------------------------------
//
// One random 32-byte key shared by every server lives in the OS credential
// store as a single small item. OAuth payloads are AES-256-GCM encrypted with
// it and persisted as files, so the OS credential store is touched for exactly
// one item per install instead of one item per credential chunk.

interface EncryptedAuthEntryFile {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

let cachedDataEncryptionKey: { storeKind: string; key: Buffer } | undefined;

/**
 * Accounts whose corrupt legacy keyring entry could not be deleted (removal
 * denied/failed). Skipping them for the rest of the process prevents re-reading
 * — and on macOS re-prompting for — an item that will never parse. Absence is
 * deliberately NOT cached: probing an absent item never prompts, and a legacy
 * entry written later by a concurrently running pre-v5 process must stay
 * visible. The next process retries the deletion once.
 */
const pendingLegacyKeyringRetirement = new Set<string>();

/** Test-only hook: drop the in-process encryption-key and legacy-probe caches. */
export function __resetAuthEncryptionKeyCacheForTests(): void {
  cachedDataEncryptionKey = undefined;
  pendingLegacyKeyringRetirement.clear();
}

function getAuthStoreKind(): string {
  return process.env[TEST_AUTH_STORE_ENV] ?? 'keyring';
}

function decodeDataEncryptionKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : undefined;
}

function readDataEncryptionKeyFromStore(store: AuthSecretStore): Buffer | undefined {
  return decodeDataEncryptionKey(store.read(AUTH_DEK_ACCOUNT));
}

// --- DEK first-write lock ------------------------------------------------------
//
// Keyrings offer no compare-and-swap, so without exclusion two fresh processes
// can both observe "no key", generate different keys, and each encrypt files
// with a key the store no longer holds — permanently orphaning one side's
// credentials. The DEK keyring account is global per OS user, so the lock is
// global too: one mkdir lock in the per-user temp dir, NOT scoped to any
// configured oauthDir. Only the create path locks; reads of an existing key
// stay lock-free. The critical section is prompt-free (creating a new keychain
// item does not ACL-prompt), so holders finish in milliseconds.

const DEK_LOCK_SPIN_MS = 20;

function sleepBlocking(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getDataEncryptionKeyLockPath(): string {
  // Per-user: tmpdir is user-private on macOS/Windows; the uid suffix keeps it
  // private on multi-user Linux /tmp. Matches the per-user keyring account.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `pi-mcp-adapter-${uid}.dek.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function withDataEncryptionKeyLock<T>(fn: () => T): T {
  const lockPath = getDataEncryptionKeyLockPath();
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const tokenPath = join(lockPath, 'owner');
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(tokenPath, token);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Another process holds it. Break the lock only when the holder is dead —
    // never steal from a live holder, no matter how long it takes.
    try {
      const owner = readFileSync(tokenPath, 'utf8');
      const ownerPid = Number.parseInt(owner.split('.')[0] ?? '', 10);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      // Holder alive but lock abandoned without a token (died between mkdir and
      // token write): only break once it is clearly stale.
      if (!owner && Date.now() - statSync(lockPath).mtimeMs > 60_000) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      // Lock or token vanished mid-check: retry immediately.
      continue;
    }
    sleepBlocking(DEK_LOCK_SPIN_MS);
  }
  try {
    return fn();
  } finally {
    // Owned release: never delete a replacement holder's lock.
    try {
      if (readFileSync(tokenPath, 'utf8') === token) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock already gone.
    }
  }
}

function getOrCreateDataEncryptionKeyInStore(store: AuthSecretStore): Buffer {
  const existing = readDataEncryptionKeyFromStore(store);
  if (existing) return existing;
  return withDataEncryptionKeyLock(() => {
    // Another process may have created the key while we waited for the lock.
    const recheck = readDataEncryptionKeyFromStore(store);
    if (recheck) return recheck;
    const generated = randomBytes(32);
    store.write(AUTH_DEK_ACCOUNT, generated.toString('base64'));
    // Read back so the common concurrent-first-write case settles on the stored key.
    return readDataEncryptionKeyFromStore(store) ?? generated;
  });
}

/**
 * Resolve the DEK through the OS credential store. Fails closed (throws
 * OAuthCredentialStoreError) when the store is unavailable; returns undefined
 * only when the store works but no key has been created yet.
 */
function getDataEncryptionKey(create: boolean): Buffer | undefined {
  const storeKind = getAuthStoreKind();
  if (cachedDataEncryptionKey?.storeKind === storeKind) return cachedDataEncryptionKey.key;
  let key: Buffer | undefined;
  try {
    key = create
      ? getOrCreateDataEncryptionKeyInStore(getAuthSecretStore())
      : readDataEncryptionKeyFromStore(getAuthSecretStore());
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) {
      throw new OAuthCredentialStoreError(
        `Failed to access the OS secure credential store for OAuth credential encryption${keyringAccessGuidance()}`,
        create ? 'write' : 'read',
        error,
      );
    }
    try {
      key = create
        ? getOrCreateDataEncryptionKeyInStore(linuxKeyringRecoveryAuthSecretStore)
        : readDataEncryptionKeyFromStore(linuxKeyringRecoveryAuthSecretStore);
    } catch (recoveryError) {
      throw new OAuthCredentialStoreError(
        `Failed to access the OS secure credential store for OAuth credential encryption${keyringAccessGuidance()}`,
        create ? 'write' : 'read',
        recoveryError,
      );
    }
  }
  if (key) cachedDataEncryptionKey = { storeKind, key };
  return key;
}

function encryptAuthEntryPayload(key: Buffer, payload: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const file: EncryptedAuthEntryFile = {
    v: AUTH_ENCRYPTED_FILE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return JSON.stringify(file);
}

function decryptAuthEntryPayload(key: Buffer, raw: string): string {
  const file = JSON.parse(raw) as Partial<EncryptedAuthEntryFile>;
  if (file.v !== AUTH_ENCRYPTED_FILE_VERSION
    || typeof file.iv !== 'string'
    || typeof file.tag !== 'string'
    || typeof file.data !== 'string') {
    throw new Error('not a v1 encrypted OAuth entry');
  }
  const iv = Buffer.from(file.iv, 'base64');
  const tag = Buffer.from(file.tag, 'base64');
  // Node accepts GCM tags as short as 4 bytes unless told otherwise; enforce
  // the full 96-bit nonce / 128-bit tag this module writes.
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('encrypted OAuth entry has invalid nonce or tag length');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Read the encrypted entry for a server. Returns undefined when no file exists,
 * when the DEK is gone (credentials unrecoverable, re-authenticate), or when
 * the file is corrupt or tampered with. Store failures throw (fail closed).
 */
function readEncryptedAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const filePath = getAuthEntryEncFilePath(serverName, options);
  if (!existsSync(filePath)) return undefined;
  const key = getDataEncryptionKey(false);
  if (!key) return undefined;
  try {
    return JSON.parse(decryptAuthEntryPayload(key, readFileSync(filePath, 'utf-8'))) as AuthEntry;
  } catch {
    return undefined;
  }
}

function writeEncryptedAuthEntry(serverName: string, entry: AuthEntry, options?: AuthStorageOptions): void {
  // Resolve the key first: when the OS credential store is unavailable we must
  // fail before any file is written (never fall back to plaintext).
  const key = getDataEncryptionKey(true);
  if (!key) {
    throw new OAuthCredentialStoreError(
      `Failed to write OAuth credentials for ${serverName}: the OS secure credential store has no usable encryption key${keyringAccessGuidance()}`,
      'write',
      undefined,
    );
  }
  const filePath = getAuthEntryEncFilePath(serverName, options);
  // Unpredictable name + O_EXCL create: a pre-placed symlink or file can never
  // be followed or reused, and 0600 applies before any secret bytes hit disk.
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(tmpPath, encryptAuthEntryPayload(key, JSON.stringify(entry)), { mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw new OAuthCredentialStoreError(
      `Failed to write OAuth credentials for ${serverName} to encrypted credential storage`,
      'write',
      error,
    );
  }
}

function removeEncryptedAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  const filePath = getAuthEntryEncFilePath(serverName, options);
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from encrypted credential storage`,
      'remove',
      error,
    );
  }
}

// --- Legacy keyring entries (migration source only) ----------------------------
//
// Entries written before encrypted-file storage: a single keyring item, or a
// manifest item plus N chunk items (Windows Credential Manager size limit).
// These are only read for one-way import and then deleted.

function legacyRetirementCacheKey(account: string): string {
  return `${getAuthStoreKind()}:${account}`;
}

/**
 * Retire a corrupt legacy entry: best-effort delete so it is never read (and on
 * macOS never prompted for) again. Only a FAILED deletion is cached in-process
 * — a successfully deleted item is absent, and probing an absent item never
 * prompts.
 */
function retireLegacyKeyringAuthEntry(store: AuthSecretStore, serverName: string, account: string): void {
  try {
    removeLegacyKeyringAuthEntry(store, serverName);
  } catch {
    pendingLegacyKeyringRetirement.add(legacyRetirementCacheKey(account));
  }
}

/** Valid legacy payloads are plain objects; null/false/0/''/arrays are corruption. */
function isLegacyAuthEntryShape(value: unknown): value is AuthEntry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLegacyKeyringAuthEntry(store: AuthSecretStore, serverName: string): AuthEntry | undefined {
  const account = getAuthEntryAccount(serverName);
  if (pendingLegacyKeyringRetirement.has(legacyRetirementCacheKey(account))) return undefined;
  const readAccount = (name: string): string | undefined => {
    try {
      return store.read(name);
    } catch (error) {
      throw new OAuthCredentialStoreError(
        `Failed to read OAuth credentials for ${serverName} from the OS secure credential store${keyringAccessGuidance()}`,
        'read',
        error,
      );
    }
  };

  const payload = readAccount(account);
  if (payload === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    retireLegacyKeyringAuthEntry(store, serverName, account);
    return undefined;
  }
  if (!isAuthEntryChunkManifest(parsed)) {
    // Manifest-shaped but invalid (e.g. absurd chunkCount): corrupt, not credentials.
    if (isLegacyAuthEntryShape(parsed) && (parsed as Record<string, unknown>)[AUTH_CHUNK_MANIFEST_KEY] === 1) {
      retireLegacyKeyringAuthEntry(store, serverName, account);
      return undefined;
    }
    if (!isLegacyAuthEntryShape(parsed)) {
      retireLegacyKeyringAuthEntry(store, serverName, account);
      return undefined;
    }
    return parsed;
  }

  const chunks: string[] = [];
  for (const chunkAccount of getAuthEntryChunkAccounts(account, parsed)) {
    const chunk = readAccount(chunkAccount);
    if (chunk === undefined) {
      retireLegacyKeyringAuthEntry(store, serverName, account);
      return undefined; // Partial chunk set: unauthenticated, never crash.
    }
    chunks.push(chunk);
  }
  const assembled = chunks.join('');
  const digest = createHash('sha256').update(assembled, 'utf8').digest('hex').slice(0, 16);
  if (digest !== parsed.chunkDigest) {
    retireLegacyKeyringAuthEntry(store, serverName, account);
    return undefined; // Chunk contents do not match the manifest: unauthenticated.
  }
  let assembledEntry: unknown;
  try {
    assembledEntry = JSON.parse(assembled);
  } catch {
    retireLegacyKeyringAuthEntry(store, serverName, account);
    return undefined;
  }
  if (!isLegacyAuthEntryShape(assembledEntry)) {
    retireLegacyKeyringAuthEntry(store, serverName, account);
    return undefined;
  }
  return assembledEntry;
}

function removeLegacyKeyringAuthEntry(store: AuthSecretStore, serverName: string): void {
  const account = getAuthEntryAccount(serverName);
  let payload: string | undefined;
  try {
    payload = store.read(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the OS secure credential store${keyringAccessGuidance()}`,
      'remove',
      error,
    );
  }
  if (payload === undefined) return;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isAuthEntryChunkManifest(parsed)) {
      for (const chunkAccount of getAuthEntryChunkAccounts(account, parsed)) {
        try {
          store.remove(chunkAccount);
        } catch {
          // Orphaned chunks are never read again once the manifest item is gone.
        }
      }
    }
  } catch {
    // An unparseable main item is still removed below.
  }
  try {
    store.remove(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the OS secure credential store${keyringAccessGuidance()}`,
      'remove',
      error,
    );
  }
}

function readLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as AuthEntry;
  } catch {
    return undefined; // Corrupt legacy plaintext: unauthenticated, never crash.
  }
}

/**
 * Plaintext cleanup on read paths is best-effort: the encrypted file is
 * canonical, the removal is retried on the next read, and a stuck legacy file
 * must never throw through status inspection.
 */
function tryRemoveLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  try {
    removeLegacyAuthEntry(serverName, options);
  } catch {
    // Retried on the next read.
  }
}

function removeLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) return;
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(`Failed to remove legacy plaintext OAuth credentials for ${serverName} at ${filePath}`, { cause: error });
  }

  const dir = getServerDir(serverName, options);
  try {
    rmSync(dir, { recursive: true });
  } catch {
    // Directory may contain future non-secret metadata; the plaintext file was already removed.
  }
}

/**
 * Read the auth entry for a server: encrypted file first, then one-way import
 * of legacy keyring entries (chunked or single-item) and legacy plaintext
 * tokens.json. Successful imports are re-persisted as encrypted files and the
 * legacy records are removed; legacy cleanup failure never fails the read, so
 * keychain prompts can never loop. Every read migrates — including status-only
 * inspection — because skipping migration would re-read (and on macOS
 * re-prompt for) the legacy keychain items on every status refresh.
 */
function readAuthEntryFromStore(
  store: AuthSecretStore,
  serverName: string,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  const encrypted = readEncryptedAuthEntry(serverName, options);
  if (encrypted) {
    tryRemoveLegacyAuthEntry(serverName, options);
    return encrypted;
  }

  const legacyKeyringEntry = readLegacyKeyringAuthEntry(store, serverName);
  if (legacyKeyringEntry) {
    writeEncryptedAuthEntry(serverName, legacyKeyringEntry, options);
    try {
      removeLegacyKeyringAuthEntry(store, serverName);
    } catch {
      // The encrypted file is canonical now; leftover legacy items are never
      // read again, so cleanup failure must not fail authentication.
    }
    tryRemoveLegacyAuthEntry(serverName, options);
    return legacyKeyringEntry;
  }

  const legacyEntry = readLegacyAuthEntry(serverName, options);
  if (!legacyEntry) return undefined;
  writeEncryptedAuthEntry(serverName, legacyEntry, options);
  tryRemoveLegacyAuthEntry(serverName, options);
  return legacyEntry;
}

function readAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
): AuthEntry | undefined {
  try {
    return readAuthEntryFromStore(getAuthSecretStore(), serverName, options);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
    return readAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName, options);
  }
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  return readAuthEntry(serverName, options);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(serverName: string, serverUrl: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const entry = getAuthEntry(serverName, options);
  if (!entry) return undefined;

  // If no serverUrl is stored, this is from an old version - consider it invalid
  if (!entry.serverUrl) return undefined;

  // If URL has changed, credentials are invalid
  if (entry.serverUrl !== serverUrl) return undefined;

  return entry;
}

/**
 * Inspect credentials for status-only UI paths without treating an unavailable
 * secure store as missing credentials. Reads migrate legacy storage like any
 * other read (otherwise every status refresh would re-read — and on macOS
 * re-prompt for — legacy keychain items). Authentication operations continue
 * to use getAuthForUrl() directly and therefore remain fail-closed.
 */
export function inspectAuthForUrl(
  serverName: string,
  serverUrl: string,
  options?: AuthStorageOptions,
): OAuthCredentialStatus {
  try {
    const entry = readAuthEntry(serverName, options);
    if (!entry?.serverUrl || entry.serverUrl !== serverUrl) return { status: 'absent' };
    return { status: 'present', entry };
  } catch (error) {
    if (!(error instanceof OAuthCredentialStoreError)) throw error;
    return { status: 'unavailable', message: formatOAuthCredentialStoreUnavailable(error) };
  }
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string, options?: AuthStorageOptions): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeEncryptedAuthEntry(serverName, entry, options);
  removeLegacyAuthEntry(serverName, options);
}

/**
 * Remove auth entry for a server: the encrypted file, any legacy keyring
 * items, and any legacy plaintext file.
 */
export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  // The encrypted file is the canonical credential and needs no keyring access:
  // remove it first so logout still works when the OS credential store is down.
  removeEncryptedAuthEntry(serverName, options);
  try {
    removeLegacyKeyringAuthEntry(getAuthSecretStore(), serverName);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
    removeLegacyKeyringAuthEntry(linuxKeyringRecoveryAuthSecretStore, serverName);
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
  options?: AuthStorageOptions
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
  options?: AuthStorageOptions
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
export function getOAuthState(serverName: string, options?: AuthStorageOptions): string | undefined {
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
