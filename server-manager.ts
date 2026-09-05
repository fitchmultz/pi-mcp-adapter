import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  SdkHttpError,
  type RequestOptions,
  type FetchLike,
  type GetPromptResult,
  type ReadResourceResult,
  type UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { UnixSocketClientTransport } from "./unix-socket-transport.ts";
import { trackToolHttpFailures, trackToolTransportFailure } from "./session-recovery.ts";
import {
  isServerDisabled,
  isNonInteractiveOAuth,
  validateServerProtocolConfig,
  type McpTool,
  type McpResource,
  type McpPrompt,
  type ServerDefinition,
  type ServerStreamResultPatchNotification,
  type Transport,
  type McpTraceSettings,
  serverStreamResultPatchNotificationSchema,
} from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth, isOAuthChallenge, recordOAuthChallenge, getOAuthRequest, bindOAuthRequestIssuer, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { getAuthBaseDir, type AuthStorageOptions } from "./mcp-auth.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import {
  normalizeRequestTimeoutMs,
  resolveBearerToken,
  resolveCommandSecret,
  resolveCommandSecretsRecord,
  resolveConfigPath,
  resolveServerUrl,
} from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import {
  createMcpTraceWriter,
  isMcpTraceEnabled,
  McpTraceWriter,
  type McpTraceObserver,
  traceTransportKind,
  wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";

const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
const MAX_CAPTURED_STDERR_LINES = 3;
const abortCleanupPromises = new WeakMap<object, Promise<void>>();
const clientOperations = new WeakMap<Client, Set<Promise<unknown>>>();

// Track complete SDK operations, including pagination and pre-request cache awaits.
class ManagedClient extends Client {
  oauthProvider: McpOAuthProvider | undefined;

  private async track<T>(start: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = this.oauthProvider ? new AbortController() : undefined;
    let removeAbortListener = () => {};
    const operation = this.oauthProvider
      ? this.oauthProvider.runWithSignal(controller!.signal, () => {
          // Native legacy cancellation notifications must retain their operation's auth context.
          const abort = AsyncLocalStorage.bind(() => controller!.abort(signal?.reason));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => signal?.removeEventListener("abort", abort);
          return start(controller!.signal);
        })
      : start(signal);
    let pending = clientOperations.get(this);
    if (!pending) clientOperations.set(this, pending = new Set());
    pending.add(operation);
    const settled = () => { pending.delete(operation); removeAbortListener(); };
    void operation.then(settled, () => { controller?.abort(); settled(); });
    return operation;
  }

  override callTool(...args: Parameters<Client["callTool"]>) {
    return this.track(signal => super.callTool(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override readResource(...args: Parameters<Client["readResource"]>) {
    return this.track(signal => super.readResource(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override getPrompt(...args: Parameters<Client["getPrompt"]>) {
    return this.track(signal => super.getPrompt(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listTools(...args: Parameters<Client["listTools"]>) {
    return this.track(signal => super.listTools(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listResources(...args: Parameters<Client["listResources"]>) {
    return this.track(signal => super.listResources(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listPrompts(...args: Parameters<Client["listPrompts"]>) {
    return this.track(signal => super.listPrompts(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }
}

function boundedStderrChunk(chunk: Buffer | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    const start = Math.max(0, chunk.byteLength - MAX_CAPTURED_STDERR_BYTES);
    return Buffer.from(chunk.subarray(start));
  }

  // Limit string conversion before encoding; Buffer.from(largeString) would
  // otherwise allocate the entire stderr event before applying the cap.
  const suffix = chunk.length > MAX_CAPTURED_STDERR_BYTES
    ? chunk.slice(-MAX_CAPTURED_STDERR_BYTES)
    : chunk;
  const bytes = Buffer.from(suffix, "utf8");
  return bytes.byteLength > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_STDERR_BYTES))
    : bytes;
}

function appendStderrTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const bytes = boundedStderrChunk(chunk);
  if (bytes.length === 0) return tail;
  if (tail.length === 0) return bytes;
  const combined = Buffer.concat([tail, bytes]);
  return combined.length > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(combined.subarray(combined.length - MAX_CAPTURED_STDERR_BYTES))
    : combined;
}

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  instructions?: string;
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
  /** Whether this connection was constructed with the native OAuth provider. */
  oauthProvider?: boolean;
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;
type MetadataListChangedListener = (serverName: string, reason: string) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private reconnectPromises = new Map<string, Promise<ServerConnection>>();
  private retiredConnections = new Map<string, Set<ServerConnection>>();
  private disposePromises = new WeakMap<ServerConnection, Promise<void>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private metadataListChangedListener: MetadataListChangedListener | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private authStorageOptions: AuthStorageOptions = {};
  private oauthRuntime: McpOAuthRuntime | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();
  private defaultRequestTimeoutMs: number | undefined;
  private runtimeSignal: AbortSignal | undefined;
  private closePromises = new Map<string, Promise<void>>();
  private closeGenerations = new Map<string, number>();
  private connectAttempts = new Map<string, AbortController>();
  private traceSettings: McpTraceSettings | undefined;
  private traceWriter: McpTraceWriter | undefined;
  private stopped = false;

  /** Default cwd for stdio servers without an explicit config `cwd`. */
  constructor(private readonly defaultCwd?: string) {}

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void {
    this.metadataListChangedListener = listener;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  setRuntimeSignal(signal: AbortSignal | undefined): void {
    this.runtimeSignal = signal;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  setTraceConfig(settings: McpTraceSettings | undefined): void {
    this.traceSettings = settings;
  }

  setAuthStorageOptions(options: AuthStorageOptions): void {
    this.authStorageOptions = options;
  }

  setOAuthRuntime(runtime: McpOAuthRuntime): void {
    this.oauthRuntime = runtime;
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    const connection = this.connections.get(name);
    return this.buildRequestOptions(connection?.definition, signal);
  }

  private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
    if (definition?.requestTimeoutMs !== undefined) {
      return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
    }
    return this.defaultRequestTimeoutMs;
  }

  private buildRequestOptions(
    definition?: ServerDefinition,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    const timeout = this.getResolvedRequestTimeoutMs(definition);
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);

    if (!ownedSignal && timeout === undefined) {
      return undefined;
    }

    return {
      ...(ownedSignal ? { signal: ownedSignal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const closing = this.closePromises.get(name);
    if (closing) await abortable(closing, ownedSignal);
    throwIfAborted(ownedSignal);
    if (this.stopped) throw new Error("MCP server manager is closed");

    // Dedupe concurrent connection attempts.
    if (this.connectPromises.has(name)) {
      return abortable(this.connectPromises.get(name)!, ownedSignal);
    }

    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const generation = this.closeGenerations.get(name) ?? 0;
    const attemptController = new AbortController();
    const attemptSignal = combineAbortSignals(ownedSignal, attemptController.signal);
    const promise = this.createConnection(name, definition, attemptSignal, ownedSignal).then(async connection => {
      if (attemptController.signal.aborted || (this.closeGenerations.get(name) ?? 0) !== generation) {
        await this.disposeConnection(connection);
        throwIfAborted(attemptSignal);
        throw new Error(`MCP connection for ${name} was closed while connecting`);
      }
      connection.inFlight = this.connections.get(name)?.inFlight ?? 0;
      this.connections.set(name, connection);
      return connection;
    });
    this.connectPromises.set(name, promise);
    this.connectAttempts.set(name, attemptController);

    try {
      return await promise;
    } finally {
      if (this.connectPromises.get(name) === promise) this.connectPromises.delete(name);
      if (this.connectAttempts.get(name) === attemptController) this.connectAttempts.delete(name);
    }
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
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const inFlight = this.reconnectPromises.get(name);
    if (inFlight) {
      return abortable(inFlight, ownedSignal);
    }

    const promise = this.doReconnect(name, definition, staleConnection, this.runtimeSignal).finally(() => {
      if (this.reconnectPromises.get(name) === promise) {
        this.reconnectPromises.delete(name);
      }
    });
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
      if (!current) throw new Error(`Server "${name}" is not connected`);
      return current;
    }

    this.retire(name, staleConnection);
    return this.connect(name, definition, signal);
  }

  /** Retire only the expected current client; accepted native work drains before close. */
  retire(name: string, connection: ServerConnection): void {
    if (this.connections.get(name) !== connection) return;
    connection.status = "closed";
    let retired = this.retiredConnections.get(name);
    if (!retired) this.retiredConnections.set(name, retired = new Set());
    if (retired.has(connection)) return;
    retired.add(connection);
    void (async () => {
      const pending = clientOperations.get(connection.client);
      while (pending?.size) await Promise.allSettled([...pending]);
      await this.disposeConnection(connection);
      retired.delete(connection);
      if (retired.size === 0 && this.retiredConnections.get(name) === retired) this.retiredConnections.delete(name);
    })().catch(error => {
      // Keep failed retirement owned so explicit shutdown also reports it.
      logger.debug(`MCP retired connection cleanup failed for ${name}: ${String(error)}`);
    });
  }

  private async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    requestSignal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    validateServerProtocolConfig(definition);
    let client = this.createClient(name, definition);

    const tracingEnabled = isMcpTraceEnabled(definition, this.traceSettings);
    const traceWriter = tracingEnabled
      ? (this.traceWriter ??= createMcpTraceWriter(this.defaultCwd, this.traceSettings ?? {}))
      : undefined;
    const traceObserver: McpTraceObserver | undefined = traceWriter
      ? { record: event => traceWriter.write(event) }
      : undefined;

    let transport: Transport;
    let implicitOAuth = Boolean(definition.url && supportsOAuth(definition)
      && getOAuthRequest(name, resolveServerUrl(definition)!, getAuthBaseDir(this.authStorageOptions), this.oauthRuntime));
    let oauthProvider = false;
    let authError: Error | undefined;
    const onAuthChallenge = (error: Error) => { authError = error; };
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const configuredTransports = [definition.command, definition.url, definition.socket]
      .filter(value => typeof value === "string" && value.length > 0);
    if (configuredTransports.length !== 1) {
      throw new Error(`Server ${name} must configure exactly one of command, url, or socket`);
    }

    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args, signal);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }
      throwIfAborted(signal);

      const cwd = resolveConfigPath(definition.cwd) ?? this.defaultCwd;
      const stdioTransport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env, name),
        ...(cwd !== undefined ? { cwd } : {}),
        stderr: definition.debug ? "inherit" : "pipe",
      });
      // Keep non-debug child diagnostics available for connection failures without
      // retaining an unbounded stream or changing the existing debug behavior.
      if (stdioTransport.stderr) {
        stdioTransport.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = appendStderrTail(stderrTail, chunk);
        });
      }
      transport = stdioTransport;
    } else if (definition.url) {
      // HTTP transport with fallback
      ({ transport, oauthProvider } = this.createHttpTransport(definition, name, client, false, implicitOAuth, onAuthChallenge));
    } else {
      transport = new UnixSocketClientTransport(resolveConfigPath(definition.socket!)!);
    }

    if (traceObserver) {
      const traceTransportKindValue = traceTransportKind(definition, transport);
      transport = wrapTransportWithMcpTrace(transport, name, traceTransportKindValue, traceObserver);
    }

    throwIfAborted(signal);
    const requestOptions = this.buildRequestOptions(definition, requestSignal);

    try {
      let legacySse = false;
      for (;;) {
        authError = undefined;
        try {
          try {
            await this.connectClientWithAbort(client, transport, requestOptions, signal);
          } catch (error) {
            // Only handshake failures establish that the HTTP endpoint is unsupported.
            if (!definition.url || signal?.aborted || legacySse || !(error instanceof SdkHttpError)
              || ![404, 405, 406, 415].includes(error.status)) throw error;
            legacySse = true;
            await client.close();
            client = this.createClient(name, { ...definition, protocolVersion: "legacy" });
            ({ transport, oauthProvider } = this.createHttpTransport(definition, name, client, legacySse, implicitOAuth, onAuthChallenge));
            if (traceObserver) transport = wrapTransportWithMcpTrace(transport, name, traceTransportKind(definition, transport), traceObserver);
            continue;
          }
          this.attachAdapterNotificationHandlers(name, client);

          const instructions = client.getInstructions?.();
          const connection: ServerConnection = {
            client,
            transport,
            definition,
            tools: [],
            resources: [],
            prompts: [],
            ...(instructions !== undefined ? { instructions } : {}),
            lastUsedAt: Date.now(),
            inFlight: 0,
            status: "connected",
            oauthProvider,
          };

          // The public client hook preserves native transport cleanup. An old
          // client's late close must never change its replacement's status.
          client.onclose = () => {
            if (this.connections.get(name) === connection) connection.status = "closed";
          };

          const discoveryOptions = this.buildRequestOptions(definition, signal);
          const catalogs = [
            this.fetchAllTools(client, discoveryOptions),
            this.fetchAllResources(client, discoveryOptions),
            this.fetchAllPrompts(client, discoveryOptions),
          ] as const;
          const [toolResult] = await Promise.allSettled(catalogs);
          throwIfAborted(signal);
          if (toolResult.status === "rejected" && !isOAuthChallenge(toolResult.reason)) throw toolResult.reason;
          // Optional catalogs catch their errors; the native observer still sees auth challenges.
          if (authError) throw authError;
          const [tools, resources, promptResult] = await Promise.all(catalogs);
          connection.tools = tools;
          connection.resources = resources;
          connection.prompts = promptResult.prompts;
          connection.promptDiscoveryFailed = promptResult.failed;
          return connection;
        } catch (error) {
          if (!definition.url || signal?.aborted || implicitOAuth || definition.auth !== undefined
            || !supportsOAuth(definition) || !isOAuthChallenge(error)) throw error;
          implicitOAuth = true;
          await client.close();
          client = this.createClient(name, legacySse ? { ...definition, protocolVersion: "legacy" } : definition);
          ({ transport, oauthProvider } = this.createHttpTransport(definition, name, client, legacySse, implicitOAuth, onAuthChallenge));
          if (traceObserver) transport = wrapTransportWithMcpTrace(transport, name, traceTransportKind(definition, transport), traceObserver);
        }
      }
    } catch (error) {
      // If connectClientWithAbort closed the transport, await that exact close.
      // Otherwise the SDK client owns its transport, so client.close() is the
      // single cleanup operation rather than closing the transport twice.
      const abortCleanup = abortCleanupPromises.get(transport);
      const abortCleanupFailed = error instanceof AggregateError && error.message === "MCP connection abort cleanup failed";
      const cleanupResults = abortCleanupFailed
        ? []
        : await Promise.allSettled([
            abortCleanup ?? Promise.resolve().then(() => client.close()),
          ]);
      const cleanupFailures = cleanupResults.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      let reportedError: unknown = error;
      if (cleanupFailures.length > 0) {
        reportedError = new AggregateError([error, ...cleanupFailures], "MCP connection setup failed");
      }

      // Check for UnauthorizedError - server requires OAuth. A cleanup failure
      // remains a setup failure rather than being hidden behind needs-auth.
      if (isOAuthChallenge(error) && supportsOAuth(definition) && cleanupFailures.length === 0) {
        const connection: ServerConnection = {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          prompts: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
          oauthProvider,
        };
        this.disposePromises.set(connection, Promise.resolve());
        return connection;
      }

      if (stderrTail.length > 0) {
        const stderrText = stderrTail.toString("utf8").trim();
        const lines = stderrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) {
          const baseMessage = reportedError instanceof Error ? reportedError.message : String(reportedError);
          const detail = lines.slice(-MAX_CAPTURED_STDERR_LINES).join(" — ");
          throw new Error(`${baseMessage} (${detail})`, { cause: reportedError });
        }
      }
      throw reportedError;
    }
  }

  private async connectClientWithAbort(
    client: Client,
    transport: Transport,
    requestOptions?: RequestOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    let abortCleanup: Promise<void> | undefined;
    const closeTransport = () => {
      abortCleanup = Promise.resolve().then(() => transport.close());
      abortCleanupPromises.set(transport, abortCleanup);
    };
    signal?.addEventListener("abort", closeTransport, { once: true });
    try {
      await abortable(client.connect(transport, requestOptions), signal);
      await abortCleanup;
    } catch (error) {
      if (abortCleanup) {
        try {
          await abortCleanup;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "MCP connection abort cleanup failed");
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeTransport);
    }
  }

  private buildClientCapabilities(definition: ServerDefinition) {
    return {
      ...(supportsOAuth(definition) && isNonInteractiveOAuth(definition.oauth)
        ? { extensions: { [definition.oauth && definition.oauth.crossAppAccess
          ? "io.modelcontextprotocol/enterprise-managed-authorization" : "io.modelcontextprotocol/oauth-client-credentials"]: {} } } : {}),
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string, definition: ServerDefinition): ManagedClient {
    const capabilities = this.buildClientCapabilities(definition);
    let client: ManagedClient;
    client = new ManagedClient(
      { name: `pi-mcp-${serverName}`, version: "4.2.3" },
      {
        versionNegotiation: { mode: definition.protocolVersion ?? (definition.url ? "auto" : "legacy") },
        listMaxPages: 0,
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        listChanged: {
          tools: {
            onChanged: (error: Error | null, tools: McpTool[] | null) => {
              this.handleToolsListChanged(serverName, client, error, tools);
            },
          },
          resources: {
            onChanged: (error: Error | null, resources: McpResource[] | null) => {
              this.handleResourcesListChanged(serverName, client, error, resources);
            },
          },
          prompts: {
            onChanged: (error: Error | null, prompts: McpPrompt[] | null) => {
              this.handlePromptsListChanged(serverName, client, error, prompts);
            },
          },
        },
      },
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler("notifications/elicitation/complete", notification => {
          if (this.runtimeSignal?.aborted) return;
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  private handleToolsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    tools: McpTool[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!tools) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.tools = tools;
    this.metadataListChangedListener?.(serverName, "tools-list-changed");
  }

  private handlePromptsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    prompts: McpPrompt[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: prompts/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!prompts) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.prompts = prompts;
    connection.promptDiscoveryFailed = false;
    this.metadataListChangedListener?.(serverName, "prompts-list-changed");
  }

  private handleResourcesListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    resources: McpResource[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: resources/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!resources) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.resources = resources;
    this.metadataListChangedListener?.(serverName, "resources-list-changed");
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (this.runtimeSignal?.aborted || !this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    if (this.runtimeSignal?.aborted) return;
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private createHttpTransport(
    definition: ServerDefinition,
    serverName: string,
    client: ManagedClient,
    legacySse = false,
    implicitOAuth = false,
    onAuthChallenge?: (error: Error) => void,
  ): { transport: Transport; oauthProvider: boolean } {
    const serverUrl = resolveServerUrl(definition)!;
    const url = new URL(serverUrl);
    const storageBase = getAuthBaseDir(this.authStorageOptions);
    const runtime = this.oauthRuntime;
    const generation = this.closeGenerations.get(serverName) ?? 0;
    const active = () => !this.stopped && !this.runtimeSignal?.aborted && !runtime?.signal.aborted
      && (this.closeGenerations.get(serverName) ?? 0) === generation;
    let issuer: string | undefined;

    // Resolve secret commands only for this connection attempt, without mutating config.
    const hasCommandHeader = Object.values(definition.headers ?? {})
      .some(value => value.startsWith("!") && !value.startsWith("!!"));
    const headers = resolveCommandSecretsRecord(
      definition.headers,
      key => `MCP server "${serverName}" HTTP header "${key}"`,
    ) ?? {};

    // For bearer auth, add the token to headers BEFORE creating requestInit
    const commandBearer = definition.bearerToken?.startsWith("!") && !definition.bearerToken.startsWith("!!")
      ? definition.bearerToken
      : undefined;
    if (definition.auth === "bearer") {
      const token = commandBearer
        ? resolveCommandSecret(commandBearer, `MCP server "${serverName}" HTTP bearer token`)
        : resolveBearerToken(definition);
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    if (hasCommandHeader || commandBearer) {
      try {
        new Headers(headers);
      } catch {
        throw new Error(`Failed to resolve MCP server "${serverName}" HTTP command secret: command returned an invalid header value`);
      }
    }

    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    const createAuthProvider = (): McpOAuthProvider => new McpOAuthProvider(
      serverName,
      serverUrl,
      extractOAuthConfig(definition),
      {
        onRedirect: async (_authUrl) => {
          // URL is captured by startAuth, no need to log
        },
        onDiscoveryState: state => {
          issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
          if (active()) bindOAuthRequestIssuer(serverName, serverUrl, storageBase, issuer, runtime);
        },
      },
      this.authStorageOptions,
      this.oauthRuntime?.signal,
    );

    const authProvider = supportsOAuth(definition) && (definition.auth === "oauth" || implicitOAuth)
      ? createAuthProvider() : undefined;
    client.oauthProvider = authProvider;
    const options = {
      ...(requestInit !== undefined ? { requestInit } : {}),
      ...(authProvider !== undefined ? { authProvider } : {}),
      skipIssuerMetadataValidation: definition.oauth !== false && definition.oauth?.skipIssuerMetadataValidation === true,
      // Native resource sends carry their own signal; OAuth discovery/token requests do not.
      ...(authProvider ? { fetch: (input: Parameters<FetchLike>[0], init?: RequestInit) =>
        (definition.retryOnTransportFailure === true ? trackToolTransportFailure : fetch)(input, {
          ...init, signal: combineAbortSignals(init?.signal ?? undefined,
            init?.signal ? authProvider.lifetimeSignal : authProvider.signal)!,
        }) } : definition.retryOnTransportFailure === true ? { fetch: trackToolTransportFailure } : {}),
    };
    const transport: Transport = legacySse ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, {
      ...options,
      ...(supportsOAuth(definition) && !isNonInteractiveOAuth(definition.oauth)
        ? { onInsufficientScope: "throw" as const } : {}),
    });
    if (authProvider) {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => authProvider.runWithSignal(options?.requestSignal, () => send(message, options));
      const close = transport.close.bind(transport);
      transport.close = () => {
        // Native OAuth fetches do not inherit the transport's abort signal.
        authProvider.deactivate();
        return close();
      };
    }
    if (!legacySse && supportsOAuth(definition)) {
      const previous = transport.onerror;
      transport.onerror = error => {
        previous?.(error);
        if (!active() || isServerDisabled(definition) || !supportsOAuth(definition) || !isOAuthChallenge(error)) return;
        recordOAuthChallenge(serverName, serverUrl, storageBase, error, runtime);
        // A known issuer was validated by the native discovery hook, never inferred from the challenge.
        if (issuer) {
          const request = getOAuthRequest(serverName, serverUrl, storageBase, runtime);
          if (request && !request.issuer) request.issuer = issuer;
        }
        onAuthChallenge?.(error);
      };
    }
    if (!legacySse && definition.retryOnTransportFailure === true) trackToolHttpFailures(transport);
    return { transport, oauthProvider: authProvider !== undefined };
  }

  private async fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
    return (await client.listTools(undefined, { ...requestOptions, cacheMode: "refresh" })).tools;
  }

  private async fetchAllPrompts(
    client: Client,
    requestOptions?: RequestOptions,
  ): Promise<{ prompts: McpPrompt[]; failed: boolean }> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.prompts) return { prompts: [], failed: false };

    try {
      const { prompts } = await client.listPrompts(undefined, { ...requestOptions, cacheMode: "refresh" });
      return { prompts, failed: false };
    } catch (error) {
      if (requestOptions?.signal?.aborted) throwIfAborted(requestOptions.signal);
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: prompts/list failed: ${message}`);
      return { prompts: [], failed: true };
    }
  }

  private async fetchAllResources(client: Client, requestOptions?: RequestOptions): Promise<McpResource[]> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.resources) return [];

    try {
      return (await client.listResources(undefined, { ...requestOptions, cacheMode: "refresh" })).resources;
    } catch {
      if (requestOptions?.signal?.aborted) {
        throwIfAborted(requestOptions.signal);
      }
      // The server advertises resources but the listing failed
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema.shape.method.value,
      { params: serverStreamResultPatchNotificationSchema.shape.params }, params => {
        this.uiStreamListeners.get(params.streamToken)?.(serverName, params);
      });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async getPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }
    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.getPrompt(
        { name: promptName, ...(args ? { arguments: args } : {}) },
        this.getRequestOptions(name, signal),
      );
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    if (isServerDisabled(this.connections.get(name)?.definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
    this.connectAttempts.get(name)?.abort(new Error(`MCP connection ${name} was closed`));
    const pendingClose = this.closePromises.get(name);
    if (pendingClose) return pendingClose;

    const owned = new Set(this.retiredConnections.get(name));
    const connection = this.connections.get(name);
    if (connection) owned.add(connection);
    // Remove the placeholder before awaiting cleanup; stale callers cannot resurrect it.
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    for (const item of owned) item.status = "closed";
    const pendingConnect = this.connectPromises.get(name);
    const closing = (async () => {
      const results = await Promise.allSettled([
        ...[...owned].map(item => this.disposeConnection(item)),
        pendingConnect?.catch(error => {
          if (this.containsCleanupFailure(error)) throw error;
        }),
      ]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
      this.retiredConnections.delete(name);
    })().finally(() => {
      if (this.closePromises.get(name) === closing) this.closePromises.delete(name);
    });
    this.closePromises.set(name, closing);
    return closing;
  }

  private disposeConnection(connection: ServerConnection): Promise<void> {
    const existing = this.disposePromises.get(connection);
    if (existing) return existing;
    const closing = (async () => {
      const results = await Promise.allSettled([
        // The SDK client owns its transport.
        Promise.resolve().then(() => connection.client.close()),
        this.traceWriter?.flush() ?? Promise.resolve(),
      ]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
    })();
    this.disposePromises.set(connection, closing);
    return closing;
  }

  async closeAll(): Promise<void> {
    this.stopped = true;
    const names = new Set([
      ...this.connections.keys(), ...this.retiredConnections.keys(),
      ...this.connectPromises.keys(), ...this.closePromises.keys(),
    ]);
    const results = await Promise.allSettled([...names].map(name => this.close(name)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    this.uiStreamListeners.clear();
    this.acceptedUrlElicitations.clear();
    this.samplingConfig = undefined;
    this.elicitationConfig = undefined;
    await this.traceWriter?.flush();
    if (failures.length > 0) throw new AggregateError(failures, "MCP manager cleanup failed");
  }

  private containsCleanupFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!(current instanceof Error) || seen.has(current)) continue;
      seen.add(current);
      if (current instanceof AggregateError) {
        if (/cleanup failed|setup failed/.test(current.message)) return true;
        pending.push(...current.errors);
      }
      if (current.cause !== undefined) pending.push(current.cause);
    }
    return false;
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
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env: Record<string, string> | undefined, serverName: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) resolved[key] = value;
  }
  const overrides = resolveCommandSecretsRecord(
    env,
    key => `MCP server "${serverName}" stdio env "${key}"`,
  );
  return overrides ? { ...resolved, ...overrides } : resolved;
}
