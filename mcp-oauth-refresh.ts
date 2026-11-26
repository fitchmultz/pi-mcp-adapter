/**
 * SDK-free OAuth token caching and intra-/cross-process refresh serialization.
 */

import { hash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { abortable, throwIfAborted } from "./abort.ts";
import { getAuthLockDir, isProcessLocalAuthStore } from "./keyring-store.ts";
import {
  getAuthForUrl,
  getAuthStorageRevision,
  type AuthIdentity,
  type AuthStorageOptions,
  type StoredTokens,
  type TokenSnapshot,
} from "./mcp-auth.ts";
import { isTokenExpired } from "./auth-record-types.ts";

export const PROACTIVE_REFRESH_MARGIN_SECONDS = 60;
const TOKEN_CACHE_TTL_MS = 60_000;
const REFRESH_LOCK_WAIT_MS = 15_000;
const STALE_LOCK_MS = 30_000;
const CORRUPT_LOCK_GRACE_MS = 5_000;
const INITIAL_LOCK_POLL_MS = 25;
const MAX_LOCK_POLL_MS = 100;
const PROACTIVE_FAILURE_COOLDOWN_MS = 30_000;

interface CachedTokenEntry {
  readonly tokens: StoredTokens;
  readonly cachedAt: number;
  readonly revision: number;
}

class InFlightRefresh {
  readonly controller = new AbortController();
  readonly promise: Promise<"AUTHORIZED" | "REDIRECT">;
  private waiters = 0;

  constructor(start: (signal: AbortSignal) => Promise<"AUTHORIZED" | "REDIRECT">) {
    this.promise = start(this.controller.signal);
    // Callers observe promise via abortable(); retain rejection ownership if all waiters abort.
    this.promise.catch(() => {
      // Rejections are surfaced to active waiters through wait().
    });
  }

  async wait(signal: AbortSignal | undefined): Promise<"AUTHORIZED" | "REDIRECT"> {
    this.waiters += 1;
    try {
      return await abortable(this.promise, signal);
    } finally {
      this.waiters -= 1;
      if (this.waiters === 0 && signal?.aborted === true) {
        this.controller.abort(signal.reason);
      }
    }
  }
}

export interface RefreshTokenTarget {
  readonly currentCachedTokens: StoredTokens | undefined;
  reloadTokensFromStorage: () => StoredTokens | undefined;
}

export interface CoordinateOAuthRefreshOptions {
  readonly identity: AuthIdentity;
  readonly provider: RefreshTokenTarget;
  readonly rejectedAccessToken?: string | undefined;
  readonly proactive?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly isUnauthorizedError: (error: unknown) => boolean;
  readonly runRefresh: (refreshSignal: AbortSignal) => Promise<"AUTHORIZED" | "REDIRECT">;
}

const inFlightRefreshes = new Map<string, InFlightRefresh>();
const proactiveCooldownUntil = new Map<string, number>();

function refreshKey(identity: AuthIdentity): string {
  return JSON.stringify([identity.serverName, identity.serverUrl]);
}

function isWithinProactiveCooldown(identity: AuthIdentity, nowMs = Date.now()): boolean {
  const until = proactiveCooldownUntil.get(refreshKey(identity));
  return until !== undefined && nowMs < until;
}

export function needsProactiveRefresh(
  tokens: { readonly refreshToken?: string | undefined; readonly expiresAt?: number | undefined },
  nowSeconds = Date.now() / 1000,
): boolean {
  return (
    tokens.refreshToken !== undefined &&
    tokens.refreshToken !== "" &&
    tokens.expiresAt !== undefined &&
    tokens.expiresAt !== 0 &&
    tokens.expiresAt <= nowSeconds + PROACTIVE_REFRESH_MARGIN_SECONDS
  );
}

export function shouldAttemptProactiveRefresh(
  identity: AuthIdentity,
  tokens: { readonly refresh_token?: string | undefined; readonly expires_in?: number | undefined },
): boolean {
  if (
    tokens.refresh_token === undefined ||
    tokens.refresh_token === "" ||
    tokens.expires_in === undefined ||
    tokens.expires_in > PROACTIVE_REFRESH_MARGIN_SECONDS
  ) {
    return false;
  }
  return !isWithinProactiveCooldown(identity);
}

export function recordProactiveRefreshOutcome(
  identity: AuthIdentity,
  outcome: "refreshed" | "failed",
  tokens?: StoredTokens,
): void {
  const key = refreshKey(identity);
  if (outcome === "failed") {
    proactiveCooldownUntil.set(key, Date.now() + PROACTIVE_FAILURE_COOLDOWN_MS);
    return;
  }
  if (tokens?.expiresAt !== undefined && tokens.expiresAt !== 0) {
    const remainingSeconds = tokens.expiresAt - Date.now() / 1000;
    if (remainingSeconds > 0 && remainingSeconds <= PROACTIVE_REFRESH_MARGIN_SECONDS) {
      // Short-lived tokens (<= 60s) wait half their lifetime before another proactive refresh.
      proactiveCooldownUntil.set(key, Date.now() + Math.max(1000, remainingSeconds * 500));
      return;
    }
  }
  proactiveCooldownUntil.delete(key);
}

function isCacheEntryFresh(identity: AuthIdentity, entry: CachedTokenEntry): boolean {
  const { tokens, cachedAt } = entry;
  if (tokens.expiresAt === undefined || tokens.expiresAt === 0) {
    return Date.now() - cachedAt < TOKEN_CACHE_TTL_MS;
  }
  const remaining = tokens.expiresAt - Date.now() / 1000;
  if (remaining <= 0) {
    return false;
  }
  if (tokens.refreshToken === undefined || tokens.refreshToken === "") {
    return true;
  }
  if (remaining > PROACTIVE_REFRESH_MARGIN_SECONDS) {
    return true;
  }
  return (
    isWithinProactiveCooldown(identity) &&
    Date.now() - cachedAt < Math.min(10_000, (remaining * 1000) / 2)
  );
}

/** Per-provider in-memory token cache and compare-and-swap invalidation snapshot. */
export class ProviderTokenCache {
  private cached: CachedTokenEntry | undefined;
  private snapshot: TokenSnapshot | undefined;

  get lastObserved(): TokenSnapshot | undefined {
    return this.snapshot;
  }

  get currentCachedTokens(): StoredTokens | undefined {
    return this.cached?.tokens;
  }

  getFresh(identity: AuthIdentity): StoredTokens | undefined {
    if (
      !this.cached ||
      this.cached.revision !== getAuthStorageRevision(identity) ||
      !isCacheEntryFresh(identity, this.cached)
    ) {
      return undefined;
    }
    return this.cached.tokens;
  }

  record(identity: AuthIdentity, tokens: StoredTokens): void {
    this.cached = {
      tokens,
      cachedAt: Date.now(),
      revision: getAuthStorageRevision(identity),
    };
    this.snapshot = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  invalidate(): void {
    this.cached = undefined;
  }

  clearAll(): void {
    this.cached = undefined;
    this.snapshot = undefined;
  }

  takeSnapshot(): TokenSnapshot | undefined {
    const current = this.snapshot;
    this.cached = undefined;
    this.snapshot = undefined;
    return current;
  }

  reload(identity: AuthIdentity, storageOptions: AuthStorageOptions): StoredTokens | undefined {
    this.cached = undefined;
    const tokens = getAuthForUrl(identity, storageOptions)?.tokens;
    if (tokens) {
      this.record(identity, tokens);
    } else {
      this.snapshot = undefined;
    }
    return tokens;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readNumberField(record: object, key: string): number | undefined {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "number" ? value : undefined;
}

function readStringField(record: object, key: string): string | undefined {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
}

function parseLockPayload(
  raw: string,
): { pid?: number; token?: string; acquiredAt?: number } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const pid = readNumberField(value, "pid");
    const token = readStringField(value, "token");
    const acquiredAt = readNumberField(value, "acquiredAt");
    return {
      ...(pid !== undefined ? { pid } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(acquiredAt !== undefined ? { acquiredAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function isProcessGone(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrorCode(error, "ESRCH");
  }
}

async function tryAcquireLockFile(lockPath: string, token: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
      "utf8",
    );
  } catch (error) {
    await handle.close().catch(() => {
      // Preserve the write failure after best-effort close.
    });
    await rm(lockPath, { force: true }).catch(() => {
      // Preserve the write failure after best-effort unlink.
    });
    throw error;
  }
  await handle.close();
  return true;
}

async function reapStaleLockFile(lockPath: string): Promise<boolean> {
  try {
    const [raw, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const payload = parseLockPayload(raw);
    const now = Date.now();
    const staleByPid = payload?.pid !== undefined && isProcessGone(payload.pid);
    const staleByAge =
      payload?.acquiredAt !== undefined && now - payload.acquiredAt > STALE_LOCK_MS;
    const staleCorrupt = payload === undefined && now - info.mtimeMs > CORRUPT_LOCK_GRACE_MS;
    if (!staleByPid && !staleByAge && !staleCorrupt) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function releaseLockFile(lockPath: string, token: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf8");
    if (parseLockPayload(raw)?.token === token) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Lock file was already removed or superseded.
  }
}

async function acquireCrossProcessLock(
  lockPath: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  let pollMs = INITIAL_LOCK_POLL_MS;
  for (;;) {
    throwIfAborted(signal);
    if (await tryAcquireLockFile(lockPath, token)) {
      return true;
    }
    if (await reapStaleLockFile(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    const jitter = Math.floor(Math.random() * 15);
    await abortable(delay(pollMs + jitter, undefined, { ref: false }), signal);
    pollMs = Math.min(MAX_LOCK_POLL_MS, Math.ceil(pollMs * 1.5));
  }
}

/**
 * Async cross-process refresh lockfile under the credential lock directory.
 * Never holds a synchronous SQLite transaction across network I/O.
 */
export async function withCrossProcessRefreshLock<T>(
  identity: AuthIdentity,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (isProcessLocalAuthStore()) {
    return operation();
  }
  const lockDir = getAuthLockDir();
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const digest = hash("sha256", JSON.stringify([identity.serverName, identity.serverUrl]), "hex");
  const lockPath = join(lockDir, `refresh-${digest}.lock`);
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const acquired = await acquireCrossProcessLock(lockPath, token, signal);
  try {
    return await operation();
  } finally {
    if (acquired) {
      await releaseLockFile(lockPath, token);
    }
  }
}

function hasAdoptedFreshToken(
  tokens: StoredTokens | undefined,
  options: Pick<CoordinateOAuthRefreshOptions, "rejectedAccessToken" | "proactive">,
): boolean {
  if (!tokens || tokens.accessToken === "" || isTokenExpired(tokens)) {
    return false;
  }
  if (options.proactive === true) {
    return !needsProactiveRefresh(tokens);
  }
  if (options.rejectedAccessToken !== undefined) {
    return tokens.accessToken !== options.rejectedAccessToken;
  }
  return true;
}

async function executeSerializedRefresh(
  options: CoordinateOAuthRefreshOptions,
  refreshSignal: AbortSignal,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return withCrossProcessRefreshLock(options.identity, refreshSignal, async () => {
    const afterLock = options.provider.reloadTokensFromStorage();
    if (hasAdoptedFreshToken(afterLock, options)) {
      return "AUTHORIZED";
    }
    try {
      const outcome = await options.runRefresh(refreshSignal);
      if (outcome === "AUTHORIZED") {
        const latest =
          options.provider.currentCachedTokens ?? options.provider.reloadTokensFromStorage();
        recordProactiveRefreshOutcome(options.identity, "refreshed", latest);
        return "AUTHORIZED";
      }
      const recovered = options.provider.reloadTokensFromStorage();
      return hasAdoptedFreshToken(recovered, options) ? "AUTHORIZED" : outcome;
    } catch (error) {
      if (options.isUnauthorizedError(error)) {
        const recovered = options.provider.reloadTokensFromStorage();
        if (hasAdoptedFreshToken(recovered, options)) {
          return "AUTHORIZED";
        }
      }
      throw error;
    }
  });
}

/**
 * Serialize OAuth token refresh per (serverName, serverUrl) across both concurrent
 * requests in one Pi process and concurrent Pi processes sharing Keychain storage.
 */
export async function coordinateOAuthRefresh(
  options: CoordinateOAuthRefreshOptions,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  throwIfAborted(options.signal);
  const key = refreshKey(options.identity);
  const existing = inFlightRefreshes.get(key);
  if (existing) {
    const outcome = await existing.wait(options.signal);
    const reloaded = options.provider.reloadTokensFromStorage();
    if (outcome !== "AUTHORIZED" || hasAdoptedFreshToken(reloaded, options)) {
      return outcome;
    }
  }
  const beforeLock = options.provider.reloadTokensFromStorage();
  if (hasAdoptedFreshToken(beforeLock, options)) {
    return "AUTHORIZED";
  }
  const entry = new InFlightRefresh((refreshSignal) =>
    executeSerializedRefresh(options, refreshSignal).finally(() => {
      if (inFlightRefreshes.get(key) === entry) {
        inFlightRefreshes.delete(key);
      }
    }),
  );
  inFlightRefreshes.set(key, entry);
  return entry.wait(options.signal);
}
