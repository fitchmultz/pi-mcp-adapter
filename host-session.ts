import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneMcpConfig, isPathInsideProject, loadMcpConfig } from "./config.ts";
import { isServerDisabled } from "./config-protocol.ts";
import { resolveConfiguredOAuthDir } from "./config-writes.ts";
import { getMetadataCachePath } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpAdapterOptions, McpConfig, ServerEntry } from "./types.ts";
import { resolveConfigPath } from "./utils.ts";

/**
 * Phases of one adapter session.
 *
 * The phase used to be inferred from which of the state, its initialization promise and the runtime
 * owner happened to be set. "Never started", "start failed" and "shut down" were then the same
 * observation, and a failed initialization lost its reason with its promise. Every transition below
 * is the only place those fields change.
 */
export type HostSessionPhase = "idle" | "starting" | "initializing" | "ready" | "failed";

export class HostSession {
  private currentPhase: HostSessionPhase = "idle";
  private generation = 0;
  private owner: McpRuntimeOwner | null = null;
  private state: McpExtensionState | null = null;
  private initPromise: Promise<McpExtensionState> | null = null;
  private failure: string | null = null;

  get phase(): HostSessionPhase {
    return this.currentPhase;
  }

  get currentState(): McpExtensionState | null {
    return this.state;
  }

  get currentOwner(): McpRuntimeOwner | null {
    return this.owner;
  }

  get pendingInitialization(): Promise<McpExtensionState> | null {
    return this.initPromise;
  }

  /** Why the current session's initialization failed, or null. */
  get failureMessage(): string | null {
    return this.failure;
  }

  /** Starts a session and returns the generation that owns it. */
  begin(owner: McpRuntimeOwner): number {
    this.generation += 1;
    this.currentPhase = "starting";
    this.owner = owner;
    this.state = null;
    this.initPromise = null;
    this.failure = null;
    return this.generation;
  }

  /** Whether this owner and generation still own the runtime. */
  owns(owner: McpRuntimeOwner | null, generation: number): boolean {
    return (
      owner !== null && owner === this.owner && generation === this.generation && owner.isActive()
    );
  }

  /** Records the initialization that carries a starting session to ready or failed. */
  initialize(generation: number, promise: Promise<McpExtensionState>): void {
    if (generation !== this.generation) {
      return;
    }
    this.currentPhase = "initializing";
    this.initPromise = promise;
  }

  /** Publishes a state whose initialization resolved, without settling the session yet. */
  adopt(state: McpExtensionState): void {
    this.state = state;
  }

  /** Settles the session as ready; also clears a promise whose completion work failed later. */
  ready(state: McpExtensionState): void {
    this.state = state;
    this.initPromise = null;
    this.currentPhase = "ready";
  }

  /** Records a rejected initialization for a session that never published a state. */
  fail(message: string): void {
    this.currentPhase = "failed";
    this.initPromise = null;
    this.failure = message;
  }

  /** Ends the session; its owner, state and diagnostics do not survive it. */
  end(): void {
    this.generation += 1;
    this.currentPhase = "idle";
    this.owner = null;
    this.state = null;
    this.initPromise = null;
    this.failure = null;
  }
}

function isRelativeConfigPath(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    return false;
  }
  const resolved = resolveConfigPath(trimmed);
  return resolved === undefined || !isAbsolute(resolved);
}

function isStdioServerCwdDependent(definition: ServerEntry): boolean {
  if (
    isServerDisabled(definition) ||
    definition.url !== undefined ||
    definition.command === undefined
  ) {
    return false;
  }
  const explicitCwd = resolveConfigPath(definition.cwd);
  return explicitCwd === undefined || !isAbsolute(explicitCwd);
}

/** Whether any enabled stdio server inherits or resolves `cwd` relative to the session cwd. */
export function hasCwdDependentStdioServer(config: McpConfig): boolean {
  return Object.values(config.mcpServers).some(isStdioServerCwdDependent);
}

export interface ActiveSessionCwdState {
  readonly runtimeCwd: string | undefined;
  readonly runtimeCacheEnabled: boolean | undefined;
  readonly configPath: string | undefined;
  readonly config: McpConfig;
  readonly hasState: boolean;
  readonly hasInitPromise: boolean;
}

export interface ResolvedSessionCwdInput {
  readonly config: McpConfig;
  readonly configPath: string | undefined;
  readonly cacheEnabled: boolean;
}

/** Resolve effective config, config path, and metadata cache enablement for a session context. */
export function resolveSessionCwdInput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: McpAdapterOptions,
  sessionConfig: McpConfig | undefined,
): ResolvedSessionCwdInput {
  let config: McpConfig;
  let configPath: string | undefined;
  if (sessionConfig !== undefined) {
    configPath = undefined;
    config = cloneMcpConfig(sessionConfig);
  } else {
    const flag = pi.getFlag("mcp-config");
    configPath = options.configPath ?? (typeof flag === "string" ? flag : undefined);
    config = loadMcpConfig(configPath, ctx.cwd, { includeProject: ctx.isProjectTrusted() });
  }
  config = options.transformConfig
    ? cloneMcpConfig(options.transformConfig(cloneMcpConfig(config), ctx))
    : config;
  const cacheEnabled =
    ctx.isProjectTrusted() || !isPathInsideProject(getMetadataCachePath(), ctx.cwd);
  return { config, configPath, cacheEnabled };
}

/**
 * Whether switching session `cwd` invalidates relative global paths (`settings.oauthDir` or
 * `settings.trace.file`) that require reinitializing auth/trace state.
 */
export function hasRelativeSessionPathSettings(
  config: McpConfig,
  previousCwd: string | undefined,
  nextCwd: string,
): boolean {
  const oauthDir = config.settings?.oauthDir;
  if (
    resolveConfiguredOAuthDir(oauthDir, previousCwd) !==
    resolveConfiguredOAuthDir(oauthDir, nextCwd)
  ) {
    return true;
  }
  const trace = config.settings?.trace;
  if (trace?.enabled === true) {
    return trace.file === undefined || isRelativeConfigPath(trace.file);
  }
  return isRelativeConfigPath(trace?.file);
}

/** Whether a `cwd` transition can keep the running session and update stdio `defaultCwd` in place. */
export function canReuseSessionForCwd(
  current: ActiveSessionCwdState,
  resolved: ResolvedSessionCwdInput,
  nextCwd: string,
): boolean {
  if (
    resolved.cacheEnabled !== current.runtimeCacheEnabled ||
    resolved.configPath !== current.configPath ||
    !isDeepStrictEqual(resolved.config, current.config)
  ) {
    return false;
  }
  if (!current.hasState && current.hasInitPromise && hasCwdDependentStdioServer(resolved.config)) {
    return false;
  }
  return !hasRelativeSessionPathSettings(resolved.config, current.runtimeCwd, nextCwd);
}

/**
 * Expire directory-scoped session approvals and UI consent, update `state.manager`'s default stdio
 * `cwd` in place, and close only already-connected stdio servers whose working directory depends on
 * the session `cwd`, so they respawn under `nextCwd` on next use without tearing down unrelated
 * connections or resetting frozen tool declarations.
 */
export async function updateManagerCwdInPlace(
  state: McpExtensionState,
  nextCwd: string,
): Promise<void> {
  state.approvedToolCalls.clear();
  state.consentManager.clear();
  state.manager.setDefaultCwd(nextCwd);
  const closers: Promise<void>[] = [];
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (isStdioServerCwdDependent(connection.definition)) {
      closers.push(state.manager.close(name));
    }
  }
  if (closers.length > 0) {
    await Promise.allSettled(closers);
  }
}
