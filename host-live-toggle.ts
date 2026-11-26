import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Init from "./init.ts";
import type { LiveServerToggleResult } from "./host-contract.ts";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpAdapterOptions, type McpConfig } from "./types.ts";
import { cloneMcpConfig } from "./config.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import type { HostSession } from "./host-session.ts";
import { stopRejectedInitialization, type HostReconcileCoordinator } from "./host-state-cleanup.ts";
import { stageHostReconcile } from "./host-registered-servers.ts";
import type { McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { logger } from "./logger.ts";
import { formatTerminalError } from "./utils.ts";

export interface LiveSessionReconcileContext {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly cwdChanged: boolean;
  readonly options: McpAdapterOptions;
  readonly sessionConfig: McpConfig | undefined;
  readonly session: HostSession;
  readonly reconcile: HostReconcileCoordinator;
  readonly envRaw: string | undefined;
  readonly envDirectToolOverride: string[] | undefined;
  readonly getSnapshot: () => {
    config: McpConfig;
    configPath: string | undefined;
    runtimeCwd: string | undefined;
    runtimeCacheEnabled: boolean | undefined;
    directToolsFrozen: boolean;
  };
  readonly commit: (next: {
    runtimeCwd: string;
    config: McpConfig;
    configPath: string | undefined;
    runtimeCacheEnabled: boolean;
    directToolsFrozen: boolean;
    state: McpExtensionState;
  }) => void;
}

export async function runLiveSessionReconcile(input: LiveSessionReconcileContext): Promise<void> {
  const ready = await input.session.awaitReadyState();
  if (!ready) {
    return;
  }
  const { state, owner } = ready;
  const current = input.getSnapshot();
  const staged = stageHostReconcile({
    pi: input.pi,
    ctx: input.ctx,
    options: input.options,
    sessionConfig: input.sessionConfig,
    runtimeCwd: current.runtimeCwd,
    cwdChanged: input.cwdChanged,
    directToolsFrozen: current.directToolsFrozen,
    previous: {
      config: current.config,
      configPath: current.configPath,
      cacheEnabled: current.runtimeCacheEnabled,
    },
  });
  await input.reconcile.execute(
    async (hooks) => {
      const { reconcileSessionState } = await import("./host-reconcile.ts");
      if (!input.session.isLiveOwner(owner) || input.session.currentState !== state) {
        return;
      }
      await reconcileSessionState({
        state,
        ctx: input.ctx,
        previousConfig: staged.previousConfig,
        nextConfig: staged.nextConfig,
        cwd: staged.cwd,
        cacheEnabled: staged.cacheEnabled,
        cwdChanged: input.cwdChanged,
        envRaw: input.envRaw,
        envDirectToolOverride: input.envDirectToolOverride,
        owner,
        ...hooks,
      });
    },
    () => {
      state.configPath = staged.nextConfigPath;
      state.configErrors = staged.nextConfig.configErrors
        ? [...staged.nextConfig.configErrors]
        : undefined;
      input.commit({
        runtimeCwd: staged.cwd,
        config: staged.nextConfig,
        configPath: staged.nextConfigPath,
        runtimeCacheEnabled: staged.cacheEnabled,
        directToolsFrozen: staged.directToolsFrozen,
        state,
      });
    },
    () => input.session.isLiveOwner(owner) && input.session.currentState === state,
  );
}

export interface LiveDisableToggleContext {
  readonly serverName: string;
  readonly disabled: boolean;
  readonly ctx: ExtensionContext;
  readonly session: HostSession;
  readonly reconcile: HostReconcileCoordinator;
  readonly getConfig: () => McpConfig;
  readonly getRuntimeCwd: () => string | undefined;
  readonly envRaw: string | undefined;
  readonly envDirectToolOverride: string[] | undefined;
  readonly initModule: typeof Init | undefined;
  readonly applySurface: (nextConfig: McpConfig, state: McpExtensionState) => void;
  readonly refreshSurface: () => void;
}

async function applyDisabledReconcile(
  input: LiveDisableToggleContext,
  ready: { state: McpExtensionState; owner: McpRuntimeOwner },
  nextConfig: McpConfig,
): Promise<boolean> {
  const { state, owner } = ready;
  const previousConfig = input.getConfig();
  const cwd = input.getRuntimeCwd() ?? input.ctx.cwd;
  let applied = false;
  await input.reconcile.execute(
    async (hooks) => {
      const { reconcileSessionState } = await import("./host-reconcile.ts");
      if (!input.session.isLiveOwner(owner) || input.session.currentState !== state) {
        return;
      }
      await reconcileSessionState({
        state,
        ctx: input.ctx,
        previousConfig,
        nextConfig,
        cwd,
        cacheEnabled: state.metadataCacheEnabled,
        cwdChanged: false,
        envRaw: input.envRaw,
        envDirectToolOverride: input.envDirectToolOverride,
        owner,
        ...hooks,
      });
    },
    () => {
      applied = true;
      state.config = nextConfig;
      input.applySurface(nextConfig, state);
    },
    () => input.session.isLiveOwner(owner) && input.session.currentState === state,
  );
  return applied;
}

export async function applyLiveServerDisabledToggle(
  input: LiveDisableToggleContext,
): Promise<LiveServerToggleResult> {
  const ready = await input.session.awaitReadyState();
  if (!ready || !input.session.isLiveOwner(ready.owner)) {
    return { applied: false };
  }
  const { state, owner } = ready;
  const baseConfig = input.getConfig();
  const current =
    baseConfig.mcpServers[input.serverName] ?? state.config.mcpServers[input.serverName];
  if (!current || isServerDisabled(current) === input.disabled) {
    return { applied: false };
  }
  const nextConfig = cloneMcpConfig(baseConfig);
  const nextEntry = { ...current, disabled: input.disabled };
  nextConfig.mcpServers[input.serverName] = nextEntry;
  const applied = await applyDisabledReconcile(input, ready, nextConfig);
  if (!applied) {
    return { applied: false };
  }
  if (input.disabled) {
    input.initModule?.updateStatusBar(state);
    return { applied: true, outcome: "disabled" };
  }
  const { connectEnabledServerLive } = await import("./mcp-connection-commands.ts");
  const result = await connectEnabledServerLive(state, input.serverName, nextEntry, owner.signal);
  input.refreshSurface();
  input.initModule?.updateStatusBar(state);
  return result;
}

export function bindHostMetadataUpdates(input: {
  session: HostSession;
  owner: McpRuntimeOwner;
  syncPrompts: () => void;
  syncTools: () => void;
  isFrozen: () => boolean;
}): void {
  const state = input.session.currentState;
  if (!state) {
    return;
  }
  state.onToolMetadataUpdated = (server, reason) => {
    if (input.session.currentState !== state || !input.owner.isActive()) {
      return;
    }
    input.syncPrompts();
    if (input.isFrozen()) {
      logger.debug(`MCP: metadata update for ${server} (${reason}) skipped — directTools frozen`);
      return;
    }
    input.syncTools();
  };
}

export async function completeHostInitialization(input: {
  init: typeof Init;
  owner: McpRuntimeOwner;
  session: HostSession;
  isFrozen: () => boolean;
  markFrozen: () => void;
  syncPrompts: () => void;
  syncTools: () => void;
}): Promise<void> {
  const state = input.session.currentState;
  if (!state) {
    return;
  }
  input.owner.throwIfInactive();
  input.syncPrompts();
  if (!input.isFrozen()) {
    input.syncTools();
  }
  input.init.updateStatusBar(state);
  if (!input.isFrozen() && state.config.settings?.freezeDirectTools === true) {
    input.markFrozen();
    logger.debug(
      'MCP: direct tools frozen after initial sync — reconnects won\'t rebuild the system prompt; use mcp({ action: "connect", server: "server" }) to rediscover',
    );
  }
}

export async function rejectHostInitialization(input: {
  session: HostSession;
  owner: McpRuntimeOwner;
  generation: number;
  oauthRuntime: McpOAuthRuntime;
  error: unknown;
}): Promise<void> {
  const { session, owner, generation, oauthRuntime, error } = input;
  if (!session.owns(owner, generation)) {
    return;
  }
  console.error(`MCP initialization failed: ${formatTerminalError(error)}`);
  const state = session.currentState;
  if (state) {
    session.ready(state);
    return;
  }
  session.fail(formatTerminalError(error));
  await stopRejectedInitialization(owner, oauthRuntime);
}
