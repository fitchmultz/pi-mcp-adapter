import type {
  Client,
  McpSubscription,
  RequestOptions,
  SubscriptionFilter,
} from "@modelcontextprotocol/client";
import type { ConnectionLifecycle } from "./connection-lifecycle.ts";
import type { ServerConnection } from "./server-connection.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { logger } from "./logger.ts";

// Bounded 250ms/500ms/1000ms reconnect backoff (3 attempts) after an unexpected remote SSE stream drop.
const SUBSCRIPTION_RELISTEN_BASE_DELAY_MS = 250;
const SUBSCRIPTION_RELISTEN_MAX_ATTEMPTS = 3;
// Require a subscription to stay open at least one max-backoff window (1s) before resetting retry budget.
const SUBSCRIPTION_STABLE_OPEN_MS = 1_000;

interface SubscriptionWatcher {
  controller: AbortController;
}

interface SubscriptionRelistenState {
  watcher: SubscriptionWatcher;
  attempt: number;
  openedAt: number;
  timeout: number | undefined;
}

function listChangedFilter(client: Client): SubscriptionFilter | undefined {
  const capabilities = client.getServerCapabilities();
  if (!capabilities) {
    return undefined;
  }
  const filter: SubscriptionFilter = {
    ...(capabilities.tools?.listChanged === true ? { toolsListChanged: true } : {}),
    ...(capabilities.prompts?.listChanged === true ? { promptsListChanged: true } : {}),
    ...(capabilities.resources?.listChanged === true ? { resourcesListChanged: true } : {}),
  };
  return Object.keys(filter).length > 0 ? filter : undefined;
}

interface PreparedSubscription {
  subscription: McpSubscription;
  openedAt: number;
  timeout: number | undefined;
}

export class ConnectionSubscriptions {
  private readonly watchers = new Map<string, SubscriptionWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly prepared = new WeakMap<ServerConnection, PreparedSubscription>();
  private readonly lifecycle: ConnectionLifecycle;

  constructor(lifecycle: ConnectionLifecycle) {
    this.lifecycle = lifecycle;
  }

  clear(): void {
    for (const name of this.watchers.keys()) {
      this.stop(name);
    }
  }

  stop(serverName: string): void {
    const timer = this.timers.get(serverName);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(serverName);
    }
    const watcher = this.watchers.get(serverName);
    if (!watcher) {
      return;
    }
    this.watchers.delete(serverName);
    watcher.controller.abort(new Error(`MCP subscription watcher stopped for ${serverName}`));
  }

  async prepare(
    serverName: string,
    connection: ServerConnection,
    options: { priorModern: boolean; requestOptions?: RequestOptions; signal?: AbortSignal },
  ): Promise<void> {
    const subscription =
      connection.client.autoOpenedSubscription ??
      (await this.openPrior(serverName, connection.client, options));
    if (subscription) {
      this.prepared.set(connection, {
        subscription,
        openedAt: Date.now(),
        timeout: options.requestOptions?.timeout,
      });
    }
  }

  activate(serverName: string, connection: ServerConnection): void {
    const entry = this.prepared.get(connection);
    if (!entry) {
      return;
    }
    this.prepared.delete(connection);
    this.stop(serverName);
    const watcher: SubscriptionWatcher = { controller: new AbortController() };
    this.watchers.set(serverName, watcher);
    this.watchClose(serverName, connection, entry.subscription, {
      watcher,
      attempt: 0,
      openedAt: entry.openedAt,
      timeout: entry.timeout,
    });
  }

  private async openPrior(
    serverName: string,
    client: Client,
    options: { priorModern: boolean; requestOptions?: RequestOptions; signal?: AbortSignal },
  ): Promise<McpSubscription | undefined> {
    if (!options.priorModern || client.getProtocolEra() !== "modern") {
      return undefined;
    }
    const filter = listChangedFilter(client);
    if (!filter) {
      return undefined;
    }
    try {
      return await client.listen(filter, options.requestOptions);
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      logger.debug(
        `MCP: ${serverName} list_changed subscription open failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private isLiveOwner(
    serverName: string,
    connection: ServerConnection,
    watcher: SubscriptionWatcher,
  ): boolean {
    if (
      this.lifecycle.stopped ||
      this.lifecycle.runtimeSignal?.aborted === true ||
      watcher.controller.signal.aborted ||
      this.watchers.get(serverName) !== watcher
    ) {
      return false;
    }
    const current = this.lifecycle.getConnection(serverName);
    return current === connection && connection.status === "connected";
  }

  private watchClose(
    serverName: string,
    connection: ServerConnection,
    subscription: McpSubscription,
    state: SubscriptionRelistenState,
  ): void {
    subscription.closed
      .then((reason) => {
        if (reason === "local" || !this.isLiveOwner(serverName, connection, state.watcher)) {
          return;
        }
        logger.debug(`MCP: ${serverName} list_changed subscription closed (${reason})`);
        if (reason !== "remote") {
          return;
        }
        const nextAttempt =
          Date.now() - state.openedAt >= SUBSCRIPTION_STABLE_OPEN_MS ? 0 : state.attempt;
        this.scheduleRelisten(serverName, connection, subscription.honoredFilter, {
          ...state,
          attempt: nextAttempt,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: ${serverName} list_changed subscription observer error: ${message}`);
      });
  }

  private scheduleRelisten(
    serverName: string,
    connection: ServerConnection,
    filter: McpSubscription["honoredFilter"],
    state: SubscriptionRelistenState,
  ): void {
    if (Object.keys(filter).length === 0 || state.attempt >= SUBSCRIPTION_RELISTEN_MAX_ATTEMPTS) {
      return;
    }
    const delayMs = SUBSCRIPTION_RELISTEN_BASE_DELAY_MS * 2 ** state.attempt;
    const timer = setTimeout(() => {
      this.timers.delete(serverName);
      if (!this.isLiveOwner(serverName, connection, state.watcher)) {
        return;
      }
      this.relisten(serverName, connection, filter, state);
    }, delayMs);
    timer.unref();
    this.timers.set(serverName, timer);
  }

  private relisten(
    serverName: string,
    connection: ServerConnection,
    filter: McpSubscription["honoredFilter"],
    state: SubscriptionRelistenState,
  ): void {
    const signal = combineAbortSignals(
      this.lifecycle.runtimeSignal,
      state.watcher.controller.signal,
    );
    connection.client
      .listen(filter, {
        ...(signal ? { signal } : {}),
        ...(state.timeout !== undefined ? { timeout: state.timeout } : {}),
      })
      .then((reopened) => {
        if (!this.isLiveOwner(serverName, connection, state.watcher)) {
          reopened.close().catch(() => {
            // Ignore best-effort close when the connection retired during re-listen.
          });
          return;
        }
        logger.debug(`MCP: ${serverName} re-established list_changed subscription`);
        this.watchClose(serverName, connection, reopened, {
          ...state,
          attempt: state.attempt + 1,
          openedAt: Date.now(),
        });
      })
      .catch((error: unknown) => {
        if (!this.isLiveOwner(serverName, connection, state.watcher)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: ${serverName} list_changed re-listen failed: ${message}`);
        this.scheduleRelisten(serverName, connection, filter, {
          ...state,
          attempt: state.attempt + 1,
        });
      });
  }
}
