/**
 * SDK-free OAuth token caching and intra-/cross-process refresh serialization.
 */

import { hash } from "node:crypto";
import { join } from "node:path";
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
import { StorageLockBusyError, withAsyncStorageLock } from "./storage-lock.ts";

// Wide enough for one slow token-endpoint round trip plus clock skew while keeping hourly tokens valid >98% of their lifetime.
export const PROACTIVE_REFRESH_MARGIN_SECONDS = 60;
// Caps in-memory reuse for opaque tokens lacking expires_in so cross-session rotation is observed within a minute.
const TOKEN_CACHE_TTL_MS = 60_000;
// Bounds wait for another process's OAuth discovery + token POST without hanging interactive calls indefinitely.
const REFRESH_LOCK_WAIT_MS = 15_000;
// Fast initial retry (25ms) picks up rotated tokens right after typical 100-300ms exchanges; 100ms cap keeps polling light.
const INITIAL_LOCK_POLL_MS = 25;
const MAX_LOCK_POLL_MS = 100;
// Suppresses repeated proactive refresh attempts for 30s after a transient error while the current access token remains valid.
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

/**
 * Cross-process refresh lock backed by a dedicated SQLite OS file lock under the credential lock
 * directory (separate from the credential-store lock so reads/writes never wait on network I/O).
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
  const digest = hash("sha256", JSON.stringify([identity.serverName, identity.serverUrl]), "hex");
  const lockPath = join(getAuthLockDir(), `refresh-${digest}.sqlite`);
  return withAsyncStorageLock(lockPath, operation, {
    mode: "write",
    timeoutMs: REFRESH_LOCK_WAIT_MS,
    initialPollMs: INITIAL_LOCK_POLL_MS,
    maxPollMs: MAX_LOCK_POLL_MS,
    signal,
  });
}

interface RefreshBaseline {
  readonly accessToken?: string | undefined;
  readonly expiresAt?: number | undefined;
}

function isProactiveTokenFresh(
  tokens: StoredTokens,
  identity: AuthIdentity,
  baseline: RefreshBaseline,
): boolean {
  if (!needsProactiveRefresh(tokens) || isWithinProactiveCooldown(identity)) {
    return true;
  }
  if (baseline.accessToken !== undefined && tokens.accessToken !== baseline.accessToken) {
    return true;
  }
  return (
    baseline.expiresAt !== undefined &&
    tokens.expiresAt !== undefined &&
    tokens.expiresAt > baseline.expiresAt
  );
}

function adoptFreshToken(
  tokens: StoredTokens | undefined,
  options: Pick<CoordinateOAuthRefreshOptions, "identity" | "rejectedAccessToken" | "proactive">,
  baseline: RefreshBaseline,
): boolean {
  if (!tokens || tokens.accessToken === "" || isTokenExpired(tokens)) {
    return false;
  }
  if (options.proactive === true) {
    if (!isProactiveTokenFresh(tokens, options.identity, baseline)) {
      return false;
    }
    if (!isWithinProactiveCooldown(options.identity)) {
      recordProactiveRefreshOutcome(options.identity, "refreshed", tokens);
    }
    return true;
  }
  if (options.rejectedAccessToken !== undefined) {
    return tokens.accessToken !== options.rejectedAccessToken;
  }
  return true;
}

async function runLockedRefresh(
  options: CoordinateOAuthRefreshOptions,
  refreshSignal: AbortSignal,
  baseline: RefreshBaseline,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const afterLock = options.provider.reloadTokensFromStorage();
  if (adoptFreshToken(afterLock, options, baseline)) {
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
    return adoptFreshToken(recovered, options, baseline) ? "AUTHORIZED" : outcome;
  } catch (error) {
    if (options.isUnauthorizedError(error)) {
      const recovered = options.provider.reloadTokensFromStorage();
      if (adoptFreshToken(recovered, options, baseline)) {
        return "AUTHORIZED";
      }
    }
    throw error;
  }
}

async function executeSerializedRefresh(
  options: CoordinateOAuthRefreshOptions,
  refreshSignal: AbortSignal,
  baseline: RefreshBaseline,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  try {
    return await withCrossProcessRefreshLock(options.identity, refreshSignal, () =>
      runLockedRefresh(options, refreshSignal, baseline),
    );
  } catch (error) {
    if (error instanceof StorageLockBusyError) {
      const recovered = options.provider.reloadTokensFromStorage();
      if (adoptFreshToken(recovered, options, baseline)) {
        return "AUTHORIZED";
      }
    }
    throw error;
  }
}

function initialRefreshBaseline(options: CoordinateOAuthRefreshOptions): RefreshBaseline {
  if (options.proactive !== true) {
    return { accessToken: options.rejectedAccessToken };
  }
  const cached = options.provider.currentCachedTokens;
  return {
    accessToken: options.rejectedAccessToken ?? cached?.accessToken,
    expiresAt: cached?.expiresAt,
  };
}

/**
 * Serialize OAuth token refresh per (serverName, serverUrl) across both concurrent
 * requests in one Pi process and concurrent Pi processes sharing Keychain storage.
 */
export async function coordinateOAuthRefresh(
  options: CoordinateOAuthRefreshOptions,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  throwIfAborted(options.signal);
  const baseline = initialRefreshBaseline(options);
  const key = refreshKey(options.identity);
  const existing = inFlightRefreshes.get(key);
  if (existing) {
    const outcome = await existing.wait(options.signal);
    const reloaded = options.provider.reloadTokensFromStorage();
    if (outcome !== "AUTHORIZED" || adoptFreshToken(reloaded, options, baseline)) {
      return outcome;
    }
  }
  const beforeLock = options.provider.reloadTokensFromStorage();
  if (adoptFreshToken(beforeLock, options, baseline)) {
    return "AUTHORIZED";
  }
  const effectiveBaseline: RefreshBaseline = {
    accessToken: baseline.accessToken ?? beforeLock?.accessToken,
    expiresAt: baseline.expiresAt ?? beforeLock?.expiresAt,
  };
  const entry = new InFlightRefresh((refreshSignal) =>
    executeSerializedRefresh(options, refreshSignal, effectiveBaseline).finally(() => {
      if (inFlightRefreshes.get(key) === entry) {
        inFlightRefreshes.delete(key);
      }
    }),
  );
  inFlightRefreshes.set(key, entry);
  return entry.wait(options.signal);
}
