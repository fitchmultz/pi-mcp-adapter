import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

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
 * Contention throws immediately. All participants must use the same persistent
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
    database.exec("BEGIN IMMEDIATE");
    acquired = true;
    return operation();
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    releaseStorageLock(database, acquired, primary);
  }
}
