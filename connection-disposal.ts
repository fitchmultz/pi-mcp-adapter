import type { Client } from "@modelcontextprotocol/client";
import type { ManagedClient } from "./connection-runtime.ts";
import type { ServerConnection } from "./server-connection.ts";
import {
  clientOperations,
  drainClientCallbacks,
  drainClientOperations,
} from "./client-operations.ts";
import { logger } from "./logger.ts";

export function cleanupFailures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  return failures;
}

export function containsCleanupFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof AggregateError) {
      if (/cleanup failed|setup failed/.test(current.message)) {
        return true;
      }
      const errors: unknown[] = current.errors;
      pending.push(...errors);
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return false;
}

export class ConnectionDisposal {
  readonly retired = new Map<string, Set<ServerConnection>>();
  private readonly disposePromises = new WeakMap<ServerConnection, Promise<void>>();
  private readonly ownedClients = new Set<Client>();

  private readonly flushTrace: () => Promise<void> | undefined;

  constructor(flushTrace: () => Promise<void> | undefined) {
    this.flushTrace = flushTrace;
  }

  own(client: ManagedClient): void {
    this.ownedClients.add(client);
  }

  releaseWhenSettled(client: Client): void {
    if (!this.ownedClients.has(client)) {
      return;
    }
    drainClientOperations(client)
      .then(() => {
        this.ownedClients.delete(client);
      })
      .catch((error: unknown) => {
        // Failed drains stay owned for final shutdown.
        logger.debug(`MCP client drain failed: ${String(error)}`);
      });
  }

  markDisposed(connection: ServerConnection): void {
    this.disposePromises.set(connection, Promise.resolve());
  }

  retire(name: string, connection: ServerConnection): void {
    let retired = this.retired.get(name);
    if (!retired) {
      retired = new Set();
      this.retired.set(name, retired);
    }
    if (retired.has(connection)) {
      return;
    }
    retired.add(connection);
    this.finishRetirement(name, connection, retired).catch((error: unknown) => {
      // Keep failed retirement owned so explicit shutdown also reports it.
      logger.debug(`MCP retired connection cleanup failed for ${name}: ${String(error)}`);
    });
  }

  private async finishRetirement(
    name: string,
    connection: ServerConnection,
    retired: Set<ServerConnection>,
  ): Promise<void> {
    for (;;) {
      const pending = [...(clientOperations.get(connection.client) ?? [])]
        .filter(([, kind]) => kind !== "subscription")
        .map(([operation]) => operation);
      if (pending.length === 0) {
        break;
      }
      await Promise.allSettled(pending);
    }
    await this.dispose(connection);
    retired.delete(connection);
    if (retired.size === 0 && this.retired.get(name) === retired) {
      this.retired.delete(name);
    }
  }

  dispose(connection: ServerConnection): Promise<void> {
    const existing = this.disposePromises.get(connection);
    if (existing) {
      return existing;
    }
    const closing = (async () => {
      const results = await Promise.allSettled([
        // The SDK client owns its transport.
        Promise.resolve().then(() => connection.client.close()),
        this.flushTrace() ?? Promise.resolve(),
      ]);
      const failures = cleanupFailures(results);
      // Keep ordinary per-server cancellation prompt, but retain native send/auth tails for
      // readiness and final shutdown. Inbound handler promises still drain before disposal.
      await drainClientCallbacks(connection.client);
      if (failures.length > 0) {
        throw new AggregateError(failures, "MCP connection cleanup failed");
      }
      this.releaseWhenSettled(connection.client);
    })();
    this.disposePromises.set(connection, closing);
    closing.catch(() => {
      // Native close retains its transport until onclose. Retry only on an
      // explicit later close, retaining the connection/operations veto meanwhile.
      if (
        connection.client.transport === connection.transport &&
        this.disposePromises.get(connection) === closing
      ) {
        this.disposePromises.delete(connection);
      }
    });
    return closing;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.ownedClients].map((client) => drainClientOperations(client)));
  }
}
