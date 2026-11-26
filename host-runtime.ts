import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Init from "./init.ts";
import type { McpExtensionState } from "./state.ts";
import { isBuiltinMcpActive, type McpAdapterHost } from "./host-contract.ts";
import type { McpAdapterOptions, McpConfig } from "./types.ts";
import { cloneMcpConfig, isPathInsideProject } from "./config.ts";
import { getMetadataCachePath, loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import { createMcpRuntimeOwner, type McpRuntimeOwner } from "./runtime-owner.ts";
import { createOAuthRuntime, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { formatTerminalError } from "./utils.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { activateToolSearch, createToolLoader, removedOnBranch } from "./tool-loader.ts";
import { logger } from "./logger.ts";
import { McpHostCommands } from "./host-commands.ts";
import {
  HostPromptRegistry,
  registerFallbackMcpToolRenderer,
  resolveHostConfig,
  stageHostReconcile,
  withDirectToolOverrides,
} from "./host-registered-servers.ts";
import { canPreserveFrozenTools, HostSession } from "./host-session.ts";
import {
  HostReconcileCoordinator,
  stopRejectedInitialization,
  stopRuntimeSession,
  stopStaleInitState,
} from "./host-state-cleanup.ts";
import { McpHostTools } from "./host-tools.ts";
import {
  registerWorkingSessionSaveHandler,
  WorkingSessionCoordinator,
  type DeferredToolSurfaceActions,
} from "./host-working-session.ts";
import { consumeStateUiModelContext } from "./ui-session-events.ts";

/**
 * Owns registrations for the host's lifetime. Pi registrations survive session
 * swaps, so handlers borrow current state at invocation rather than capture a
 * session's UI, manager or approval map.
 */
export class McpHostRuntime implements McpAdapterHost {
  private readonly session = new HostSession();
  configPath: string | undefined;
  directToolsFrozen = false;
  config: McpConfig;
  readonly programmaticConfig: boolean;
  private readonly pi: ExtensionAPI;
  private readonly options: McpAdapterOptions;
  private readonly sessionConfig: McpConfig | undefined;
  private oauthRuntime: McpOAuthRuntime | null = null;
  private runtimeCwd: string | undefined;
  private runtimeCacheEnabled: boolean | undefined;
  private initModule: typeof Init | undefined;
  private readonly prompts: HostPromptRegistry;
  private readonly workingSession = new WorkingSessionCoordinator();
  private readonly reconcile = new HostReconcileCoordinator();
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

  get state(): McpExtensionState | null {
    return this.session.currentState;
  }

  get initPromise(): Promise<McpExtensionState> | null {
    return this.session.pendingInitialization;
  }

  get owner(): McpRuntimeOwner | null {
    return this.session.currentOwner;
  }

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
    this.prompts = new HostPromptRegistry(pi, () => this.state);
    this.tools = new McpHostTools(pi, this, options);
  }

  install(): void {
    registerFallbackMcpToolRenderer(
      this.pi,
      () => this.state?.config ?? this.config,
      () => this.state?.metadataCacheEnabled ?? this.runtimeCacheEnabled ?? false,
    );
    if (!this.options.transformConfig) {
      this.prompts.syncCached(this.config, false);
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
      this.settlePinsOrDefer();
      return this.startSession(ctx);
    });
    // Pi restores the target branch's recorded loadout before session_tree.
    this.pi.on("session_tree", (_event, ctx) => {
      this.sessionManager = ctx.sessionManager;
      this.toolSearchSettled = false;
      this.settlePinsOrDefer();
      this.activateToolSearch();
    });
    this.pi.on("model_select", () => {
      if (this.state && !this.directToolsFrozen) {
        this.syncToolSurface();
      } else if (this.state && this.directToolsFrozen) {
        logger.debug("MCP: model_select tool surface sync skipped — directTools frozen");
      }
    });
    this.pi.on("before_agent_start", async (event, ctx) => {
      if (this.runtimeCwd === undefined) {
        await this.startSession(ctx, this.directToolsFrozen);
      } else if (ctx.cwd !== this.runtimeCwd || this.reconcile.retryPending) {
        await this.syncWorkingDirectory(ctx);
      }
      if (event.messageType !== "user") {
        return;
      }
      return consumeStateUiModelContext(this.state);
    });
    if (!this.programmaticConfig) {
      this.pi.on("mcp_servers_change", (_event, ctx) => this.handleMcpServersChange(ctx));
    }
    registerWorkingSessionSaveHandler(this.pi, (event) =>
      this.workingSession.handleSave(
        event,
        this.workingSession.collectBlockers(this.state, this.oauthRuntime),
        (actions) => this.flushDeferredToolSurface(actions),
      ),
    );
    this.pi.on("session_shutdown", () => this.shutdown());
  }

  applyDirectToolConfigChanges(changes: Map<string, true | string[] | false>): void {
    if (!this.state) {
      return;
    }
    this.state.config = withDirectToolOverrides(this.state.config, changes);
    this.config = withDirectToolOverrides(this.config, changes);
  }

  syncToolSurface(): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferToolSync();
      return;
    }
    const config = this.state?.config ?? this.config;
    this.syncCatalog(config, loadMetadataCache(this.state?.metadataCacheEnabled ?? false));
  }

  private syncCatalog(config: McpConfig, cache: MetadataCache | null): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferToolSync();
      return;
    }
    this.toolLoader.sync(
      config,
      cache,
      this.envRaw === "__none__" ? null : this.envDirectToolOverride,
      (specs) => this.tools.syncGateways(config, cache, specs),
    );
    this.activateToolSearch();
  }

  private settlePinsOrDefer(): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferSettlePins();
      return;
    }
    this.toolLoader.settlePins();
  }

  /** Once per session start or tree navigation, so a later live deselection is not undone. */
  private activateToolSearch(): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferActivateToolSearch();
      return;
    }
    if (!this.toolSearchSettled && this.toolLoader.hasDeferred()) {
      this.toolSearchSettled = activateToolSearch(this.pi, this.sessionManager);
    }
  }

  private flushDeferredToolSurface(actions: DeferredToolSurfaceActions): void {
    if (actions.settlePins) {
      this.toolLoader.settlePins();
    }
    if (actions.toolSync) {
      this.syncToolSurface();
    } else if (actions.activateToolSearch) {
      this.activateToolSearch();
    }
    if (actions.promptSync) {
      this.syncPromptCommands();
    }
  }

  private syncPromptCommands(): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferPromptSync();
      return;
    }
    this.prompts.syncFromState(
      this.state?.config ?? this.config,
      this.state?.metadataCacheEnabled ?? this.runtimeCacheEnabled ?? false,
    );
  }

  private async shutdown(): Promise<void> {
    const state = this.state;
    const owner = this.owner;
    const oauthRuntime = this.oauthRuntime;
    this.session.end();
    this.sessionManager = undefined;
    this.oauthRuntime = null;
    this.runtimeCwd = undefined;
    this.runtimeCacheEnabled = undefined;
    this.directToolsFrozen = false;
    this.reconcile.reset();
    this.prompts.clear();
    this.workingSession.reset();
    const failures = await stopRuntimeSession({
      events: this.pi.events,
      state,
      owner,
      oauthRuntime,
      stateReason: "session_shutdown",
      ownerReason: "MCP extension session shutdown",
      flush: this.initModule?.flushMetadataCache,
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP session shutdown persistence/cleanup failed");
    }
  }

  private resolveConfig(ctx: ExtensionContext): McpConfig {
    const resolved = resolveHostConfig({
      pi: this.pi,
      ctx,
      options: this.options,
      sessionConfig: this.sessionConfig,
    });
    this.configPath = resolved.configPath;
    return resolved.config;
  }

  syncWorkingDirectory(ctx: ExtensionContext): Promise<void> {
    if (
      this.runtimeCwd === undefined ||
      (ctx.cwd === this.runtimeCwd && !this.reconcile.retryPending)
    ) {
      return Promise.resolve();
    }
    return this.reconcile.enqueue(async () => {
      if (
        this.runtimeCwd === undefined ||
        (ctx.cwd === this.runtimeCwd && !this.reconcile.retryPending)
      ) {
        return;
      }
      await this.reconcileLiveSession(ctx, ctx.cwd !== this.runtimeCwd);
    });
  }

  private handleMcpServersChange(ctx: ExtensionContext): Promise<void> {
    if (this.programmaticConfig || isBuiltinMcpActive(this.pi) || this.runtimeCwd === undefined) {
      return Promise.resolve();
    }
    return this.reconcile.enqueue(() => this.reconcileLiveSession(ctx, false));
  }

  private async reconcileLiveSession(ctx: ExtensionContext, cwdChanged: boolean): Promise<void> {
    const ready = await this.session.awaitReadyState();
    if (!ready) {
      return;
    }
    const { state, owner } = ready;
    const staged = stageHostReconcile({
      pi: this.pi,
      ctx,
      options: this.options,
      sessionConfig: this.sessionConfig,
      runtimeCwd: this.runtimeCwd,
      cwdChanged,
      directToolsFrozen: this.directToolsFrozen,
      previous: {
        config: this.config,
        configPath: this.configPath,
        cacheEnabled: this.runtimeCacheEnabled,
      },
    });
    await this.reconcile.execute(
      async (hooks) => {
        const { reconcileSessionState } = await import("./host-reconcile.ts");
        if (!this.session.isLiveOwner(owner) || this.state !== state) {
          return;
        }
        await reconcileSessionState({
          state,
          ctx,
          previousConfig: staged.previousConfig,
          nextConfig: staged.nextConfig,
          cwd: staged.cwd,
          cacheEnabled: staged.cacheEnabled,
          cwdChanged,
          envRaw: this.envRaw,
          envDirectToolOverride: this.envDirectToolOverride,
          owner,
          ...hooks,
        });
      },
      () => {
        this.runtimeCwd = staged.cwd;
        this.config = staged.nextConfig;
        this.configPath = staged.nextConfigPath;
        this.runtimeCacheEnabled = staged.cacheEnabled;
        this.directToolsFrozen = staged.directToolsFrozen;
        this.onReconciledSurface();
      },
      () => this.session.isLiveOwner(owner) && this.state === state,
    );
  }

  private onReconciledSurface(): void {
    this.syncPromptCommands();
    if (!this.directToolsFrozen) {
      this.syncToolSurface();
      if (this.config.settings?.freezeDirectTools === true) {
        this.directToolsFrozen = true;
      }
    }
  }

  private syncCachedPromptCommands(config: McpConfig, cacheEnabled: boolean): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferPromptSync();
      return;
    }
    this.prompts.syncCached(config, cacheEnabled);
  }

  private async startSession(ctx: ExtensionContext, wasFrozen = false): Promise<void> {
    const previous = {
      config: this.config,
      configPath: this.configPath,
      cacheEnabled: this.runtimeCacheEnabled,
    };
    this.runtimeCwd = ctx.cwd;
    this.directToolsFrozen = wasFrozen;
    const prev = { state: this.state, owner: this.owner, oauthRuntime: this.oauthRuntime };
    const owner = createMcpRuntimeOwner();
    const oauthRuntime = createOAuthRuntime(owner.signal);
    const generation = this.session.begin(owner);
    this.oauthRuntime = oauthRuntime;
    const stopFailures = await stopRuntimeSession({
      events: this.pi.events,
      ...prev,
      stateReason: "session_restart",
      ownerReason: "MCP extension session restarted",
      flush: this.initModule?.flushMetadataCache,
    });
    for (const error of stopFailures) {
      console.error(
        `MCP: failed to shut down previous session state: ${formatTerminalError(error)}`,
      );
    }
    if (!this.session.owns(owner, generation)) {
      return;
    }
    const runtimeConfig = this.resolveConfig(ctx);
    this.config = runtimeConfig;
    const cacheEnabled =
      ctx.isProjectTrusted() || !isPathInsideProject(getMetadataCachePath(), ctx.cwd);
    this.runtimeCacheEnabled = cacheEnabled;
    this.directToolsFrozen = canPreserveFrozenTools(wasFrozen, previous, {
      config: runtimeConfig,
      configPath: this.configPath,
      cacheEnabled,
    });
    this.syncCachedPromptCommands(runtimeConfig, cacheEnabled);
    const cache = loadMetadataCache(cacheEnabled);
    if (!this.directToolsFrozen) {
      this.syncCatalog(runtimeConfig, cache);
    }
    const init = await import("./init.ts");
    this.initModule = init;
    if (!this.session.owns(owner, generation)) {
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
    this.session.initialize(generation, promise);
    return promise
      .then(async (state) => {
        if (!this.session.owns(owner, generation)) {
          await stopStaleInitState(state, this.initModule?.flushMetadataCache);
          return;
        }
        this.session.ready(state);
        this.bindMetadataUpdates(owner);
        await this.completeInitialization(input);
        return;
      })
      .catch((error: unknown) => this.rejectInitialization(input, error));
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
    const state = this.session.currentState;
    if (!state) {
      return;
    }
    owner.throwIfInactive();
    this.syncPromptCommands();
    if (!this.directToolsFrozen) {
      this.syncToolSurface();
    }
    init.updateStatusBar(state);
    if (!this.directToolsFrozen && state.config.settings?.freezeDirectTools === true) {
      this.directToolsFrozen = true;
      logger.debug(
        'MCP: direct tools frozen after initial sync — reconnects won\'t rebuild the system prompt; use mcp({ action: "connect", server: "server" }) to rediscover',
      );
    }
  }

  private async rejectInitialization(input: Initialization, error: unknown): Promise<void> {
    const { owner, generation, oauthRuntime } = input;
    // A newer session owns the runtime; this rejection is its predecessor's.
    if (!this.session.owns(owner, generation)) {
      return;
    }
    console.error(`MCP initialization failed: ${formatTerminalError(error)}`);
    const state = this.session.currentState;
    if (state) {
      // The state was published; the failure belongs to its completion work, not the session.
      this.session.ready(state);
      return;
    }
    this.session.fail(formatTerminalError(error));
    await stopRejectedInitialization(owner, oauthRuntime);
  }

  ensureCommandState(
    owner: McpRuntimeOwner | null,
    ctx: ExtensionContext,
  ): Promise<McpExtensionState | null> {
    return this.session.ensureCommandState(owner, ctx);
  }

  getToolState(signal?: AbortSignal): ReturnType<McpAdapterHost["getToolState"]> {
    return this.session.getToolState(signal);
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
