import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { McpAdapterOptions, McpConfig } from "./types.ts";
import { nativePiConfigOptions } from "./host-contract.ts";
import { cloneMcpConfig, isPathInsideProject, loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import { getMetadataCachePath } from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { openUrl } from "./utils.ts";
import { getAuthStorageOptions } from "./mcp-auth.ts";
import {
  createOAuthRuntime,
  hasPendingAuth,
  shutdownOAuth,
  type McpOAuthRuntime,
} from "./mcp-oauth-runtime.ts";
import { combineAbortSignals, createOwnedUi, type McpRuntimeOwner } from "./runtime-owner.ts";
import {
  updateServerMetadata,
  updateMetadataCache,
  notifyToolMetadataUpdated,
} from "./init-metadata.ts";
import { McpStateCleanup } from "./host-state-cleanup.ts";
import { updateStatusBar } from "./init-status.ts";

export type McpInitializationOptions = McpAdapterOptions & {
  /**
   * OAuth runtime to attach instead of creating one owned by the extension
   * state. An injected runtime's lifetime stays with its caller: the state's
   * cleanup shuts down only runtimes it created itself, so the caller must
   * stop an injected runtime with shutdownOAuth().
   */
  oauthRuntime?: McpOAuthRuntime;
  statusEvents?: McpExtensionState["statusEvents"];
  resolvedConfig?: McpConfig;
};

function resolveConfig(
  pi: ExtensionAPI,
  cwd: string,
  options: McpInitializationOptions,
): McpConfig {
  if (options.config !== undefined) {
    return cloneMcpConfig(options.config);
  }
  if (options.resolvedConfig !== undefined) {
    return cloneMcpConfig(options.resolvedConfig);
  }
  const flag = pi.getFlag("mcp-config");
  return loadMcpConfig(
    options.configPath ?? (typeof flag === "string" ? flag : undefined),
    cwd,
    nativePiConfigOptions(pi),
  );
}

export function configureRequests(
  manager: McpServerManager,
  ctx: ExtensionContext,
  state: McpExtensionState,
  options?: { readonly clearWhenDisabled?: boolean },
): void {
  const clearWhenDisabled = options?.clearWhenDisabled === true;
  const { owner, config, ui } = state;
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (ctx.hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ...(ui !== undefined ? { ui } : {}),
      modelRegistry: ctx.modelRegistry,
      getCurrentModel: () => (owner.isActive() ? ctx.model : undefined),
      getSignal: () =>
        owner.isActive() ? combineAbortSignals(owner.signal, ctx.signal) : owner.signal,
    });
  } else if (clearWhenDisabled) {
    manager.setSamplingConfig(undefined);
  }
  configureElicitation(manager, ctx, state, clearWhenDisabled);
}

function configureElicitation(
  manager: McpServerManager,
  ctx: ExtensionContext,
  { config, owner, ui }: McpExtensionState,
  clearWhenDisabled: boolean,
): void {
  if (config.settings?.elicitation !== false && ctx.hasUI && ui) {
    manager.setElicitationConfig({ ui, allowUrl: ctx.mode === "tui", signal: owner.signal });
  } else if (clearWhenDisabled) {
    manager.setElicitationConfig(undefined);
  }
}

function bindRuntime(state: McpExtensionState, ownsOAuthRuntime: boolean): void {
  const { owner, manager, lifecycle, oauthRuntime } = state;
  if (ownsOAuthRuntime) {
    owner.addCleanup(() => shutdownOAuth(oauthRuntime));
  }
  manager.setMetadataListChangedListener((serverName, reason) => {
    if (!owner.isActive()) {
      return;
    }
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName, { preserveEmptyResources: false });
    notifyToolMetadataUpdated(state, serverName, reason);
    updateStatusBar(state);
  });
  owner.addCleanup(() => lifecycle.gracefulShutdown());
  const cleanup = new McpStateCleanup(state);
  owner.addCleanup(() => cleanup.closeUiServer("runtime_owner_stopped"));
}

function createConfiguredManager(input: {
  cwd: string;
  owner: McpRuntimeOwner;
  oauthRuntime: McpOAuthRuntime;
  authStorageOptions: ReturnType<typeof getAuthStorageOptions>;
  config: McpConfig;
}): McpServerManager {
  const { cwd, owner, oauthRuntime, authStorageOptions, config } = input;
  const manager = new McpServerManager(cwd);
  manager.setRuntimeSignal(owner.signal);
  manager.setOAuthRuntime(oauthRuntime);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  manager.setTraceConfig(config.settings?.trace);
  manager.setAuthStorageOptions(authStorageOptions);
  return manager;
}

function createSendMessage(
  pi: ExtensionAPI,
  owner: McpRuntimeOwner,
): NonNullable<McpExtensionState["sendMessage"]> {
  return (message, deliveryOptions) => {
    if (!owner.isActive()) {
      return;
    }
    const { display, ...body } = message;
    pi.sendMessage(
      { ...body, display: display !== undefined && display.length > 0 },
      deliveryOptions,
    );
  };
}

function createOpenBrowser(
  pi: ExtensionAPI,
  owner: McpRuntimeOwner,
): McpExtensionState["openBrowser"] {
  return async (url) => {
    owner.throwIfInactive();
    await openUrl(pi, url, process.env.BROWSER, owner.signal);
    owner.throwIfInactive();
  };
}

function copyConfigErrors(config: McpConfig): McpExtensionState["configErrors"] {
  if (!config.configErrors || config.configErrors.length === 0) {
    return undefined;
  }
  return [...config.configErrors];
}

export function createInitialState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: McpRuntimeOwner,
  options: McpInitializationOptions,
): McpExtensionState {
  const cwd = ctx.cwd;
  const ui = ctx.hasUI ? createOwnedUi(ctx.ui, owner) : undefined;
  const config = resolveConfig(pi, cwd, options);
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);
  const oauthRuntime = options.oauthRuntime ?? createOAuthRuntime(owner.signal);
  const manager = createConfiguredManager({ cwd, owner, oauthRuntime, authStorageOptions, config });
  const lifecycle = new McpLifecycleManager(manager, (serverName) =>
    hasPendingAuth(serverName, oauthRuntime),
  );
  const configErrors = copyConfigErrors(config);
  const state: McpExtensionState = {
    owner,
    manager,
    lifecycle,
    config,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(configErrors !== undefined ? { configErrors } : {}),
    recentStderr: new Map(),
    toolMetadata: new Map(),
    resourceCounts: new Map(),
    resourceTemplates: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    failureMessages: new Map(),
    approvedToolCalls: new Map(),
    programmaticConfig: options.config !== undefined,
    ...(options.outputDirectory !== undefined ? { outputDirectory: options.outputDirectory } : {}),
    oauthRuntime,
    authStorageOptions,
    metadataCacheEnabled: metadataCacheAllowed(ctx),
    uiResourceHandler: new UiResourceHandler(manager, config),
    consentManager: new ConsentManager(),
    uiServer: null,
    completedUiSessions: [],
    activeScripts: 0,
    openBrowser: createOpenBrowser(pi, owner),
    ...(ui !== undefined ? { ui } : {}),
    sendMessage: createSendMessage(pi, owner),
    ...(options.statusEvents !== undefined ? { statusEvents: options.statusEvents } : {}),
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
  };
  configureRequests(manager, ctx, state);
  bindRuntime(state, options.oauthRuntime === undefined);
  return state;
}

function metadataCacheAllowed(ctx: ExtensionContext): boolean {
  return ctx.isProjectTrusted() || !isPathInsideProject(getMetadataCachePath(), ctx.cwd);
}
