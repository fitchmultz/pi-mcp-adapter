import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { exponentialBackoffMs } from "./server-status.ts";
import { formatTerminalError, sanitizeTerminalText } from "./utils.ts";

export type ReconnectCallback = (serverName: string) => void;
export type ReconnectFailureCallback = (serverName: string, error: unknown) => void;

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
// Background polling cannot retry faster than its tick; capping at 10x (5m at 30s) stops dead-daemon respawn loops.
const MAX_RECONNECT_BACKOFF_MULTIPLIER = 10;

interface ReconnectBackoff {
  failures: number;
  nextRetryAt: number;
}

export class McpLifecycleManager {
  private readonly keepAliveServers = new Map<string, ServerDefinition>();
  private readonly allServers = new Map<string, ServerDefinition>();
  private readonly serverSettings = new Map<string, { idleTimeout?: number }>();
  private readonly reconnectBackoff = new Map<string, ReconnectBackoff>();
  private readonly activeReconnects = new Map<string, Promise<void>>();
  private readonly activeIdleCloses = new Map<string, Promise<void>>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private healthController: AbortController | undefined;
  private onReconnect: ReconnectCallback | undefined;
  private onReconnectFailure: ReconnectFailureCallback | undefined;
  private onIdleShutdown: ((serverName: string) => void) | undefined;
  private shutdownPromise: Promise<void> | undefined;
  /** The loop's own phase: armed by a session, disarmed by its abort or shutdown. */
  private phase: "idle" | "running" | "stopped" = "idle";
  private removeHealthAbortListener: (() => void) | undefined;

  private readonly manager: McpServerManager;
  private readonly hasPendingAuthForServer: (serverName: string) => boolean;

  constructor(manager: McpServerManager, hasPendingAuthForServer: (serverName: string) => boolean) {
    this.manager = manager;
    this.hasPendingAuthForServer = hasPendingAuthForServer;
  }

  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  setReconnectFailureCallback(callback: ReconnectFailureCallback): void {
    this.onReconnectFailure = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    if (isServerDisabled(definition)) {
      return;
    }
    this.keepAliveServers.set(name, definition);
    this.reconnectBackoff.delete(name);
  }

  resetReconnectBackoff(name: string): void {
    this.reconnectBackoff.delete(name);
  }

  registerServer(
    name: string,
    definition: ServerDefinition,
    settings?: { idleTimeout?: number },
  ): void {
    if (isServerDisabled(definition)) {
      return;
    }
    // The lifecycle keeps its own registry of definitions, captured at registration time;
    // a changed definition must be re-registered, not edited in place.
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  startHealthChecks(
    signalOrInterval?: AbortSignal | number,
    maybeIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  ): void {
    const signal = typeof signalOrInterval === "number" ? undefined : signalOrInterval;
    const intervalMs = typeof signalOrInterval === "number" ? signalOrInterval : maybeIntervalMs;
    this.clearHealthInterval();
    this.healthCheckIntervalMs = intervalMs;
    this.phase = "running";
    if (signal?.aborted === true) {
      this.phase = "stopped";
      this.abortHealthController(signal.reason);
      return;
    }
    if (!this.healthController || this.healthController.signal.aborted) {
      this.healthController = new AbortController();
    }
    const healthSignal = combineAbortSignals(this.healthController.signal, signal);
    const stop = () => {
      this.phase = "stopped";
      this.stopHealthLoop(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
    this.removeHealthAbortListener = () => signal?.removeEventListener("abort", stop);
    this.healthCheckInterval = setInterval(() => {
      this.tick(healthSignal);
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  private clearHealthInterval(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = undefined;
    this.removeHealthAbortListener?.();
    this.removeHealthAbortListener = undefined;
  }

  private abortHealthController(reason?: unknown): void {
    const controller = this.healthController;
    this.healthController = undefined;
    if (controller && !controller.signal.aborted) {
      controller.abort(reason ?? new Error("MCP lifecycle health checks stopped"));
    }
  }

  private stopHealthLoop(reason?: unknown): void {
    this.clearHealthInterval();
    this.abortHealthController(reason);
  }

  private isStopped(signal?: AbortSignal): boolean {
    return this.phase === "stopped" || signal?.aborted === true;
  }

  private needsReconnect(name: string, definition: ServerDefinition): boolean {
    if (isServerDisabled(definition)) {
      return false;
    }
    const status = this.manager.getConnection(name)?.status;
    if (status === "connected" || status === "needs-auth") {
      this.reconnectBackoff.delete(name);
      return false;
    }
    return true;
  }

  private shouldAttemptReconnect(name: string, definition: ServerDefinition, now: number): boolean {
    if (!this.needsReconnect(name, definition)) {
      return false;
    }
    const backoff = this.reconnectBackoff.get(name);
    if (backoff && now < backoff.nextRetryAt) {
      return false;
    }
    if (this.hasPendingAuthForServer(name)) {
      logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
      return false;
    }
    return true;
  }

  private recordReconnectFailure(name: string): number {
    const failures = (this.reconnectBackoff.get(name)?.failures ?? 0) + 1;
    const baseMs = Math.max(1, this.healthCheckIntervalMs);
    const delayMs = exponentialBackoffMs(
      failures,
      baseMs,
      baseMs * MAX_RECONNECT_BACKOFF_MULTIPLIER,
    );
    this.reconnectBackoff.set(name, { failures, nextRetryAt: Date.now() + delayMs });
    return delayMs;
  }

  private async reconnect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const connection = await this.manager.connect(name, definition, signal);
      if (this.isStopped(signal)) {
        return;
      }
      if (connection.status !== "connected") {
        if (connection.status === "needs-auth") {
          this.reconnectBackoff.delete(name);
          logger.debug(`Keep-alive server ${name} requires OAuth authentication`);
        }
        return;
      }
      this.reconnectBackoff.delete(name);
      logger.debug(`Reconnected to ${name}`);
      this.onReconnect?.(name);
    } catch (error) {
      if (this.isStopped(signal)) {
        return;
      }
      const delayMs = this.recordReconnectFailure(name);
      try {
        this.onReconnectFailure?.(name, error);
      } catch (callbackError) {
        logger.debug(
          `MCP: Reconnect failure callback failed: ${formatTerminalError(callbackError)}`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        `MCP: Failed to reconnect to ${name}: ${sanitizeTerminalText(message)} (next retry in ${Math.round(delayMs / 1000)}s)`,
      );
    }
  }

  private tick(signal?: AbortSignal): void {
    if (this.isStopped(signal)) {
      return;
    }
    this.launchKeepAliveReconnects(signal);
    this.launchIdleShutdowns(signal);
  }

  private launchKeepAliveReconnects(signal?: AbortSignal): void {
    const now = Date.now();
    for (const [name, definition] of this.keepAliveServers) {
      if (this.activeReconnects.has(name) || !this.shouldAttemptReconnect(name, definition, now)) {
        continue;
      }
      const task = this.reconnect(name, definition, signal)
        .catch((error: unknown) => {
          logger.debug(`MCP: Health check failed: ${formatTerminalError(error)}`);
        })
        .finally(() => {
          if (this.activeReconnects.get(name) === task) {
            this.activeReconnects.delete(name);
          }
        });
      this.activeReconnects.set(name, task);
    }
  }

  private launchIdleShutdowns(signal?: AbortSignal): void {
    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name) || this.activeIdleCloses.has(name)) {
        continue;
      }
      const timeout = this.getIdleTimeout(name);
      if (timeout <= 0 || !this.manager.isIdle(name, timeout)) {
        continue;
      }
      const task = this.closeIdleServer(name, signal)
        .catch((error: unknown) => {
          logger.debug(`MCP: Health check failed: ${formatTerminalError(error)}`);
        })
        .finally(() => {
          if (this.activeIdleCloses.get(name) === task) {
            this.activeIdleCloses.delete(name);
          }
        });
      this.activeIdleCloses.set(name, task);
    }
  }

  private async closeIdleServer(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.manager.close(name);
      if (this.isStopped(signal)) {
        return;
      }
      this.onIdleShutdown?.(name);
    } catch (error) {
      logger.debug(`MCP: Health check failed: ${formatTerminalError(error)}`);
    }
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) {
      return perServer * 60 * 1000;
    }
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.phase = "stopped";
    this.stopHealthLoop(new Error("MCP lifecycle manager shut down"));
    await Promise.allSettled([
      ...this.activeReconnects.values(),
      ...this.activeIdleCloses.values(),
    ]);
    this.activeReconnects.clear();
    this.activeIdleCloses.clear();
    this.reconnectBackoff.clear();
    this.onReconnect = undefined;
    this.onReconnectFailure = undefined;
    this.onIdleShutdown = undefined;
    await this.manager.closeAll();
  }
}
