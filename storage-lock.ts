import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class StorageLockBusyError extends Error {
  override readonly name = "StorageLockBusyError";

  constructor(lockPath: string, cause: unknown) {
    super(`Storage lock is busy: ${lockPath}`, { cause });
  }
}

function acquireStorageLock(database: DatabaseSync, lockPath: string): void {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
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

/**
 * Runs a synchronous operation under a cross-process SQLite write transaction.
 * Acquisition contention throws StorageLockBusyError; operation errors pass through.
 * All participants must use the same persistent
 * lock path; never unlink, replace, or open/close that database outside SQLite.
 */
export function withStorageLock<T>(lockPath: string, operation: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const database = new DatabaseSync(lockPath);
  let acquired = false;
  let primary: { error: unknown } | undefined;
  try {
    chmodSync(lockPath, 0o600);
    acquireStorageLock(database, lockPath);
    acquired = true;
    return operation();
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    releaseStorageLock(database, acquired, primary);
  }
}
