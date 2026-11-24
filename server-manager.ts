import type {
  GetPromptResult,
  ReadResourceResult,
  RequestOptions,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import { isServerDisabled, type ServerDefinition, type McpTraceSettings } from "./types.ts";
import type { ServerSamplingConfig } from "./sampling-handler.ts";
import type { ServerElicitationConfig } from "./elicitation-handler.ts";
import type { McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import type { AuthStorageOptions } from "./mcp-auth.ts";
import { normalizeRequestTimeoutMs } from "./utils.ts";
import type {
  ServerConnection,
  UiStreamListener,
  MetadataListChangedListener,
} from "./server-connection.ts";
import { ConnectionLifecycle } from "./connection-lifecycle.ts";
import { ConnectionFactory } from "./connection-factory.ts";
import { ConnectionCallbacks } from "./connection-callbacks.ts";
export type { ServerConnection } from "./server-connection.ts";

export class McpServerManager {
  private readonly lifecycle: ConnectionLifecycle;
  private readonly factory: ConnectionFactory;
  private readonly callbacks: ConnectionCallbacks;

  constructor(defaultCwd?: string) {
    this.lifecycle = new ConnectionLifecycle(
      (name, definition, signal, requestSignal) =>
        this.factory.create(name, definition, signal, requestSignal),
      () => this.factory.flushTrace(),
      {
        publish: (connection) => this.callbacks.publish(connection),
        close: (name) => this.callbacks.clearServer(name),
        closeAll: () => this.callbacks.clear(),
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

  setTraceConfig(settings: McpTraceSettings | undefined): void {
    this.factory.traceSettings = settings;
  }

  setAuthStorageOptions(options: AuthStorageOptions): void {
    this.factory.authStorageOptions = options;
  }

  setOAuthRuntime(runtime: McpOAuthRuntime): void {
    this.factory.oauthRuntime = runtime;
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
