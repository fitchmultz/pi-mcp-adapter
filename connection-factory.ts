import type { Client, RequestOptions, Transport } from "@modelcontextprotocol/client";
import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ManagedClient } from "./connection-runtime.ts";
import type { ServerConnection } from "./server-connection.ts";
import { supportsOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { getAuthBaseDir, type AuthStorageOptions } from "./mcp-auth.ts";
import {
  type ServerDefinition,
  type McpTraceSettings,
  type McpTool,
  type McpResource,
  type McpPrompt,
  validateServerProtocolConfig,
} from "./types.ts";
import { normalizeRequestTimeoutMs, resolveConfigPath, resolveServerUrl } from "./utils.ts";
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
  createStdioConnection,
  resolveStdioCommand,
  StdioDiagnostics,
} from "./connection-stdio.ts";
import { drainClientCallbacks } from "./client-operations.ts";
import { logger } from "./logger.ts";
import { cleanupFailures } from "./connection-disposal.ts";

import { ConnectionHandshake } from "./connection-handshake.ts";

export class ConnectionFactory {
  authStorageOptions: AuthStorageOptions = {};
  oauthRuntime: McpOAuthRuntime | undefined;
  defaultRequestTimeoutMs: number | undefined;
  traceSettings: McpTraceSettings | undefined;
  private traceWriter: McpTraceWriter | undefined;

  readonly lifecycle: ConnectionLifecycle;
  readonly callbacks: ConnectionCallbacks;
  readonly defaultCwd: string | undefined;

  constructor(
    lifecycle: ConnectionLifecycle,
    callbacks: ConnectionCallbacks,
    defaultCwd: string | undefined,
  ) {
    this.lifecycle = lifecycle;
    this.callbacks = callbacks;
    this.defaultCwd = defaultCwd;
  }

  flushTrace(): Promise<void> | undefined {
    return this.traceWriter?.flush();
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
    const runtime = await import("./connection-runtime.ts");
    throwIfAborted(signal);
    // createClient claims the client into disposal. From here until setup.connect takes over,
    // the factory owns that claim: any failure below must release it, or the never-connected
    // client survives until final closeAll.
    const client = this.callbacks.createClient(name, definition, runtime);
    let connect: () => Promise<ServerConnection>;
    try {
      const trace = this.trace(definition);
      const implicitOAuth =
        typeof definition.url === "string" &&
        definition.url.length > 0 &&
        supportsOAuth(definition) &&
        this.oauthRuntime !== undefined &&
        runtime.getOAuthRequest(
          name,
          resolveServerUrl(definition) ?? "",
          getAuthBaseDir(this.authStorageOptions),
          this.oauthRuntime,
        ) !== undefined;
      const configuredTransports = [definition.command, definition.url, definition.socket].filter(
        (value) => typeof value === "string" && value.length > 0,
      );
      if (configuredTransports.length !== 1) {
        throw new Error(`Server ${name} must configure exactly one of command, url, or socket`);
      }
      const setup = new ConnectionSetup(
        { factory: this, runtime, name, definition, signal, requestSignal, trace },
        client,
        implicitOAuth,
      );
      const resolving = setup.resolveCommand();
      const built = resolving ? setup.prepare(await resolving) : setup.prepare();
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
    if (command !== "npx" && command !== "npm") {
      return;
    }
    const { name, signal } = this.options;
    return resolveStdioCommand(command, args, { name, signal });
  }

  prepare(command: StdioCommand = this.command): Transport {
    const { runtime, definition, signal, factory, name } = this.options;
    let transport: Transport;
    if (typeof definition.command === "string" && definition.command.length > 0) {
      transport = createStdioConnection(runtime, definition, this.stderr, {
        name,
        defaultCwd: factory.defaultCwd,
        signal,
        ...command,
      });
    } else if (typeof definition.url === "string" && definition.url.length > 0) {
      transport = this.createHttp();
    } else {
      transport = new runtime.UnixSocketClientTransport(resolveConfigPath(definition.socket) ?? "");
    }
    if (typeof definition.url !== "string" || definition.url.length === 0) {
      runtime.trackToolTransport(transport);
    }
    const traced = this.traceTransport(transport);
    throwIfAborted(signal);
    return traced;
  }

  private createHttp(): Transport {
    const { factory, runtime, definition, name } = this.options;
    const result = createHttpConnection({
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
    return this.traceTransport(this.createHttp());
  }

  private async handshake(transport: Transport): Promise<Transport | undefined> {
    const { runtime, definition, signal, requestSignal, factory } = this.options;
    try {
      await new ConnectionHandshake(
        this.client,
        transport,
        factory.requestOptions(definition, requestSignal),
        signal,
      ).run();
      return;
    } catch (error) {
      // Only handshake failures establish that HTTP is unsupported.
      if (
        typeof definition.url !== "string" ||
        definition.url.length === 0 ||
        signal?.aborted === true ||
        this.attempt.transport === "legacy-sse" ||
        !(error instanceof runtime.SdkHttpError) ||
        ![404, 405, 406, 415].includes(error.status)
      ) {
        throw error;
      }
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
      if (!this.canActivateOAuth(error)) {
        throw error;
      }
      this.attempt = { ...this.attempt, auth: "implicit-oauth" };
      return { kind: "retry", transport: await this.replaceClient() };
    }
  }

  private canActivateOAuth(error: unknown): boolean {
    const { definition, signal, runtime } = this.options;
    return (
      typeof definition.url === "string" &&
      definition.url.length > 0 &&
      signal?.aborted !== true &&
      this.attempt.auth === "configured" &&
      definition.auth === undefined &&
      supportsOAuth(definition) &&
      runtime.isOAuthChallenge(error)
    );
  }

  private connection(transport: Transport, status: ServerConnection["status"]): ServerConnection {
    return {
      client: this.client,
      transport,
      definition: this.options.definition,
      tools: [],
      resources: [],
      prompts: [],
      lastUsedAt: Date.now(),
      status,
      oauthProvider: this.oauthProvider,
    };
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
    const [tools, resources, promptResult] = await Promise.all(catalogs);
    connection.tools = tools;
    connection.resources = resources;
    connection.prompts = promptResult.prompts;
    connection.promptDiscoveryFailed = promptResult.failed;
    return connection;
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
    factory.lifecycle.disposal.releaseWhenSettled(this.client);
    const failures: unknown[] = cleanupFailures(results);
    if (runtime.isOAuthChallenge(failure) && supportsOAuth(definition) && failures.length === 0) {
      const connection = this.connection(transport, "needs-auth");
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

async function fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
  return (await client.listTools(undefined, { ...requestOptions, cacheMode: "refresh" })).tools;
}

async function fetchAllPrompts(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<{ prompts: McpPrompt[]; failed: boolean }> {
  if (!client.getServerCapabilities()?.prompts) {
    return { prompts: [], failed: false };
  }
  try {
    return {
      prompts: (await client.listPrompts(undefined, { ...requestOptions, cacheMode: "refresh" }))
        .prompts,
      failed: false,
    };
  } catch (error) {
    if (requestOptions?.signal?.aborted === true) {
      throwIfAborted(requestOptions.signal);
    }
    logger.debug(
      `MCP: prompts/list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { prompts: [], failed: true };
  }
}

async function fetchAllResources(
  client: Client,
  requestOptions?: RequestOptions,
): Promise<McpResource[]> {
  if (!client.getServerCapabilities()?.resources) {
    return [];
  }
  try {
    return (await client.listResources(undefined, { ...requestOptions, cacheMode: "refresh" }))
      .resources;
  } catch {
    if (requestOptions?.signal?.aborted === true) {
      throwIfAborted(requestOptions.signal);
    }
    return [];
  }
}
