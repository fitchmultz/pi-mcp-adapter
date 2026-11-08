import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Init from "./init.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpAdapterHost } from "./host-contract.ts";
import type { McpAdapterOptions, McpConfig, PromptMetadata } from "./types.ts";
import { cloneMcpConfig, loadMcpConfig, isPathInsideProject } from "./config.ts";
import { getMetadataCachePath, loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import { createMcpRuntimeOwner, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import { createOAuthRuntime, shutdownOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { formatTerminalError } from "./utils.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { activateToolSearch, createToolLoader, removedOnBranch } from "./tool-loader.ts";
import { logger } from "./logger.ts";
import { abortable } from "./abort.ts";
import { McpHostCommands } from "./host-commands.ts";
import { McpStateCleanup } from "./host-state-cleanup.ts";
import { McpHostTools } from "./host-tools.ts";

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_WAIT_TIMED_OUT = Symbol("init-wait-timed-out");
async function awaitWithTimeout<T>(promise: Promise<T>): Promise<T | typeof INIT_WAIT_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof INIT_WAIT_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(INIT_WAIT_TIMED_OUT), INIT_WAIT_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class McpHostRuntime implements McpAdapterHost {
  state: McpExtensionState | null = null;
  initPromise: Promise<McpExtensionState> | null = null;
  owner: McpRuntimeOwner | null = null;
  configPath: string | undefined;
  directToolsFrozen = false;
  config: McpConfig;
  readonly programmaticConfig: boolean;
  private readonly pi: ExtensionAPI;
  private readonly options: McpAdapterOptions;
  private readonly sessionConfig: McpConfig | undefined;
  private oauthRuntime: McpOAuthRuntime | null = null;
  private generation = 0;
  private runtimeCwd: string | undefined;
  private initModule: typeof Init | undefined;
  private readonly promptCommands = new Set<string>();
  private readonly envRaw = process.env.MCP_DIRECT_TOOLS;
  private readonly envDirectToolOverride = this.envRaw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  private readonly toolLoader: ReturnType<typeof createToolLoader>;
  private readonly tools: McpHostTools;
  private sessionManager: ExtensionContext["sessionManager"] | undefined;
  /** Whether tool_search activation was decided since the last session start or tree navigation. */
  private toolSearchSettled = false;

  constructor(pi: ExtensionAPI, options: McpAdapterOptions) {
    this.pi = pi;
    this.options = options;
    this.sessionConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
    this.programmaticConfig = this.sessionConfig !== undefined;
    this.config =
      this.sessionConfig !== undefined ? cloneMcpConfig(this.sessionConfig) : { mcpServers: {} };
    this.toolLoader = createToolLoader(pi, {
      getState: () => this.state,
      getInitPromise: () => this.initPromise,
      beforeExecute: options.beforeExecute,
      removedOnBranch: (name) =>
        this.sessionManager !== undefined && removedOnBranch(this.sessionManager, name),
    });
    this.tools = new McpHostTools(pi, this, options);
  }

  install(): void {
    if (!this.options.transformConfig) {
      this.registerPromptCommands(resolveCachedPrompts(this.config, false));
    }
    this.pi.registerFlag("mcp-config", { description: "Path to MCP config file", type: "string" });
    this.registerEvents();
    new McpHostCommands(this.pi, this).register();
    if (!this.options.transformConfig) {
      this.tools.syncGateways(this.config, null, []);
    }
  }

  private registerEvents(): void {
    this.pi.on("session_start", (_event, ctx) => {
      this.sessionManager = ctx.sessionManager;
      this.toolSearchSettled = false;
      this.toolLoader.settlePins();
      return this.startSession(ctx);
    });
    // Pi restores the target branch's recorded loadout before session_tree.
    this.pi.on("session_tree", (_event, ctx) => {
      this.sessionManager = ctx.sessionManager;
      this.toolSearchSettled = false;
      this.toolLoader.settlePins();
      this.activateToolSearch();
    });
    this.pi.on("model_select", () => {
      if (this.state) {
        this.syncToolSurface();
      }
    });
    this.pi.on("before_agent_start", async (_event, ctx) => {
      if (ctx.cwd !== this.runtimeCwd) {
        await this.startSession(ctx);
      }
    });
    this.pi.on("session_shutdown", () => this.shutdown());
  }

  applyDirectToolConfigChanges(changes: Map<string, true | string[] | false>): void {
    if (!this.state) {
      return;
    }
    for (const [name, value] of changes) {
      const definition = this.state.config.mcpServers[name];
      if (definition) {
        this.state.config.mcpServers[name] = { ...definition, directTools: value };
      }
    }
  }

  syncToolSurface(): void {
    const config = this.state?.config ?? this.config;
    this.syncCatalog(config, loadMetadataCache(this.state?.metadataCacheEnabled ?? false));
  }

  private syncCatalog(config: McpConfig, cache: MetadataCache | null): void {
    this.toolLoader.sync(
      config,
      cache,
      this.envRaw === "__none__" ? null : this.envDirectToolOverride,
      (specs) => this.tools.syncGateways(config, cache, specs),
    );
    this.activateToolSearch();
  }

  /** Once per session start or tree navigation, so a later live deselection is not undone. */
  private activateToolSearch(): void {
    if (
      !this.toolSearchSettled &&
      (this.toolLoader.hasDeferred() || this.tools.hasDeferredScript())
    ) {
      this.toolSearchSettled = activateToolSearch(this.pi, this.sessionManager);
    }
  }

  private registerPromptCommands(specs: Iterable<PromptMetadata>): void {
    for (const spec of specs) {
      if (this.promptCommands.has(spec.commandName)) {
        logger.debug(
          `MCP: prompt "${spec.originalName}" on ${spec.serverName} skipped; /${spec.commandName} is already registered`,
        );
        continue;
      }
      this.promptCommands.add(spec.commandName);
      this.pi.registerCommand(
        spec.commandName,
        createPromptCommand(this.pi, () => this.state, spec),
      );
    }
  }

  private syncPromptCommands(): void {
    this.registerPromptCommands([...(this.state?.promptMetadata.values() ?? [])].flat());
  }

  private async shutdownState(state: McpExtensionState | null, reason: string): Promise<void> {
    if (!state) {
      publishMcpStatusShutdown(this.pi.events);
      return;
    }
    await new McpStateCleanup(state).stop(reason, this.initModule?.flushMetadataCache);
  }

  private async shutdown(): Promise<void> {
    ++this.generation;
    const state = this.state;
    const owner = this.owner;
    const oauthRuntime = this.oauthRuntime;
    this.owner = null;
    this.oauthRuntime = null;
    this.state = null;
    this.initPromise = null;
    const stopOwner = owner?.stop("MCP extension session shutdown") ?? Promise.resolve();
    const results = await Promise.allSettled([
      stopOwner,
      this.shutdownState(state, "session_shutdown"),
      oauthRuntime ? shutdownOAuth(oauthRuntime) : Promise.resolve(),
    ]);
    const failures: unknown[] = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP session shutdown persistence/cleanup failed");
    }
  }

  private resolveConfig(ctx: ExtensionContext): McpConfig {
    let config: McpConfig;
    if (this.sessionConfig !== undefined) {
      this.configPath = undefined;
      config = cloneMcpConfig(this.sessionConfig);
    } else {
      const flag = this.pi.getFlag("mcp-config");
      this.configPath = this.options.configPath ?? (typeof flag === "string" ? flag : undefined);
      config = loadMcpConfig(this.configPath, ctx.cwd, { includeProject: ctx.isProjectTrusted() });
    }
    return this.options.transformConfig
      ? cloneMcpConfig(this.options.transformConfig(cloneMcpConfig(config), ctx))
      : config;
  }

  private async startSession(ctx: ExtensionContext): Promise<void> {
    this.runtimeCwd = ctx.cwd;
    this.directToolsFrozen = false;
    const generation = ++this.generation;
    const previousState = this.state;
    const previousOwner = this.owner;
    const previousOAuthRuntime = this.oauthRuntime;
    const owner = createMcpRuntimeOwner();
    const oauthRuntime = createOAuthRuntime(owner.signal);
    this.owner = owner;
    this.oauthRuntime = oauthRuntime;
    this.state = null;
    this.initPromise = null;
    const stopPrevious =
      previousOwner?.stop("MCP extension session restarted") ?? Promise.resolve();
    try {
      await Promise.all([
        stopPrevious,
        this.shutdownState(previousState, "session_restart"),
        previousOAuthRuntime ? shutdownOAuth(previousOAuthRuntime) : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(
        `MCP: failed to shut down previous session state: ${formatTerminalError(error)}`,
      );
    }
    if (!this.isCurrent(owner, generation)) {
      return;
    }
    const runtimeConfig = this.resolveConfig(ctx);
    this.config = runtimeConfig;
    const cacheEnabled =
      ctx.isProjectTrusted() || !isPathInsideProject(getMetadataCachePath(), ctx.cwd);
    this.registerPromptCommands(resolveCachedPrompts(runtimeConfig, cacheEnabled));
    const cache = loadMetadataCache(cacheEnabled);
    this.syncCatalog(runtimeConfig, cache);
    const init = await import("./init.ts");
    this.initModule = init;
    if (!this.isCurrent(owner, generation)) {
      return;
    }
    const initialization = this.startInitialization({
      init,
      ctx,
      owner,
      oauthRuntime,
      runtimeConfig,
      generation,
    });
    if (this.shouldAwaitInitialization(runtimeConfig, cache)) {
      await initialization;
    }
  }

  private isCurrent(owner: McpRuntimeOwner, generation: number): boolean {
    return generation === this.generation && owner.isActive();
  }

  private shouldAwaitInitialization(config: McpConfig, cache: MetadataCache | null): boolean {
    return (
      this.envRaw !== undefined &&
      this.envRaw !== "__none__" &&
      getMissingConfiguredDirectToolServers(config, cache, this.envDirectToolOverride).length > 0
    );
  }

  private startInitialization(input: Initialization): Promise<void> {
    const { init, ctx, owner, oauthRuntime, runtimeConfig, generation } = input;
    const promise = init.initializeMcp(this.pi, ctx, owner, {
      ...(this.programmaticConfig ? { config: runtimeConfig } : { resolvedConfig: runtimeConfig }),
      ...(this.options.outputDirectory !== undefined
        ? { outputDirectory: this.options.outputDirectory }
        : {}),
      oauthRuntime,
      statusEvents: this.pi.events,
      ...(this.options.onToolCall ? { onToolCall: this.options.onToolCall } : {}),
    });
    this.initPromise = promise;
    return promise
      .then(async (state) => {
        if (!owner.isActive() || generation !== this.generation || this.initPromise !== promise) {
          try {
            await this.shutdownState(state, "stale_session_start");
          } catch (error) {
            console.error(
              `MCP: failed to clean stale initialization state: ${formatTerminalError(error)}`,
            );
          }
          return;
        }
        this.state = state;
        this.bindMetadataUpdates(owner);
        await this.completeInitialization(input);
        return;
      })
      .catch((error: unknown) => this.rejectInitialization(input, promise, error));
  }

  private bindMetadataUpdates(owner: McpRuntimeOwner): void {
    const state = this.state;
    if (!state) {
      return;
    }
    state.onToolMetadataUpdated = (server, reason) => {
      if (this.state !== state || !owner.isActive()) {
        return;
      }
      this.syncPromptCommands();
      if (this.directToolsFrozen) {
        logger.debug(`MCP: metadata update for ${server} (${reason}) skipped — directTools frozen`);
        return;
      }
      this.syncToolSurface();
    };
  }

  private async completeInitialization({ init, owner }: Initialization): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    owner.throwIfInactive();
    this.syncPromptCommands();
    this.syncToolSurface();
    init.updateStatusBar(state);
    this.initPromise = null;
    if (state.config.settings?.freezeDirectTools === true) {
      this.directToolsFrozen = true;
      logger.info(
        'MCP: direct tools frozen after initial sync — reconnects won\'t rebuild the system prompt; use mcp({ action: "connect", server: "server" }) to rediscover',
      );
    }
  }

  private async rejectInitialization(
    input: Initialization,
    promise: Promise<McpExtensionState>,
    error: unknown,
  ): Promise<void> {
    const { owner, generation, oauthRuntime } = input;
    if (
      !owner.isActive() ||
      generation !== this.generation ||
      (this.initPromise !== promise && this.initPromise !== null)
    ) {
      return;
    }
    console.error(`MCP initialization failed: ${formatTerminalError(error)}`);
    this.initPromise = null;
    if (this.state) {
      return;
    }
    try {
      await Promise.all([owner.stop("MCP initialization failed"), shutdownOAuth(oauthRuntime)]);
    } catch (cleanupError) {
      console.error(
        `MCP: failed to clean rejected initialization: ${formatTerminalError(cleanupError)}`,
      );
    }
  }

  async ensureCommandState(
    owner: McpRuntimeOwner | null,
    ctx: ExtensionContext,
  ): Promise<McpExtensionState | null> {
    if (!this.state && this.initPromise) {
      try {
        const initialized = await this.initPromise;
        owner?.throwIfInactive();
        this.state = initialized;
      } catch (error) {
        ctx.ui.notify(
          `MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return null;
      }
    }
    if (!this.state) {
      ctx.ui.notify("MCP not initialized", "error");
    }
    return this.state;
  }

  async getToolState(signal?: AbortSignal): ReturnType<McpAdapterHost["getToolState"]> {
    const owner = this.owner;
    if (!this.state && this.initPromise) {
      try {
        const initialized = await awaitWithTimeout(abortable(this.initPromise, signal));
        if (initialized === INIT_WAIT_TIMED_OUT) {
          return {
            content: [
              { type: "text", text: "MCP initialization is still in progress. Try again shortly." },
            ],
            details: { error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
          };
        }
        owner?.throwIfInactive();
        this.state = initialized;
      } catch (error) {
        if (cancelled(owner, signal, error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    owner?.throwIfInactive();
    return (
      this.state ?? {
        content: [{ type: "text", text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      }
    );
  }
}

type Initialization = {
  init: typeof Init;
  ctx: ExtensionContext;
  owner: McpRuntimeOwner;
  oauthRuntime: McpOAuthRuntime;
  runtimeConfig: McpConfig;
  generation: number;
};

function cancelled(
  owner: McpRuntimeOwner | null,
  signal: AbortSignal | undefined,
  error: unknown,
): boolean {
  return signal?.aborted === true || (owner !== null && isAbortError(error, owner.signal));
}
