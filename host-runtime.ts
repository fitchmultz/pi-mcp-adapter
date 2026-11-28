import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type * as Init from "./init.ts";
import type { McpExtensionState } from "./state.ts";
import {
  isBuiltinMcpActive,
  type LiveServerToggleResult,
  type McpAdapterHost,
} from "./host-contract.ts";
import type { McpAdapterOptions, McpConfig } from "./types.ts";
import { cloneMcpConfig, isPathInsideProject } from "./config.ts";
import { getMetadataCachePath, loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import { createMcpRuntimeOwner, type McpRuntimeOwner } from "./runtime-owner.ts";
import { createOAuthRuntime, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { logger } from "./logger.ts";
import { McpHostCommands } from "./host-commands.ts";
import {
  HostPromptRegistry,
  registerFallbackMcpToolRenderer,
  resolveHostConfig,
  withDirectToolOverrides,
} from "./host-registered-servers.ts";
import {
  applyLiveServerDisabledToggle,
  launchAndMaybeAwaitHostInitialization,
  runLiveSessionReconcile,
} from "./host-live-toggle.ts";
import { canPreserveFrozenTools, HostSession, parseEnvDirectToolOverride } from "./host-session.ts";
import {
  finalizeHostShutdown,
  HostReconcileCoordinator,
  stopPreviousSessionForStart,
} from "./host-state-cleanup.ts";
import { activateToolSearch, createToolLoader, removedOnBranch } from "./tool-loader.ts";
import { McpHostTools } from "./host-tools.ts";
import { McpServersPromptState } from "./mcp-servers-prompt.ts";
import type { ReloadedServerSkills } from "./mcp-skills.ts";
import {
  completeSessionShutdownReloadSkills,
  takeSessionStartReloadSkills,
} from "./mcp-skills-reload.ts";
import { HostSkillsTracker } from "./mcp-skills-store.ts";
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
  private readonly skillsTracker = new HostSkillsTracker();
  private startSessionPromise: Promise<void> | null = null;
  private readonly envRaw = process.env.MCP_DIRECT_TOOLS;
  private readonly envDirectToolOverride = parseEnvDirectToolOverride(this.envRaw);
  private readonly toolLoader: ReturnType<typeof createToolLoader>;
  private readonly tools: McpHostTools;
  private sessionManager: ExtensionContext["sessionManager"] | undefined;
  /** Whether tool_search activation was decided since the last session start or tree navigation. */
  private toolSearchSettled = false;
  private hasReloadSkills = false;
  private readonly serversPrompt = new McpServersPromptState();

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
    this.pi.on("session_start", (event, ctx) => {
      logger.setTuiActive(this, ctx.hasUI);
      this.sessionManager = ctx.sessionManager;
      this.toolSearchSettled = false;
      this.serversPrompt.clearSurfaced();
      this.skillsTracker.reset();
      this.settlePinsOrDefer();
      const reloadedSkills = takeSessionStartReloadSkills(event, ctx, this.state);
      this.hasReloadSkills = reloadedSkills !== undefined && reloadedSkills.size > 0;
      const started = this.startSession(ctx, false, reloadedSkills);
      this.startSessionPromise = started;
      return started;
    });
    this.skillsTracker.register(this.pi, () => ({
      initPromise: this.initPromise,
      startPromise: this.startSessionPromise,
      state: this.state,
      config: this.config,
      hasReloadSkills: this.hasReloadSkills,
    }));
    // Pi restores the target branch's recorded loadout before session_tree.
    this.pi.on("session_tree", (_event, ctx) => {
      this.sessionManager = ctx.sessionManager;
      this.toolSearchSettled = false;
      this.serversPrompt.clearSurfaced();
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
      logger.setTuiActive(this, ctx.hasUI);
      if (this.runtimeCwd === undefined) {
        await this.startSession(ctx, this.directToolsFrozen);
      } else if (ctx.cwd !== this.runtimeCwd || this.reconcile.retryPending) {
        await this.syncWorkingDirectory(ctx);
      }
      this.serversPrompt.applyBeforeAgentStart(event, {
        state: this.state,
        fallbackConfig: this.config,
        cacheEnabled: this.runtimeCacheEnabled === true,
        frozen: this.directToolsFrozen,
        builtinActive: isBuiltinMcpActive(this.pi),
      });
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
    this.pi.on("tool_result", (event) =>
      this.serversPrompt.surfaceToolResult(event, {
        serverForTool: (name) => this.toolLoader.serverForTool(name),
        state: this.state,
      }),
    );
    this.pi.on("session_shutdown", (event, ctx) => this.shutdown(event, ctx));
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

  private syncDeferredCatalog(): void {
    const config = this.state?.config ?? this.config;
    this.toolLoader.syncDeferred(
      config,
      loadMetadataCache(this.state?.metadataCacheEnabled ?? false),
      this.envRaw === "__none__" ? null : this.envDirectToolOverride,
    );
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

  private async shutdown(event?: SessionShutdownEvent, ctx?: ExtensionContext): Promise<void> {
    const state = this.state;
    const owner = this.owner;
    const oauthRuntime = this.oauthRuntime;
    try {
      completeSessionShutdownReloadSkills(event, ctx, this.sessionManager, state);
      this.hasReloadSkills = false;
      this.session.end();
      this.sessionManager = undefined;
      this.oauthRuntime = null;
      this.runtimeCwd = undefined;
      this.runtimeCacheEnabled = undefined;
      this.directToolsFrozen = false;
      this.reconcile.reset();
      this.serversPrompt.resetAll();
      this.skillsTracker.reset();
      this.startSessionPromise = null;
      this.prompts.clear();
      this.workingSession.reset();
      await finalizeHostShutdown({
        events: this.pi.events,
        state,
        owner,
        oauthRuntime,
        flush: this.initModule?.flushMetadataCache,
      });
    } finally {
      logger.setTuiActive(this, false);
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
    await runLiveSessionReconcile({
      pi: this.pi,
      ctx,
      cwdChanged,
      options: this.options,
      sessionConfig: this.sessionConfig,
      session: this.session,
      reconcile: this.reconcile,
      envRaw: this.envRaw,
      envDirectToolOverride: this.envDirectToolOverride,
      getSnapshot: () => ({
        config: this.config,
        configPath: this.configPath,
        runtimeCwd: this.runtimeCwd,
        runtimeCacheEnabled: this.runtimeCacheEnabled,
        directToolsFrozen: this.directToolsFrozen,
      }),
      commit: (next) => {
        this.runtimeCwd = next.runtimeCwd;
        this.config = next.config;
        this.configPath = next.configPath;
        this.runtimeCacheEnabled = next.runtimeCacheEnabled;
        this.directToolsFrozen = next.directToolsFrozen;
        this.onReconciledSurface();
      },
    });
  }

  async setServerDisabled(
    serverName: string,
    disabled: boolean,
    ctx: ExtensionContext,
  ): Promise<LiveServerToggleResult> {
    if (this.programmaticConfig) {
      return { applied: false };
    }
    let result: LiveServerToggleResult = { applied: false };
    await this.reconcile.enqueue(async () => {
      result = await applyLiveServerDisabledToggle({
        serverName,
        disabled,
        ctx,
        session: this.session,
        reconcile: this.reconcile,
        getConfig: () => this.config,
        getRuntimeCwd: () => this.runtimeCwd,
        envRaw: this.envRaw,
        envDirectToolOverride: this.envDirectToolOverride,
        initModule: this.initModule,
        applySurface: (nextConfig, state) => {
          this.config = nextConfig;
          this.serversPrompt.resetFrozen(false);
          this.refreshToggleSurface(state);
        },
        refreshSurface: () => this.refreshToggleSurface(this.state),
      });
    });
    return result;
  }

  private refreshToggleSurface(state: McpExtensionState | null): void {
    this.syncPromptCommands();
    this.skillsTracker.handleStateUpdate(state);
    this.syncToolSurface();
  }

  private onReconciledSurface(): void {
    this.syncPromptCommands();
    this.skillsTracker.handleStateUpdate(this.state);
    // Reconcile resets directToolsFrozen before re-freezing; clear any captured section before that re-freeze.
    this.serversPrompt.resetFrozen(this.directToolsFrozen);
    if (!this.directToolsFrozen) {
      this.syncToolSurface();
      if (this.config.settings?.freezeDirectTools === true) {
        this.directToolsFrozen = true;
      }
    } else {
      this.syncDeferredCatalog();
    }
  }

  private syncCachedPromptCommands(config: McpConfig, cacheEnabled: boolean): void {
    if (this.workingSession.isSaving()) {
      this.workingSession.deferPromptSync();
      return;
    }
    this.prompts.syncCached(config, cacheEnabled);
  }

  private async startSession(
    ctx: ExtensionContext,
    wasFrozen = false,
    reloadedSkills?: ReloadedServerSkills,
  ): Promise<void> {
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
    await stopPreviousSessionForStart({
      events: this.pi.events,
      ...prev,
      flush: this.initModule?.flushMetadataCache,
    });
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
    this.serversPrompt.resetFrozen(this.directToolsFrozen);
    this.syncCachedPromptCommands(runtimeConfig, cacheEnabled);
    const loaded = loadMetadataCache(cacheEnabled);
    if (!this.directToolsFrozen) {
      this.syncCatalog(runtimeConfig, loaded);
    }
    const init = await import("./init.ts");
    this.initModule = init;
    if (!this.session.owns(owner, generation)) {
      return;
    }
    await launchAndMaybeAwaitHostInitialization({
      init,
      ctx,
      owner,
      oauthRuntime,
      runtimeConfig,
      generation,
      cache: loaded,
      reloadedSkills,
      envRaw: this.envRaw,
      envDirectToolOverride: this.envDirectToolOverride,
      pi: this.pi,
      session: this.session,
      configPath: this.configPath,
      programmaticConfig: this.programmaticConfig,
      options: this.options,
      isFrozen: () => this.directToolsFrozen,
      markFrozen: () => {
        this.directToolsFrozen = true;
      },
      syncPrompts: () => this.syncPromptCommands(),
      syncSkills: (state) => this.skillsTracker.handleStateUpdate(state),
      syncTools: () => this.syncToolSurface(),
      syncDeferred: () => this.syncDeferredCatalog(),
    });
  }

  ensureCommandState(
    owner: McpRuntimeOwner | null,
    ctx: ExtensionContext,
  ): Promise<McpExtensionState | null> {
    return this.session.ensureCommandState(owner, ctx);
  }

  consumePendingSkillReload(): boolean {
    return this.skillsTracker.consumePendingReload();
  }

  getToolState(signal?: AbortSignal): ReturnType<McpAdapterHost["getToolState"]> {
    return this.session.getToolState(signal);
  }
}
