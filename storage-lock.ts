import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export class StorageLockBusyError extends Error {
  override readonly name = "StorageLockBusyError";

  constructor(lockPath: string, cause: unknown) {
    super(`Storage lock is busy: ${lockPath}`, { cause });
  }
}

function acquireStorageLock(
  database: DatabaseSync,
  lockPath: string,
  mode: "read" | "write",
): void {
  try {
    if (mode === "read") {
      // DEFERRED alone takes no lock. Reading the schema also locks an empty database.
      database.exec("BEGIN DEFERRED; SELECT name FROM sqlite_schema");
    } else {
      database.exec("BEGIN EXCLUSIVE");
    }
  } catch (error) {
    if (mode === "read") {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Ignore if BEGIN DEFERRED itself failed or no transaction remained open.
      }
    }
    // SQLite extended result codes retain the primary result in the low byte.
    if (
      error instanceof Error &&
      "errcode" in error &&
      typeof error.errcode === "number" &&
      (error.errcode & 0xff) === 5
    ) {
      throw new StorageLockBusyError(lockPath, error);
    }
    throw error;
  }
}

function releaseStorageLock(
  database: DatabaseSync,
  acquired: boolean,
  primary: { error: unknown } | undefined,
): void {
  const errors: unknown[] = [];
  if (acquired) {
    try {
      database.exec("ROLLBACK");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    database.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    if (primary) {
      errors.unshift(primary.error);
    }
    throw new AggregateError(errors, "Storage lock cleanup failed", { cause: errors[0] });
  }
}

export interface StorageLockOptions {
  mode?: "read" | "write";
  timeoutMs?: number;
}

export interface AsyncStorageLockOptions {
  mode?: "read" | "write";
  timeoutMs: number;
  initialPollMs: number;
  maxPollMs: number;
  /** Keep the event loop alive while polling (default: true for CLI/standalone credential callers; pass false for background waits). */
  ref?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

async function waitForStorageLock(
  database: DatabaseSync,
  lockPath: string,
  options: AsyncStorageLockOptions,
): Promise<void> {
  const mode = options.mode ?? "write";
  const deadline = Date.now() + options.timeoutMs;
  let pollMs = options.initialPollMs;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      acquireStorageLock(database, lockPath, mode);
      return;
    } catch (error) {
      if (!(error instanceof StorageLockBusyError) || Date.now() >= deadline) {
        throw error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new StorageLockBusyError(lockPath, new Error("Storage lock wait timeout elapsed"));
    }
    // Small random jitter spreads wakeups when several processes contend on the same lock.
    const jitter = Math.floor(Math.random() * 15);
    const waitMs = Math.min(remainingMs, pollMs + jitter);
    await delay(waitMs, undefined, {
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    pollMs = Math.min(options.maxPollMs, Math.ceil(pollMs * 1.5));
  }
}

/**
 * Runs an asynchronous operation under a SQLite OS file lock without blocking the event loop
 * during lock contention. Throws StorageLockBusyError when timeoutMs elapses without acquiring.
 */
export async function withAsyncStorageLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: AsyncStorageLockOptions,
): Promise<T> {
  options.signal?.throwIfAborted();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  // Omit DatabaseSync timeout so contention yields via async polling instead of blocking the thread.
  const database = new DatabaseSync(lockPath);
  let acquired = false;
  let primary: { error: unknown } | undefined;
  try {
    chmodSync(lockPath, 0o600);
    await waitForStorageLock(database, lockPath, options);
    acquired = true;
    return await operation();
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    releaseStorageLock(database, acquired, primary);
  }
}

/**
 * Runs a synchronous operation under a shared read or exclusive write transaction.
 * Acquisition contention throws StorageLockBusyError after any configured busy timeout;
 * operation errors pass through.
 * All participants must use the same persistent
 * lock path; never unlink, replace, or open/close that database outside SQLite.
 */
export function withStorageLock<T>(
  lockPath: string,
  operation: () => T,
  modeOrOptions: "read" | "write" | StorageLockOptions = "write",
): T {
  const mode = typeof modeOrOptions === "string" ? modeOrOptions : (modeOrOptions.mode ?? "write");
  const timeoutMs = typeof modeOrOptions === "string" ? 0 : (modeOrOptions.timeoutMs ?? 0);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const database =
    timeoutMs > 0 ? new DatabaseSync(lockPath, { timeout: timeoutMs }) : new DatabaseSync(lockPath);
  let acquired = false;
  let primary: { error: unknown } | undefined;
  try {
    chmodSync(lockPath, 0o600);
    acquireStorageLock(database, lockPath, mode);
    acquired = true;
    return operation();
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    releaseStorageLock(database, acquired, primary);
  }
}
