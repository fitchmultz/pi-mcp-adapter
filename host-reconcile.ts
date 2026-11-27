import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAuthStorageOptions } from "./mcp-auth.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import {
  applyConnectionMetadata,
  markKeepAliveAfterConnect,
  notifyToolMetadataUpdated,
  recordFailure,
  updateMetadataCache,
  updateServerMetadata,
  updateStatusBar,
} from "./init.ts";
import { configureRequests } from "./init-state.ts";
import { registerLifecycle, restoreCachedMetadata } from "./init-startup.ts";
import { logger } from "./logger.ts";
import {
  cleanupServerSkills,
  refreshLiveSkillsForEnabledServers,
  syncAllStateSkills,
} from "./mcp-skills-store.ts";
import { publishMcpStatusSnapshot } from "./mcp-status.ts";
import { loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import { isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import {
  DEFAULT_TOOL_PREFIX,
  isServerDisabled,
  type McpConfig,
  type ServerEntry,
} from "./types.ts";
import {
  MAX_CONCURRENT_SERVER_CONNECTS,
  parallelLimit,
  resolveConfigPath,
  sanitizeTerminalText,
} from "./utils.ts";

export function isCwdSensitiveStdioServer(definition: ServerEntry): boolean {
  if (typeof definition.command !== "string" || definition.command === "") {
    return false;
  }
  if (definition.cwd === undefined || definition.cwd === "") {
    return true;
  }
  const resolved = resolveConfigPath(definition.cwd);
  return resolved === undefined || !isAbsolute(resolved);
}

function connectionFingerprint(definition: ServerEntry): Record<string, unknown> {
  return {
    command: definition.command,
    args: definition.args,
    socket: definition.socket,
    env: definition.env,
    cwd: definition.cwd,
    protocolVersion: definition.protocolVersion,
    retryOnTransportFailure: definition.retryOnTransportFailure,
    url: definition.url,
    headers: definition.headers,
    auth: definition.auth,
    bearerToken: definition.bearerToken,
    bearerTokenEnv: definition.bearerTokenEnv,
    oauth: definition.oauth,
    debug: definition.debug,
    trace: definition.trace,
    requestTimeoutMs: definition.requestTimeoutMs,
  };
}

function metadataFingerprint(definition: ServerEntry): Record<string, unknown> {
  return {
    exposeResources: definition.exposeResources,
    exposeSkills: definition.exposeSkills,
    includeTools: definition.includeTools,
    excludeTools: definition.excludeTools,
    toolExposure:
      definition.toolExposure !== undefined ? Object.entries(definition.toolExposure) : undefined,
    toolPrefix: definition.toolPrefix,
  };
}

function lifecycleFingerprint(definition: ServerEntry): Record<string, unknown> {
  return {
    lifecycle: definition.lifecycle ?? "lazy",
    idleTimeout: definition.idleTimeout,
  };
}

function requestPolicyFingerprint(config: McpConfig): Record<string, boolean> {
  return {
    sampling: config.settings?.sampling !== false,
    samplingAutoApprove: config.settings?.samplingAutoApprove === true,
    elicitation: config.settings?.elicitation !== false,
  };
}

export interface ReconcileSessionInput {
  readonly state: McpExtensionState;
  readonly ctx: ExtensionContext;
  readonly previousConfig: McpConfig;
  readonly nextConfig: McpConfig;
  readonly cwdChanged: boolean;
  readonly cwd: string;
  readonly cacheEnabled: boolean;
  readonly envRaw: string | undefined;
  readonly envDirectToolOverride: string[] | undefined;
  readonly owner: McpRuntimeOwner;
  readonly interruptedServers?: ReadonlyMap<string, boolean>;
  readonly onReconcileInterrupted?: (name: string, wasConnected: boolean) => void;
  readonly onSurfaceChanged: () => void;
}

type ServerTransition =
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "add"; readonly name: string; readonly next: ServerEntry }
  | {
      readonly kind: "reconnect";
      readonly name: string;
      readonly next: ServerEntry;
      readonly wasConnected: boolean;
    }
  | {
      readonly kind: "update";
      readonly name: string;
      readonly prev: ServerEntry;
      readonly next: ServerEntry;
    };

class SessionReconciler {
  private readonly state: McpExtensionState;
  private readonly input: ReconcileSessionInput;
  private readonly cache: MetadataCache | null;
  private readonly missingDirectTools: Set<string>;
  private readonly serversToConnect: Array<[string, ServerEntry]> = [];

  constructor(input: ReconcileSessionInput) {
    this.state = input.state;
    this.input = input;
    this.cache = loadMetadataCache(input.cacheEnabled);
    this.missingDirectTools = new Set(
      input.envRaw === "__none__"
        ? []
        : getMissingConfiguredDirectToolServers(
            input.nextConfig,
            this.cache,
            input.envDirectToolOverride,
          ),
    );
  }

  async run(): Promise<void> {
    this.state.projectTrusted = this.input.ctx.isProjectTrusted();
    this.state.cwd = this.input.cwd;
    this.state.manager.setExposeSkills(this.input.nextConfig.settings?.exposeSkills !== false);
    const { previousConfig, nextConfig } = this.input;
    const prefixChanged =
      (previousConfig.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX) !==
      (nextConfig.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX);
    const requestPolicyChanged = !isDeepStrictEqual(
      requestPolicyFingerprint(previousConfig),
      requestPolicyFingerprint(nextConfig),
    );
    const transitions = this.planTransitions(previousConfig, nextConfig, requestPolicyChanged);

    // Unregister and tear down removed/reconnecting servers before awaiting close or mutating config,
    // so health ticks during a slow close cannot resurrect stale keep-alive definitions and a close()
    // failure never leaves half-applied cwd/config or permanently dropped connections across retries.
    await this.closeRemovedAndReconnecting(transitions, previousConfig);

    this.applyGlobalSettings();
    for (const transition of transitions) {
      this.applyTransition(transition, prefixChanged);
    }

    await this.connectPendingServers();
    this.input.owner.throwIfInactive();
    this.refreshFooter();
    publishMcpStatusSnapshot(this.state);
    this.input.onSurfaceChanged();
  }

  private async closeRemovedAndReconnecting(
    transitions: ServerTransition[],
    previousConfig: McpConfig,
  ): Promise<void> {
    const tornDown: Array<{ name: string; wasConnected: boolean; definition?: ServerEntry }> = [];
    for (const transition of transitions) {
      if (transition.kind !== "remove" && transition.kind !== "reconnect") {
        continue;
      }
      const wasConnected =
        this.state.manager.getConnection(transition.name)?.status === "connected" ||
        this.input.interruptedServers?.get(transition.name) === true;
      const prev = previousConfig.mcpServers[transition.name];
      tornDown.push({
        name: transition.name,
        wasConnected,
        ...(prev !== undefined && !isServerDisabled(prev) ? { definition: prev } : {}),
      });
      this.state.lifecycle.unregisterServer(transition.name);
      try {
        await this.state.manager.close(transition.name);
        this.input.owner.throwIfInactive();
      } catch (error) {
        this.rollbackInterruptedCloses(tornDown);
        throw error;
      }
    }
  }

  private rollbackInterruptedCloses(
    tornDown: ReadonlyArray<{ name: string; wasConnected: boolean; definition?: ServerEntry }>,
  ): void {
    if (!this.input.owner.isActive()) {
      return;
    }
    for (const entry of tornDown) {
      if (entry.definition) {
        registerLifecycle(this.state, entry.name, entry.definition);
      }
      this.input.onReconcileInterrupted?.(entry.name, entry.wasConnected);
    }
  }

  private planTransitions(
    previousConfig: McpConfig,
    nextConfig: McpConfig,
    requestPolicyChanged: boolean,
  ): ServerTransition[] {
    const transitions: ServerTransition[] = [];
    const allNames = new Set([
      ...Object.keys(previousConfig.mcpServers),
      ...Object.keys(nextConfig.mcpServers),
    ]);
    for (const name of allNames) {
      const prev = previousConfig.mcpServers[name];
      const next = nextConfig.mcpServers[name];
      const prevActive = prev !== undefined && !isServerDisabled(prev);
      const nextActive = next !== undefined && !isServerDisabled(next);
      if (!nextActive) {
        transitions.push({ kind: "remove", name });
      } else if (!prevActive) {
        transitions.push({ kind: "add", name, next });
      } else if (this.needsReconnect(prev, next, requestPolicyChanged)) {
        const wasConnected =
          this.state.manager.getConnection(name)?.status === "connected" ||
          this.input.interruptedServers?.get(name) === true;
        transitions.push({ kind: "reconnect", name, next, wasConnected });
      } else {
        transitions.push({ kind: "update", name, prev, next });
      }
    }
    return transitions;
  }

  private needsReconnect(
    prev: ServerEntry,
    next: ServerEntry,
    requestPolicyChanged: boolean,
  ): boolean {
    return (
      requestPolicyChanged ||
      !isDeepStrictEqual(connectionFingerprint(prev), connectionFingerprint(next)) ||
      (this.input.cwdChanged && isCwdSensitiveStdioServer(next))
    );
  }

  private applyTransition(transition: ServerTransition, prefixChanged: boolean): void {
    switch (transition.kind) {
      case "remove":
        this.cleanupRemovedServer(transition.name);
        break;
      case "add":
        this.addServer(transition.name, transition.next);
        break;
      case "reconnect":
        this.cleanupRemovedServer(transition.name);
        registerLifecycle(this.state, transition.name, transition.next);
        this.restoreCache(transition.name, transition.next);
        if (transition.wasConnected || this.shouldAutoConnect(transition.name, transition.next)) {
          this.serversToConnect.push([transition.name, transition.next]);
        }
        break;
      case "update":
        this.updateInPlaceServer(transition.name, transition.prev, transition.next, prefixChanged);
        break;
    }
  }

  private applyGlobalSettings(): void {
    const { nextConfig, ctx, cwd, cacheEnabled } = this.input;
    const authStorageOptions = getAuthStorageOptions(nextConfig.settings?.oauthDir, cwd);
    this.state.config = nextConfig;
    this.state.metadataCacheEnabled = cacheEnabled;
    this.state.authStorageOptions = authStorageOptions;
    this.state.manager.setDefaultCwd(cwd);
    this.state.manager.setDefaultRequestTimeoutMs(nextConfig.settings?.requestTimeoutMs);
    this.state.manager.setTraceConfig(nextConfig.settings?.trace);
    this.state.manager.setAuthStorageOptions(authStorageOptions);
    this.state.lifecycle.setGlobalIdleTimeout(nextConfig.settings?.idleTimeout ?? 10);
    this.state.uiResourceHandler.setConfig(nextConfig);
    configureRequests(this.state.manager, ctx, this.state, { clearWhenDisabled: true });
  }

  private cleanupRemovedServer(name: string): void {
    this.state.lifecycle.unregisterServer(name);
    this.clearServerRecords(name);
    this.closeOwnedUiServer(name);
  }

  private addServer(name: string, definition: ServerEntry): void {
    registerLifecycle(this.state, name, definition);
    this.restoreCache(name, definition);
    if (this.shouldAutoConnect(name, definition)) {
      this.serversToConnect.push([name, definition]);
    }
  }

  private updateInPlaceServer(
    name: string,
    prev: ServerEntry,
    next: ServerEntry,
    prefixChanged: boolean,
  ): void {
    const connection = this.state.manager.getConnection(name);
    const connected = connection?.status === "connected";
    if (!isDeepStrictEqual(lifecycleFingerprint(prev), lifecycleFingerprint(next))) {
      this.state.lifecycle.unregisterServer(name);
      registerLifecycle(this.state, name, next);
      if (connected) {
        markKeepAliveAfterConnect(this.state, name);
      }
    }
    if (prefixChanged || !isDeepStrictEqual(metadataFingerprint(prev), metadataFingerprint(next))) {
      if (connection) {
        connection.definition = next;
      }
      if (connected) {
        updateServerMetadata(this.state, name);
      } else {
        this.clearCachedMetadata(name);
        this.restoreCache(name, next);
      }
    }
    if (this.shouldConnectInPlace(name, prev, next)) {
      this.serversToConnect.push([name, next]);
    }
  }

  private shouldConnectInPlace(name: string, prev: ServerEntry, next: ServerEntry): boolean {
    if (this.state.manager.getConnection(name)?.status === "connected") {
      return false;
    }
    const interrupted = this.input.interruptedServers?.get(name);
    if (interrupted !== undefined) {
      return interrupted || this.shouldAutoConnect(name, next);
    }
    return this.shouldAutoConnect(name, next) && !this.hasAttemptedStartup(prev);
  }

  private hasAttemptedStartup(definition: ServerEntry): boolean {
    const mode = definition.lifecycle ?? "lazy";
    return mode === "keep-alive" || mode === "eager";
  }

  private hasCachedExposeSkills(name: string, definition: ServerEntry): boolean {
    if (this.state.config.settings?.exposeSkills === false || definition.exposeSkills === false) {
      return false;
    }
    return (this.cache?.servers[name]?.skills?.length ?? 0) > 0;
  }

  private shouldAutoConnect(name: string, definition: ServerEntry): boolean {
    const mode = definition.lifecycle ?? "lazy";
    return (
      mode === "keep-alive" ||
      mode === "eager" ||
      this.missingDirectTools.has(name) ||
      this.hasCachedExposeSkills(name, definition)
    );
  }

  private restoreCache(name: string, definition: ServerEntry): void {
    const prefix = this.state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX;
    restoreCachedMetadata(this.state, {
      name,
      definition,
      prefix,
      cachedEntry: this.cache?.servers[name],
    });
  }

  private clearCachedMetadata(name: string): void {
    this.state.toolMetadata.delete(name);
    this.state.resourceCounts.delete(name);
    this.state.promptMetadata.delete(name);
    this.state.promptMetadataLive.delete(name);
    this.state.serverInstructions.delete(name);
    cleanupServerSkills(this.state, name);
  }

  private clearServerRecords(name: string): void {
    this.clearCachedMetadata(name);
    this.state.failureTracker.delete(name);
    this.state.failureMessages.delete(name);
    this.state.consentManager.clear(name);
    if (this.state.pendingUiModelContext?.serverName === name) {
      this.state.pendingUiModelContext = undefined;
    }
    const approvalPrefix = `${name}\u0000`;
    for (const key of Array.from(this.state.approvedToolCalls.keys())) {
      if (key.startsWith(approvalPrefix)) {
        this.state.approvedToolCalls.delete(key);
      }
    }
  }

  private closeOwnedUiServer(name: string): void {
    const uiServer = this.state.uiServer;
    if (!uiServer || uiServer.serverName !== name) {
      return;
    }
    try {
      uiServer.close("server_reconfigured");
    } catch (error) {
      logger.debug(
        `MCP: failed to close UI server for ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (this.state.uiServer === uiServer) {
        this.state.uiServer = null;
      }
      if (this.state.pendingUiModelContext?.serverName === name) {
        this.state.pendingUiModelContext = undefined;
      }
    }
  }

  private async connectPendingServers(): Promise<void> {
    if (this.serversToConnect.length === 0) {
      return;
    }
    const signal = this.input.owner.signal;
    await parallelLimit(
      this.serversToConnect,
      MAX_CONCURRENT_SERVER_CONNECTS,
      async ([name, definition]) => {
        try {
          const connection = await this.state.manager.connect(name, definition, signal);
          this.input.owner.throwIfInactive();
          if (connection.status === "needs-auth") {
            recordFailure(
              this.state,
              name,
              `OAuth authentication required. Run /mcp-auth ${name}.`,
            );
            return;
          }
          applyConnectionMetadata(this.state, {
            serverName: name,
            connection,
            definition,
            reason: "config-reconcile",
          });
        } catch (error) {
          if (isAbortError(error, signal)) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          recordFailure(this.state, name, message);
          logger.debug(
            `MCP: reconcile connect failed for ${name}: ${sanitizeTerminalText(message)}`,
          );
        }
      },
    );
  }

  private refreshFooter(): void {
    if (this.state.config.settings?.mcpFooterStatus === "off") {
      this.state.ui?.setStatus("mcp", undefined);
      return;
    }
    updateStatusBar(this.state);
  }
}

export async function reconcileSessionState(input: ReconcileSessionInput): Promise<void> {
  await new SessionReconciler(input).run();
  const refreshedServers = await refreshLiveSkillsForEnabledServers(input.state);
  syncAllStateSkills(input.state);
  if (refreshedServers.length === 0) {
    return;
  }
  for (const name of refreshedServers) {
    updateMetadataCache(input.state, name);
    notifyToolMetadataUpdated(input.state, name, "skills-refresh");
  }
  publishMcpStatusSnapshot(input.state);
  input.onSurfaceChanged();
}
