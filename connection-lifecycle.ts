import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { ServerConnection } from "./server-connection.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { clientOperations } from "./client-operations.ts";
import {
  ConnectionDisposal,
  containsCleanupFailure,
  cleanupFailures,
} from "./connection-disposal.ts";

class ConnectionAttempt {
  readonly controller = new AbortController();
  private waiters = 0;

  wait(
    promise: Promise<ServerConnection>,
    signal: AbortSignal | undefined,
  ): Promise<ServerConnection> {
    this.waiters++;
    return abortable(promise, signal).finally(() => {
      this.waiters--;
      if (this.waiters === 0 && signal?.aborted === true) {
        this.controller.abort(signal.reason);
      }
    });
  }

  async waitCancelled(
    promise: Promise<ServerConnection>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await abortable(promise, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (containsCleanupFailure(error)) {
        throw error;
      }
    }
  }
}

type PendingConnection = { promise: Promise<ServerConnection>; attempt: ConnectionAttempt };

export class ConnectionLifecycle {
  private readonly connections = new Map<string, ServerConnection>();
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly reconnectPromises = new Map<string, Promise<ServerConnection>>();
  private readonly closePromises = new Map<string, Promise<void>>();
  readonly closeGenerations = new Map<string, number>();
  readonly disposal: ConnectionDisposal;
  runtimeSignal: AbortSignal | undefined;
  stopped = false;
  private readonly createConnection: (
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    requestSignal?: AbortSignal,
  ) => Promise<ServerConnection>;
  private readonly flushTrace: () => Promise<void> | undefined;
  private readonly onClose: (name: string) => void;
  private readonly onCloseAll: () => void;

  constructor(
    createConnection: (
      name: string,
      definition: ServerDefinition,
      signal?: AbortSignal,
      requestSignal?: AbortSignal,
    ) => Promise<ServerConnection>,
    flushTrace: () => Promise<void> | undefined,
    onClose: (name: string) => void,
    onCloseAll: () => void,
  ) {
    this.createConnection = createConnection;
    this.flushTrace = flushTrace;
    this.onClose = onClose;
    this.onCloseAll = onCloseAll;
    this.disposal = new ConnectionDisposal(flushTrace);
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("MCP server manager is closed");
    }
  }

  async connect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    if (isServerDisabled(definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    this.assertRunning();
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const closing = this.closePromises.get(name);
    if (closing) {
      await abortable(closing, ownedSignal);
    }
    throwIfAborted(ownedSignal);
    this.assertRunning();

    // Dedupe concurrent connection attempts.
    const pending = this.pendingConnections.get(name);
    if (pending) {
      const { attempt, promise } = pending;
      if (attempt.controller.signal.aborted) {
        // Finish the canceled attempt's cleanup before starting a fresh one.
        await attempt.waitCancelled(promise, ownedSignal);
        return this.connect(name, definition, signal);
      }
      return attempt.wait(promise, ownedSignal);
    }

    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const generation = this.closeGenerations.get(name) ?? 0;
    const attempt = new ConnectionAttempt();
    const attemptSignal = combineAbortSignals(this.runtimeSignal, attempt.controller.signal);
    const promise = this.establish(name, definition, attempt, {
      signal: attemptSignal,
      requestSignal: ownedSignal ? attemptSignal : undefined,
      generation,
    }).finally(() => {
      if (this.pendingConnections.get(name)?.promise === promise) {
        this.pendingConnections.delete(name);
      }
    });
    this.pendingConnections.set(name, { promise, attempt });
    return attempt.wait(promise, ownedSignal);
  }

  private async establish(
    name: string,
    definition: ServerDefinition,
    attempt: ConnectionAttempt,
    options: {
      signal: AbortSignal | undefined;
      requestSignal: AbortSignal | undefined;
      generation: number;
    },
  ): Promise<ServerConnection> {
    const connection = await this.createConnection(
      name,
      definition,
      options.signal,
      options.requestSignal,
    );
    if (
      connection.status === "closed" ||
      attempt.controller.signal.aborted ||
      (this.closeGenerations.get(name) ?? 0) !== options.generation
    ) {
      await this.disposal.dispose(connection);
      throwIfAborted(options.signal);
      throw new Error(`MCP connection for ${name} was closed while connecting`);
    }
    connection.inFlight = this.connections.get(name)?.inFlight ?? 0;
    this.connections.set(name, connection);
    return connection;
  }

  /**
   * Reconnect a server whose connection was proven stale (e.g. by a 404
   * "session no longer exists" response). Single-flight per server name —
   * concurrent callers that raced to the same failure share one reconnect —
   * and identity-guarded: `staleConnection` is only retired if it is
   * still the manager's current connection for `name`. If a concurrent
   * reconnect (or an unrelated connect()) already replaced it with a fresh
   * connection, that fresh connection is returned untouched.
   */
  async reconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    if (isServerDisabled(definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    this.assertRunning();
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const inFlight = this.reconnectPromises.get(name);
    if (inFlight) {
      return abortable(inFlight, ownedSignal);
    }

    const promise = this.doReconnect(name, definition, staleConnection, this.runtimeSignal).finally(
      () => {
        if (this.reconnectPromises.get(name) === promise) {
          this.reconnectPromises.delete(name);
        }
      },
    );
    this.reconnectPromises.set(name, promise);
    return abortable(promise, ownedSignal);
  }

  private async doReconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const current = this.connections.get(name);

    // Never tear down a connection we didn't prove stale: if the map no
    // longer holds the connection we were asked to replace, someone else
    // already reconnected (or connected) first.
    if (current !== staleConnection) {
      if (!current) {
        throw new Error(`Server "${name}" is not connected`);
      }
      return current;
    }

    this.retire(name, staleConnection);
    return this.connect(name, definition, signal);
  }

  /** Retire only the expected current client; accepted native work drains before close. */
  retire(name: string, expected: ServerConnection): void {
    const current = this.connections.get(name);
    if (current !== expected) {
      return;
    }
    current.status = "closed";
    this.disposal.retire(name, current);
  }

  async close(name: string): Promise<void> {
    this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
    this.pendingConnections
      .get(name)
      ?.attempt.controller.abort(new Error(`MCP connection ${name} was closed`));
    const pendingClose = this.closePromises.get(name);
    if (pendingClose) {
      return pendingClose;
    }

    const owned = new Set(this.disposal.retired.get(name));
    const connection = this.connections.get(name);
    if (connection) {
      owned.add(connection);
    }
    // Keep failed cleanup/callback tails owned even after removal from the active connection map.
    if (owned.size > 0) {
      this.disposal.retired.set(name, owned);
    }
    // Remove the placeholder before awaiting cleanup; stale callers cannot resurrect it.
    this.connections.delete(name);
    this.onClose(name);
    for (const item of owned) {
      item.status = "closed";
    }
    const pendingConnect = this.pendingConnections.get(name)?.promise;
    const closing = (async () => {
      const results = await Promise.allSettled([
        ...[...owned].map((item) => this.disposal.dispose(item)),
        pendingConnect?.catch((error: unknown) => {
          if (containsCleanupFailure(error)) {
            throw error;
          }
        }),
      ]);
      const failures = cleanupFailures(results);
      if (failures.length > 0) {
        throw new AggregateError(failures, "MCP connection cleanup failed");
      }
      this.disposal.retired.delete(name);
    })().finally(() => {
      if (this.closePromises.get(name) === closing) {
        this.closePromises.delete(name);
      }
    });
    this.closePromises.set(name, closing);
    return closing;
  }

  async closeAll(): Promise<void> {
    this.stopped = true;
    const names = new Set([
      ...this.connections.keys(),
      ...this.disposal.retired.keys(),
      ...this.pendingConnections.keys(),
      ...this.closePromises.keys(),
    ]);
    const results = await Promise.allSettled([...names].map((name) => this.close(name)));
    const failures = cleanupFailures(results);
    this.onCloseAll();
    await this.disposal.drain();
    try {
      await this.flushTrace();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP manager cleanup failed");
    }
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight += 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight !== 0) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      return false;
    }
    if (connection.inFlight > 0) {
      return false;
    }
    // Background subscriptions keep their existing idle policy, but accepted requests and
    // callbacks (including cancellation tails) must not be closed as idle while unfinished.
    if (
      [...(clientOperations.get(connection.client)?.values() ?? [])].some(
        (kind) => kind !== "subscription",
      )
    ) {
      return false;
    }
    return Date.now() - connection.lastUsedAt > timeoutMs;
  }
}
