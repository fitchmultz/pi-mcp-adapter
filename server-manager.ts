import { isDeepStrictEqual } from "node:util";
import type {
  CompleteRequestParams,
  CompleteResult,
  GetPromptResult,
  ReadResourceResult,
  RequestOptions,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import {
  isServerDisabled,
  type CachedPriorDiscovery,
  type ServerDefinition,
  type McpTraceSettings,
} from "./types.ts";
import type { ServerSamplingConfig } from "./sampling-handler.ts";
import type { ServerElicitationConfig } from "./elicitation-handler.ts";
import type { McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import type { AuthStorageOptions } from "./mcp-auth.ts";
import { normalizeRequestTimeoutMs } from "./utils.ts";
import type {
  ServerConnection,
  UiStreamListener,
  MetadataListChangedListener,
  ServerClosedListener,
} from "./server-connection.ts";
import { ConnectionLifecycle } from "./connection-lifecycle.ts";
import { ConnectionFactory } from "./connection-factory.ts";
import { ConnectionCallbacks } from "./connection-callbacks.ts";
import { appendStderrToError } from "./connection-stdio.ts";
export type { ServerConnection } from "./server-connection.ts";

export class McpServerManager {
  private readonly lifecycle: ConnectionLifecycle;
  private readonly factory: ConnectionFactory;
  private readonly callbacks: ConnectionCallbacks;
  private serverClosedListener: ServerClosedListener | undefined;

  constructor(defaultCwd?: string) {
    this.lifecycle = new ConnectionLifecycle(
      (name, definition, signal, requestSignal) =>
        this.factory.create(name, definition, signal, requestSignal),
      () => this.factory.flushTrace(),
      {
        publish: (connection) => this.callbacks.publish(connection),
        activateSubscription: (name, connection) =>
          this.callbacks.activateSubscription(name, connection),
        close: (name) => {
          this.callbacks.clearServer(name);
          this.serverClosedListener?.(name);
        },
        closeAll: () => {
          this.callbacks.clear();
          this.serverClosedListener?.();
        },
        invalidatePrior: (name) => this.factory.priorDiscovery.invalidate(name),
      },
    );
    this.callbacks = new ConnectionCallbacks(this.lifecycle);
    this.factory = new ConnectionFactory(this.lifecycle, this.callbacks, defaultCwd);
  }

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.callbacks.samplingConfig = config;
  }

  setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void {
    this.callbacks.metadataListChangedListener = listener;
  }

  setServerClosedListener(listener: ServerClosedListener | undefined): void {
    this.serverClosedListener = listener;
  }

  setExposeSkills(enabled: boolean): void {
    this.factory.exposeSkills = enabled;
    this.callbacks.exposeSkills = enabled;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.callbacks.elicitationConfig = config;
  }

  setRuntimeSignal(signal: AbortSignal | undefined): void {
    // The manager is constructed before its owning runtime exists; the session signal is
    // bound once the runtime starts and scopes every connection attempt and request.
    this.lifecycle.runtimeSignal = signal;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.factory.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  setDefaultCwd(cwd: string | undefined): void {
    if (this.factory.defaultCwd !== cwd) {
      this.factory.defaultCwd = cwd;
      this.factory.resetTraceWriter();
    }
  }

  setTraceConfig(settings: McpTraceSettings | undefined): void {
    if (!isDeepStrictEqual(this.factory.traceSettings, settings)) {
      this.factory.traceSettings = settings;
      this.factory.resetTraceWriter();
    }
  }

  setAuthStorageOptions(options: AuthStorageOptions): void {
    this.factory.authStorageOptions = options;
  }

  setOAuthRuntime(runtime: McpOAuthRuntime): void {
    this.factory.oauthRuntime = runtime;
  }

  seedPriorDiscovery(
    name: string,
    definition: ServerDefinition,
    entry: CachedPriorDiscovery,
  ): void {
    this.factory.priorDiscovery.seed(name, definition, entry);
  }

  invalidatePriorDiscovery(name: string): void {
    this.factory.priorDiscovery.invalidate(name);
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    return this.factory.requestOptions(this.lifecycle.getConnection(name)?.definition, signal);
  }

  async connect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    return this.lifecycle.connect(name, definition, signal);
  }

  async reconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    return this.lifecycle.reconnect(name, definition, staleConnection, signal);
  }

  retire(name: string, connection: ServerConnection): void {
    this.lifecycle.retire(name, connection);
  }

  async hasFreshOAuthCredentials(
    name: string,
    definition: ServerDefinition,
    stale: ServerConnection,
  ): Promise<boolean> {
    return await this.factory.hasFreshOAuthCredentials(name, definition, stale);
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    return this.callbacks.handleUrlElicitationRequired(serverName, error);
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.callbacks.registerUiStreamListener(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.callbacks.removeUiStreamListener(streamToken);
  }

  async getPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    const connection = this.lifecycle.getConnection(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }
    try {
      this.touch(name);
      this.incrementInFlight(connection);
      return await connection.client.getPrompt(
        { name: promptName, ...(args ? { arguments: args } : {}) },
        this.getRequestOptions(name, signal),
      );
    } catch (error) {
      const enriched = appendStderrToError(error, connection);
      if (enriched !== undefined) {
        throw enriched;
      }
      throw error;
    } finally {
      this.decrementInFlight(connection);
      this.touch(name);
    }
  }

  async complete(
    name: string,
    params: CompleteRequestParams,
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const connection = this.lifecycle.getConnection(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }
    if (!connection.client.getServerCapabilities()?.completions) {
      return { completion: { values: [] } };
    }
    try {
      this.touch(name);
      this.incrementInFlight(connection);
      return await connection.client.complete(params, this.getRequestOptions(name, signal));
    } finally {
      this.decrementInFlight(connection);
      this.touch(name);
    }
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    if (isServerDisabled(this.lifecycle.getConnection(name)?.definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    const connection = this.lifecycle.getConnection(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(connection);
      return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
    } catch (error) {
      const enriched = appendStderrToError(error, connection);
      if (enriched !== undefined) {
        throw enriched;
      }
      throw error;
    } finally {
      this.decrementInFlight(connection);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    return this.lifecycle.close(name);
  }

  async closeAll(): Promise<void> {
    return this.lifecycle.closeAll();
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.lifecycle.getConnection(name);
  }

  getStderrTail(name: string): string {
    const live = this.lifecycle.getConnection(name)?.getStderrTail?.() ?? "";
    return live.length > 0 ? live : this.callbacks.getLastStderrTail(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return this.lifecycle.getAllConnections();
  }

  touch(name: string): void {
    this.lifecycle.touch(name);
  }

  incrementInFlight(connection: ServerConnection): void {
    this.lifecycle.incrementInFlight(connection);
  }

  decrementInFlight(connection: ServerConnection): void {
    this.lifecycle.decrementInFlight(connection);
  }

  inFlightCount(connection: ServerConnection): number {
    return this.lifecycle.inFlightCount(connection);
  }

  isIdle(name: string, timeoutMs: number): boolean {
    return this.lifecycle.isIdle(name, timeoutMs);
  }
}
