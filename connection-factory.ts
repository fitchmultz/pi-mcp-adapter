import type { ConnectOptions, RequestOptions, Transport } from "@modelcontextprotocol/client";
import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ManagedClient } from "./connection-runtime.ts";
import type { ServerConnection } from "./server-connection.ts";
import {
  getOAuthRequest,
  hasUnsatisfiedScope,
  supportsOAuth,
  type McpOAuthRuntime,
} from "./mcp-oauth-runtime.ts";
import { hasUsableStoredTokens, matchesTokenSnapshot } from "./mcp-oauth-refresh.ts";
import {
  getAuthBaseDir,
  inspectAuthForUrl,
  type AuthStorageOptions,
  type TokenSnapshot,
} from "./mcp-auth.ts";
import {
  type CachedPriorDiscovery,
  type ServerDefinition,
  type McpTraceSettings,
  validateServerProtocolConfig,
} from "./types.ts";
import {
  hasServerUrl,
  normalizeRequestTimeoutMs,
  resolveConfigPath,
  resolveServerUrl,
} from "./utils.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import {
  createMcpTraceWriter,
  isMcpTraceEnabled,
  type McpTraceWriter,
  type McpTraceObserver,
  traceTransportKind,
  wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";
import type { ConnectionLifecycle } from "./connection-lifecycle.ts";
import type { ConnectionCallbacks } from "./connection-callbacks.ts";
import { createHttpConnection } from "./connection-http.ts";
import {
  attachStdioDiagnostics,
  createStdioConnection,
  resolveStdioCommand,
  StdioDiagnostics,
} from "./connection-stdio.ts";
import { isResolvableNpxCommand } from "./npx-invocation.ts";
import {
  PriorDiscoveryCache,
  capturePriorDiscovery,
  safeResolveServerUrl,
  supportsPriorDiscovery,
  toSdkPriorDiscovery,
} from "./prior-discovery.ts";
import { drainClientCallbacks } from "./client-operations.ts";
import { cleanupFailures } from "./connection-disposal.ts";
import {
  fetchAllPrompts,
  fetchAllResources,
  fetchAllResourceTemplates,
  fetchAllTools,
} from "./connection-discovery.ts";

import { ConnectionHandshake } from "./connection-handshake.ts";

let connectionRuntimePromise: Promise<typeof ConnectionRuntime> | undefined;

function loadConnectionRuntime(): Promise<typeof ConnectionRuntime> {
  connectionRuntimePromise ??= import("./connection-runtime.ts").catch((error: unknown) => {
    connectionRuntimePromise = undefined;
    throw error;
  });
  return connectionRuntimePromise;
}
export class ConnectionFactory {
  authStorageOptions: AuthStorageOptions = {};
  oauthRuntime: McpOAuthRuntime | undefined;
  defaultRequestTimeoutMs: number | undefined;
  traceSettings: McpTraceSettings | undefined;
  readonly priorDiscovery = new PriorDiscoveryCache();
  private traceWriter: McpTraceWriter | undefined;
  private readonly needsAuthTokens = new WeakMap<ServerConnection, TokenSnapshot | undefined>();
  private readonly retiredTraceWriters: McpTraceWriter[] = [];

  readonly lifecycle: ConnectionLifecycle;
  readonly callbacks: ConnectionCallbacks;
  defaultCwd: string | undefined;

  constructor(
    lifecycle: ConnectionLifecycle,
    callbacks: ConnectionCallbacks,
    defaultCwd: string | undefined,
  ) {
    this.lifecycle = lifecycle;
    this.callbacks = callbacks;
    this.defaultCwd = defaultCwd;
  }

  resetTraceWriter(): void {
    if (this.traceWriter) {
      this.retiredTraceWriters.push(this.traceWriter);
      this.traceWriter = undefined;
    }
  }

  async flushTrace(): Promise<void> {
    const writers = [
      ...this.retiredTraceWriters.splice(0),
      ...(this.traceWriter ? [this.traceWriter] : []),
    ];
    await Promise.all(writers.map((writer) => writer.flush()));
  }

  recordNeedsAuth(connection: ServerConnection, snapshot: TokenSnapshot | undefined): void {
    this.needsAuthTokens.set(connection, snapshot);
  }

  private requiredOAuthScope(name: string, serverUrl: string): string | undefined {
    const request = this.oauthRuntime
      ? getOAuthRequest(name, serverUrl, getAuthBaseDir(this.authStorageOptions), this.oauthRuntime)
      : undefined;
    return request?.challenge?.requiredScope ?? request?.discovered?.scope;
  }

  async hasFreshOAuthCredentials(
    name: string,
    definition: ServerDefinition,
    stale: ServerConnection,
  ): Promise<boolean> {
    const serverUrl = supportsOAuth(definition) ? safeResolveServerUrl(definition) : undefined;
    if (serverUrl === undefined) {
      return false;
    }
    const status = await inspectAuthForUrl(
      { serverName: name, serverUrl },
      this.authStorageOptions,
    );
    const tokens = status.status === "present" ? status.entry.tokens : undefined;
    if (
      !tokens ||
      !hasUsableStoredTokens(tokens) ||
      matchesTokenSnapshot(this.needsAuthTokens.get(stale), tokens)
    ) {
      return false;
    }
    return !hasUnsatisfiedScope(this.requiredOAuthScope(name, serverUrl), tokens.scope);
  }

  requestOptions(definition?: ServerDefinition, signal?: AbortSignal): RequestOptions | undefined {
    const timeout =
      definition?.requestTimeoutMs !== undefined
        ? normalizeRequestTimeoutMs(definition.requestTimeoutMs)
        : this.defaultRequestTimeoutMs;
    const ownedSignal = combineAbortSignals(this.lifecycle.runtimeSignal, signal);
    if (!ownedSignal && timeout === undefined) {
      return undefined;
    }
    return {
      ...(ownedSignal ? { signal: ownedSignal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  private trace(definition: ServerDefinition): McpTraceObserver | undefined {
    if (!isMcpTraceEnabled(definition, this.traceSettings)) {
      return undefined;
    }
    this.traceWriter ??= createMcpTraceWriter(this.defaultCwd, this.traceSettings ?? {});
    const writer = this.traceWriter;
    return { record: (event) => writer.write(event) };
  }

  async create(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    requestSignal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    validateServerProtocolConfig(definition);
    const runtime = await loadConnectionRuntime();
    throwIfAborted(signal);
    // createClient claims the client into disposal. From here until setup.connect takes over,
    // the factory owns that claim: any failure below must release it, or the never-connected
    // client survives until final closeAll.
    const client = this.callbacks.createClient(name, definition, runtime);
    let connect: () => Promise<ServerConnection>;
    try {
      const trace = this.trace(definition);
      const implicitOAuth =
        supportsOAuth(definition) &&
        this.oauthRuntime !== undefined &&
        runtime.getOAuthRequest(
          name,
          resolveServerUrl(definition) ?? "",
          getAuthBaseDir(this.authStorageOptions),
          this.oauthRuntime,
        ) !== undefined;
      const localTransports = [definition.command, definition.socket].filter(
        (value) => typeof value === "string" && value.length > 0,
      );
      if (localTransports.length + Number(hasServerUrl(definition)) !== 1) {
        throw new Error(`Server ${name} must configure exactly one of command, url, or socket`);
      }
      const setup = new ConnectionSetup(
        { factory: this, runtime, name, definition, signal, requestSignal, trace },
        client,
        implicitOAuth,
      );
      const resolving = setup.resolveCommand();
      const built = await (resolving ? setup.prepare(await resolving) : setup.prepare());
      // connect() takes over the claim from here: its own failure path closes and releases
      // the client, so this catch must only see failures from before connect() starts.
      connect = () => setup.connect(built);
    } catch (error) {
      // Release a client claimed for an attempt that failed before connect() took over. The
      // attempt's transport either was never built or failed to build inside prepare(); an
      // unbuilt transport never started and holds nothing to close. Cleanup failures aggregate
      // with the original failure, matching ConnectionSetup.failSetup.
      const results = await Promise.allSettled([Promise.resolve().then(() => client.close())]);
      this.lifecycle.disposal.releaseWhenSettled(client);
      const failures = cleanupFailures(results);
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], "MCP connection setup failed", {
          cause: error,
        });
      }
      throw error;
    }
    return connect();
  }
}

type SetupOptions = {
  factory: ConnectionFactory;
  runtime: typeof ConnectionRuntime;
  name: string;
  definition: ServerDefinition;
  signal: AbortSignal | undefined;
  requestSignal: AbortSignal | undefined;
  trace: McpTraceObserver | undefined;
};

type StdioCommand = Awaited<ReturnType<typeof resolveStdioCommand>>;

/**
 * Which transport and auth flavour this connection attempt is on.
 *
 * A Streamable HTTP server that rejects the handshake falls back to the legacy SSE transport, and a
 * server that answers with an OAuth challenge is retried with the provider attached. Those used to
 * be one-way booleans, so the current attempt had to be reconstructed from three flags.
 */
type SetupAttempt = {
  transport: "streamable-http" | "legacy-sse";
  auth: "configured" | "implicit-oauth";
};

class ConnectionSetup {
  private attempt: SetupAttempt;
  private oauthProvider = false;
  private authError: Error | undefined;
  private usedPrior: CachedPriorDiscovery | undefined;
  private bypassPrior = false;
  private readonly stderr = new StdioDiagnostics();

  private readonly options: SetupOptions;
  private client: ManagedClient;
  private readonly command: StdioCommand;

  constructor(options: SetupOptions, client: ManagedClient, implicitOAuth: boolean) {
    this.options = options;
    this.client = client;
    this.attempt = {
      transport: "streamable-http",
      auth: implicitOAuth ? "implicit-oauth" : "configured",
    };
    this.command = {
      command: options.definition.command ?? "",
      args: options.definition.args ?? [],
    };
  }

  resolveCommand(): Promise<StdioCommand> | undefined {
    const { command, args } = this.command;
    if (!isResolvableNpxCommand(command)) {
      return;
    }
    const { name, signal } = this.options;
    return resolveStdioCommand(command, args, { name, signal });
  }

  async prepare(command: StdioCommand = this.command): Promise<Transport> {
    const { runtime, definition, signal, factory, name } = this.options;
    let transport: Transport;
    if (typeof definition.command === "string" && definition.command.length > 0) {
      transport = await createStdioConnection(runtime, definition, this.stderr, {
        name,
        defaultCwd: factory.defaultCwd,
        signal,
        ...command,
      });
    } else if (hasServerUrl(definition)) {
      transport = await this.createHttp();
    } else {
      transport = new runtime.UnixSocketClientTransport(resolveConfigPath(definition.socket) ?? "");
    }
    if (!hasServerUrl(definition)) {
      runtime.trackToolTransport(transport);
    }
    const traced = this.traceTransport(transport);
    throwIfAborted(signal);
    return traced;
  }

  private async createHttp(): Promise<Transport> {
    const { factory, runtime, definition, name, signal } = this.options;
    const result = await createHttpConnection({
      runtime,
      definition,
      serverName: name,
      client: this.client,
      legacySse: this.attempt.transport === "legacy-sse",
      implicitOAuth: this.attempt.auth === "implicit-oauth",
      onAuthChallenge: (error) => {
        this.authError = error;
      },
      authStorageOptions: factory.authStorageOptions,
      oauthRuntime: factory.oauthRuntime,
      lifecycle: factory.lifecycle,
      signal,
    });
    this.oauthProvider = result.oauthProvider;
    return result.transport;
  }

  private traceTransport(transport: Transport): Transport {
    const { trace, definition, name } = this.options;
    return trace
      ? wrapTransportWithMcpTrace(transport, name, traceTransportKind(definition, transport), trace)
      : transport;
  }

  private async replaceClient(): Promise<Transport> {
    await this.client.close();
    this.options.factory.lifecycle.disposal.releaseWhenSettled(this.client);
    const { factory, name, definition, runtime } = this.options;
    this.client = factory.callbacks.createClient(
      name,
      this.attempt.transport === "legacy-sse"
        ? { ...definition, protocolVersion: "legacy" }
        : definition,
      runtime,
    );
    return this.traceTransport(await this.createHttp());
  }

  private selectPrior(): CachedPriorDiscovery | undefined {
    if (this.bypassPrior || this.attempt.transport !== "streamable-http") {
      return undefined;
    }
    return this.options.factory.priorDiscovery.get(this.options.name, this.options.definition);
  }

  private async handshake(transport: Transport): Promise<Transport | undefined> {
    const { runtime, definition, signal, requestSignal, factory, name } = this.options;
    const prior = this.selectPrior();
    this.usedPrior = prior;
    const baseOptions = factory.requestOptions(definition, requestSignal);
    const connectOptions: ConnectOptions | undefined =
      prior !== undefined ? { ...baseOptions, prior: toSdkPriorDiscovery(prior) } : baseOptions;
    try {
      await new ConnectionHandshake(this.client, transport, connectOptions, signal).run();
      return;
    } catch (error) {
      // Only handshake failures establish that HTTP is unsupported.
      if (
        !hasServerUrl(definition) ||
        signal?.aborted === true ||
        this.attempt.transport === "legacy-sse" ||
        !(error instanceof runtime.SdkHttpError) ||
        ![404, 405, 406, 415].includes(error.status)
      ) {
        throw error;
      }
      factory.priorDiscovery.invalidate(name);
      this.attempt = { ...this.attempt, transport: "legacy-sse" };
      return await this.replaceClient();
    }
  }

  async connect(initial: Transport): Promise<ServerConnection> {
    let transport = initial;
    try {
      for (;;) {
        const result = await this.tryConnect(transport);
        if (result.kind === "connected") {
          return result.connection;
        }
        transport = result.transport;
      }
    } catch (error) {
      return this.failSetup(error, transport);
    }
  }

  private async tryConnect(
    transport: Transport,
  ): Promise<
    { kind: "connected"; connection: ServerConnection } | { kind: "retry"; transport: Transport }
  > {
    this.authError = undefined;
    try {
      const fallback = await this.handshake(transport);
      if (fallback) {
        return { kind: "retry", transport: fallback };
      }
      return { kind: "connected", connection: await this.discover(transport) };
    } catch (error) {
      if (this.canActivateOAuth(error)) {
        if (this.usedPrior !== undefined) {
          this.invalidateStalePrior();
        }
        this.attempt = { ...this.attempt, auth: "implicit-oauth" };
        return { kind: "retry", transport: await this.replaceClient() };
      }
      if (this.usedPrior !== undefined && this.options.signal?.aborted !== true) {
        this.invalidateStalePrior();
        return { kind: "retry", transport: await this.replaceClient() };
      }
      throw error;
    }
  }

  private invalidateStalePrior(): void {
    this.options.factory.priorDiscovery.invalidate(this.options.name);
    this.bypassPrior = true;
    this.usedPrior = undefined;
  }

  private canActivateOAuth(error: unknown): boolean {
    const { definition, signal, runtime } = this.options;
    return (
      signal?.aborted !== true &&
      this.attempt.auth === "configured" &&
      definition.auth === undefined &&
      supportsOAuth(definition) &&
      runtime.isOAuthChallenge(error)
    );
  }

  private connection(transport: Transport, status: ServerConnection["status"]): ServerConnection {
    const isStdio =
      typeof this.options.definition.command === "string" &&
      this.options.definition.command.length > 0;
    const connection: ServerConnection = {
      client: this.client,
      transport,
      definition: this.options.definition,
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status,
      oauthProvider: this.oauthProvider,
      ...(isStdio ? { getStderrTail: () => this.stderr.getTail() } : {}),
    };
    if (isStdio) {
      attachStdioDiagnostics(connection, this.stderr);
    }
    return connection;
  }

  private async discover(transport: Transport): Promise<ServerConnection> {
    const { factory, runtime, name, definition, signal } = this.options;
    factory.callbacks.attachAdapterNotificationHandlers(
      name,
      this.client,
      runtime.serverStreamResultPatchNotificationSchema,
    );
    const instructions = this.client.getInstructions();
    const connection = this.connection(transport, "connected");
    if (instructions !== undefined) {
      connection.instructions = instructions;
    }
    // Track closure during discovery, for this client's connection only.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-010: native Client exposes a callback, not EventTarget.
    this.client.onclose = () => {
      connection.status = "closed";
    };
    const requestOptions = factory.requestOptions(definition, signal);
    const catalogs = [
      fetchAllTools(this.client, requestOptions),
      fetchAllResources(this.client, requestOptions),
      fetchAllResourceTemplates(this.client, requestOptions),
      fetchAllPrompts(this.client, requestOptions),
    ] as const;
    const [toolResult] = await Promise.allSettled(catalogs);
    throwIfAborted(signal);
    if (toolResult.status === "rejected" && !runtime.isOAuthChallenge(toolResult.reason)) {
      const reason: unknown = toolResult.reason;
      return Promise.reject(reason);
    }
    if (this.authError) {
      throw this.authError;
    }
    const [tools, resources, resourceTemplates, promptResult] = await Promise.all(catalogs);
    connection.tools = tools;
    connection.resources = resources;
    connection.resourceTemplates = resourceTemplates;
    connection.prompts = promptResult.prompts;
    connection.promptDiscoveryFailed = promptResult.failed;
    const priorDiscovery = this.recordPriorDiscovery();
    if (priorDiscovery !== undefined) {
      connection.priorDiscovery = priorDiscovery;
    }
    await factory.callbacks.prepareSubscription(name, connection, {
      priorModern: this.usedPrior?.kind === "modern",
      ...(requestOptions !== undefined ? { requestOptions } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    return connection;
  }

  private recordPriorDiscovery(): CachedPriorDiscovery | undefined {
    const { factory, name, definition } = this.options;
    if (this.attempt.transport !== "streamable-http" || !supportsPriorDiscovery(definition)) {
      return undefined;
    }
    const captured = capturePriorDiscovery(this.client, this.usedPrior);
    if (captured !== undefined) {
      factory.priorDiscovery.record(name, definition, captured);
    }
    return captured;
  }

  private async failSetup(failure: unknown, transport: Transport): Promise<ServerConnection> {
    const { factory, runtime, definition } = this.options;
    const abortCleanup = ConnectionHandshake.cleanup(transport);
    const abortCleanupFailed =
      failure instanceof AggregateError &&
      failure.message === "MCP connection abort cleanup failed";
    const results = abortCleanupFailed
      ? []
      : await Promise.allSettled([
          abortCleanup ?? Promise.resolve().then(() => this.client.close()),
        ]);
    await drainClientCallbacks(this.client);
    this.stderr.detach();
    factory.lifecycle.disposal.releaseWhenSettled(this.client);
    const failures: unknown[] = cleanupFailures(results);
    if (runtime.isOAuthChallenge(failure) && supportsOAuth(definition) && failures.length === 0) {
      const connection = this.connection(transport, "needs-auth");
      factory.recordNeedsAuth(connection, this.client.oauthProvider?.lastObservedTokenSnapshot);
      factory.lifecycle.disposal.markDisposed(connection);
      return connection;
    }
    const reported =
      failures.length > 0
        ? new AggregateError([failure, ...failures], "MCP connection setup failed")
        : failure;
    return Promise.reject(this.stderr.report(reported));
  }
}
