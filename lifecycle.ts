import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";
import { formatTerminalError, sanitizeTerminalText } from "./utils.ts";

export type ReconnectCallback = (serverName: string) => void;
export type ReconnectFailureCallback = (serverName: string, error: unknown) => void;

export class McpLifecycleManager {
  private readonly keepAliveServers = new Map<string, ServerDefinition>();
  private readonly allServers = new Map<string, ServerDefinition>();
  private readonly serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private onReconnect: ReconnectCallback | undefined;
  private onReconnectFailure: ReconnectFailureCallback | undefined;
  private onIdleShutdown: ((serverName: string) => void) | undefined;
  private activeHealthCheck: Promise<void> | undefined;
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

  startHealthChecks(signalOrInterval?: AbortSignal | number, maybeIntervalMs = 30000): void {
    const signal = typeof signalOrInterval === "number" ? undefined : signalOrInterval;
    const intervalMs = typeof signalOrInterval === "number" ? signalOrInterval : maybeIntervalMs;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.removeHealthAbortListener?.();
    this.phase = "running";
    if (signal?.aborted === true) {
      this.phase = "stopped";
      return;
    }
    const stop = () => {
      this.phase = "stopped";
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }
      this.healthCheckInterval = undefined;
    };
    signal?.addEventListener("abort", stop, { once: true });
    this.removeHealthAbortListener = () => signal?.removeEventListener("abort", stop);
    this.healthCheckInterval = setInterval(() => {
      if (this.phase === "stopped" || signal?.aborted === true || this.activeHealthCheck) {
        return;
      }
      const check = this.checkConnections(signal)
        .catch((error: unknown) => {
          console.error(`MCP: Health check failed: ${formatTerminalError(error)}`);
        })
        .finally(() => {
          if (this.activeHealthCheck === check) {
            this.activeHealthCheck = undefined;
          }
        });
      this.activeHealthCheck = check;
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  private isStopped(signal?: AbortSignal): boolean {
    return this.phase === "stopped" || signal?.aborted === true;
  }

  private needsReconnect(name: string, definition: ServerDefinition): boolean {
    return (
      !isServerDisabled(definition) && this.manager.getConnection(name)?.status !== "connected"
    );
  }

  private async reconnect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.needsReconnect(name, definition)) {
      return;
    }
    if (this.hasPendingAuthForServer(name)) {
      logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
      return;
    }
    try {
      await this.manager.connect(name, definition, signal);
      if (this.isStopped(signal)) {
        return;
      }
      logger.debug(`Reconnected to ${name}`);
      this.onReconnect?.(name);
    } catch (error) {
      if (this.isStopped(signal)) {
        return;
      }
      this.onReconnectFailure?.(name, error);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`MCP: Failed to reconnect to ${name}: ${sanitizeTerminalText(message)}`);
    }
  }

  private async checkConnections(signal?: AbortSignal): Promise<void> {
    if (this.isStopped(signal)) {
      return;
    }
    for (const [name, definition] of this.keepAliveServers) {
      await this.reconnect(name, definition, signal);
      if (this.isStopped(signal)) {
        return;
      }
    }
    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) {
        continue;
      }
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        if (this.isStopped(signal)) {
          return;
        }
        this.onIdleShutdown?.(name);
      }
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
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = undefined;
    this.removeHealthAbortListener?.();
    this.removeHealthAbortListener = undefined;
    await this.activeHealthCheck;
    this.activeHealthCheck = undefined;
    this.onReconnect = undefined;
    this.onReconnectFailure = undefined;
    this.onIdleShutdown = undefined;
    await this.manager.closeAll();
  }
}
