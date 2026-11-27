import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import { getServerProvenance, isPathInsideProject } from "./config.ts";
import { logger } from "./logger.ts";
import { discoverServerSkills, type VerifiedSkillBundle } from "./mcp-skills.ts";
import {
  createSkillsRuntimeId,
  getRuntimeSkillsDir,
  getServerSkillsDir,
  getSkillsRootDir,
  materializeVerifiedSkills,
  pruneDeadRuntimeDirs,
  safeRemovePath,
} from "./mcp-skills-fs.ts";
import type { ServerConnection } from "./server-connection.ts";
import type { McpExtensionState } from "./state.ts";
import {
  isServerDisabled,
  type McpConfig,
  type ServerEntry,
  type ServerProvenance,
  type SkillMetadata,
} from "./types.ts";

export { createSkillsRuntimeId };

const STARTUP_SKILLS_DISCOVERY_WAIT_MS = 2_500;

interface StateSkillMaps {
  readonly runtimeId: string;
  readonly metadata: Map<string, SkillMetadata[]>;
  readonly paths: Map<string, string[]>;
  readonly syncedBundles: Map<string, readonly VerifiedSkillBundle[]>;
  prunedStaleRuntimes: boolean;
}

const fallbackSkillMaps = new WeakMap<McpExtensionState, StateSkillMaps>();
const syncedBundlesByState = new WeakMap<
  McpExtensionState,
  Map<string, readonly VerifiedSkillBundle[]>
>();
const prunedStates = new WeakSet<McpExtensionState>();

function getSkillMaps(state: McpExtensionState): StateSkillMaps {
  let syncedBundles = syncedBundlesByState.get(state);
  if (!syncedBundles) {
    syncedBundles = new Map();
    syncedBundlesByState.set(state, syncedBundles);
  }
  if (
    state.skillsRuntimeId !== undefined &&
    state.skillMetadata !== undefined &&
    state.skillPaths !== undefined
  ) {
    return {
      runtimeId: state.skillsRuntimeId,
      metadata: state.skillMetadata,
      paths: state.skillPaths,
      syncedBundles,
      prunedStaleRuntimes: prunedStates.has(state),
    };
  }
  let maps = fallbackSkillMaps.get(state);
  if (!maps) {
    maps = {
      runtimeId: state.skillsRuntimeId ?? createSkillsRuntimeId(),
      metadata: state.skillMetadata ?? new Map<string, SkillMetadata[]>(),
      paths: state.skillPaths ?? new Map<string, string[]>(),
      syncedBundles,
      prunedStaleRuntimes: prunedStates.has(state),
    };
    fallbackSkillMaps.set(state, maps);
  }
  return maps;
}

export interface SkillTrustContext {
  readonly projectTrusted: boolean;
  readonly cwd: string;
}

interface ProvenanceMemoEntry {
  readonly config: McpConfig;
  readonly configPath: string | undefined;
  readonly includeNativePi: boolean | undefined;
  readonly cwd: string;
  readonly provenance: Map<string, ServerProvenance>;
}

const provenanceMemoByState = new WeakMap<McpExtensionState, ProvenanceMemoEntry>();

function getCachedServerProvenance(
  state: McpExtensionState,
  cwd: string,
): Map<string, ServerProvenance> {
  const cached = provenanceMemoByState.get(state);
  if (
    cached &&
    cached.config === state.config &&
    cached.configPath === state.configPath &&
    cached.includeNativePi === state.includeNativePi &&
    cached.cwd === cwd
  ) {
    return cached.provenance;
  }
  const options = state.includeNativePi === false ? { includeNativePi: false } : undefined;
  const provenance = getServerProvenance(state.configPath, cwd, options);
  provenanceMemoByState.set(state, {
    config: state.config,
    configPath: state.configPath,
    includeNativePi: state.includeNativePi,
    cwd,
    provenance,
  });
  return provenance;
}

function hasUntrustedProvenanceOrCwd(input: {
  state: McpExtensionState;
  serverName: string;
  definition: ServerEntry;
  cwd: string;
}): boolean {
  const { state, serverName, definition, cwd } = input;
  const provenance = getCachedServerProvenance(state, cwd).get(serverName);
  if (!provenance || provenance.kind === "project") {
    return true;
  }
  if (isPathInsideProject(provenance.path, cwd)) {
    return true;
  }
  return definition.cwd !== undefined && isPathInsideProject(definition.cwd, cwd);
}

function isTrustedSkillOrigin(
  state: McpExtensionState,
  serverName: string,
  definition: ServerEntry,
  context?: SkillTrustContext,
): boolean {
  const projectTrusted = context?.projectTrusted ?? state.projectTrusted;
  if (projectTrusted !== false) {
    return true;
  }
  const cwd = context?.cwd ?? state.cwd;
  if (state.programmaticConfig === true || cwd === undefined) {
    return false;
  }
  return !hasUntrustedProvenanceOrCwd({ state, serverName, definition, cwd });
}

export function canExposeServerSkills(
  state: McpExtensionState,
  serverName: string,
  context?: SkillTrustContext,
): boolean {
  if (state.config.settings?.exposeSkills === false) {
    return false;
  }
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition) || definition.exposeSkills === false) {
    return false;
  }
  return isTrustedSkillOrigin(state, serverName, definition, context);
}

export function cleanupServerSkills(state: McpExtensionState, serverName: string): void {
  const maps = getSkillMaps(state);
  maps.metadata.delete(serverName);
  maps.paths.delete(serverName);
  maps.syncedBundles.delete(serverName);
  try {
    safeRemovePath(getServerSkillsDir(maps.runtimeId, serverName), serverName);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`MCP: failed to resolve skills directory for ${serverName}: ${message}`);
  }
}

export function cleanupRuntimeSkills(state: McpExtensionState): void {
  const maps = getSkillMaps(state);
  maps.metadata.clear();
  maps.paths.clear();
  maps.syncedBundles.clear();
  try {
    safeRemovePath(getRuntimeSkillsDir(maps.runtimeId), maps.runtimeId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`MCP: failed to resolve skills runtime directory: ${message}`);
  }
}

function isSyncedBundlesUnchanged(
  maps: StateSkillMaps,
  serverName: string,
  bundles: readonly VerifiedSkillBundle[],
): boolean {
  const previous = maps.syncedBundles.get(serverName);
  return previous !== undefined && (previous === bundles || isDeepStrictEqual(previous, bundles));
}

function materializeAndStoreServerSkills(
  state: McpExtensionState,
  maps: StateSkillMaps,
  serverName: string,
  bundles: readonly VerifiedSkillBundle[],
): void {
  if (!maps.prunedStaleRuntimes) {
    prunedStates.add(state);
    pruneDeadRuntimeDirs(getSkillsRootDir(), maps.runtimeId);
  }
  const materialized = materializeVerifiedSkills({
    runtimeId: maps.runtimeId,
    serverName,
    bundles,
  });
  if (materialized.metadata.length === 0) {
    cleanupServerSkills(state, serverName);
    return;
  }
  maps.metadata.set(serverName, materialized.metadata);
  maps.paths.set(serverName, materialized.paths);
  maps.syncedBundles.set(serverName, bundles);
}

function hasSyncedSkillState(maps: StateSkillMaps, serverName: string): boolean {
  return (
    maps.metadata.has(serverName) ||
    maps.paths.has(serverName) ||
    maps.syncedBundles.has(serverName)
  );
}

export function syncConnectedServerSkills(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
): void {
  const bundles = connection.verifiedSkillBundles ?? [];
  const maps = getSkillMaps(state);
  if (bundles.length === 0 && !hasSyncedSkillState(maps, serverName)) {
    return;
  }
  if (!canExposeServerSkills(state, serverName)) {
    cleanupServerSkills(state, serverName);
    return;
  }
  if (bundles.length === 0) {
    cleanupServerSkills(state, serverName);
    return;
  }
  if (isSyncedBundlesUnchanged(maps, serverName, bundles)) {
    return;
  }
  try {
    materializeAndStoreServerSkills(state, maps, serverName, bundles);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`MCP: failed to materialize skills for ${serverName}: ${message}`);
    cleanupServerSkills(state, serverName);
  }
}

function syncSingleServerSkillState(input: {
  state: McpExtensionState;
  maps: StateSkillMaps;
  name: string;
  definition: ServerEntry;
  context: SkillTrustContext | undefined;
}): void {
  const { state, maps, name, definition, context } = input;
  if (isServerDisabled(definition) || !canExposeServerSkills(state, name, context)) {
    cleanupServerSkills(state, name);
    return;
  }
  const connection = state.manager.getConnection(name);
  if (!connection || connection.status !== "connected") {
    cleanupServerSkills(state, name);
    return;
  }
  if (!maps.metadata.has(name) && (connection.verifiedSkillBundles?.length ?? 0) > 0) {
    syncConnectedServerSkills(state, name, connection);
  }
}

export function syncAllStateSkills(state: McpExtensionState, context?: SkillTrustContext): void {
  const maps = getSkillMaps(state);
  for (const name of Array.from(maps.metadata.keys())) {
    if (!canExposeServerSkills(state, name, context)) {
      cleanupServerSkills(state, name);
    }
  }
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    syncSingleServerSkillState({ state, maps, name, definition, context });
  }
}

export function getActiveSkillPaths(
  state: McpExtensionState,
  context?: SkillTrustContext,
): string[] {
  const maps = getSkillMaps(state);
  const paths = new Set<string>();
  for (const [name, serverPaths] of maps.paths.entries()) {
    if (!canExposeServerSkills(state, name, context)) {
      continue;
    }
    for (const dirPath of serverPaths) {
      paths.add(dirPath);
    }
  }
  return [...paths].sort();
}

async function refreshServerSkillsForConnection(
  state: McpExtensionState,
  name: string,
  connection: ServerConnection,
): Promise<boolean> {
  const result = await discoverServerSkills({
    serverName: name,
    client: connection.client,
    exposeSkills: true,
    signal: state.owner.signal,
  });
  if (state.owner.signal.aborted || state.manager.getConnection(name) !== connection) {
    return false;
  }
  if (result.failed === true) {
    Object.assign(connection, { skillDiscoveryFailed: true });
    return false;
  }
  if (result.supported) {
    Object.assign(connection, {
      skillDiscoveryFailed: false,
      skills: result.skills.map((bundle) => bundle.metadata),
      verifiedSkillBundles: result.skills,
    });
    syncConnectedServerSkills(state, name, connection);
    return true;
  }
  Object.assign(connection, { skillDiscoveryFailed: false });
  return false;
}

export async function refreshLiveSkillsForEnabledServers(
  state: McpExtensionState,
): Promise<string[]> {
  const tasks: Array<Promise<string | undefined>> = [];
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    if (isServerDisabled(definition) || !canExposeServerSkills(state, name)) {
      continue;
    }
    const connection = state.manager.getConnection(name);
    if (!connection || connection.status !== "connected" || connection.skills !== undefined) {
      continue;
    }
    tasks.push(
      refreshServerSkillsForConnection(state, name, connection).then((updated) =>
        updated ? name : undefined,
      ),
    );
  }
  if (tasks.length === 0) {
    return [];
  }
  const results = await Promise.allSettled(tasks);
  return results.flatMap((entry) =>
    entry.status === "fulfilled" && entry.value !== undefined ? [entry.value] : [],
  );
}

async function awaitPromiseWithGrace(promise: Promise<unknown> | null): Promise<void> {
  if (!promise) {
    return;
  }
  await Promise.race([
    promise.then(
      () => null,
      () => null,
    ),
    delay(STARTUP_SKILLS_DISCOVERY_WAIT_MS, undefined, { ref: false }),
  ]);
}

function canAnyStartupServerExposeSkills(
  state: McpExtensionState | null,
  config?: McpConfig,
): boolean {
  const activeConfig = state?.config ?? config;
  if (!activeConfig) {
    return true;
  }
  if (activeConfig.settings?.exposeSkills === false) {
    return false;
  }
  return Object.values(activeConfig.mcpServers).some(
    (definition) => !isServerDisabled(definition) && definition.exposeSkills !== false,
  );
}

export interface HostSkillsStateSnapshot {
  readonly initPromise: Promise<McpExtensionState> | null;
  readonly startPromise: Promise<void> | null;
  readonly state: McpExtensionState | null;
  readonly config?: McpConfig;
}

export class HostSkillsTracker {
  private discovered = false;
  private delivered = new Set<string>();
  private pendingReload = false;
  private lastNotifiedKey = "";
  private activeContext: { projectTrusted: boolean; cwd: string } | undefined;

  reset(): void {
    this.discovered = false;
    this.delivered.clear();
    this.pendingReload = false;
    this.lastNotifiedKey = "";
    this.activeContext = undefined;
  }

  async discover(input: {
    readHostState: () => HostSkillsStateSnapshot;
    ctx: ExtensionContext;
  }): Promise<ResourcesDiscoverResult | undefined> {
    await awaitPromiseWithGrace(input.readHostState().startPromise);
    const startup = input.readHostState();
    if (canAnyStartupServerExposeSkills(startup.state, startup.config)) {
      await awaitPromiseWithGrace(startup.initPromise);
    }
    this.activeContext = { projectTrusted: input.ctx.isProjectTrusted(), cwd: input.ctx.cwd };
    const state = input.readHostState().state;
    if (!state) {
      this.discovered = true;
      this.delivered.clear();
      this.pendingReload = false;
      this.lastNotifiedKey = "";
      return undefined;
    }
    syncAllStateSkills(state, this.activeContext);
    const skillPaths = getActiveSkillPaths(state, this.activeContext);
    this.discovered = true;
    this.delivered = new Set(skillPaths);
    this.pendingReload = false;
    this.lastNotifiedKey = skillPaths.join("\n");
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  }

  handleStateUpdate(state: McpExtensionState | null): void {
    if (!state) {
      return;
    }
    syncAllStateSkills(state, this.activeContext);
    if (!this.discovered) {
      return;
    }
    const nextPaths = getActiveSkillPaths(state, this.activeContext);
    const unchanged =
      nextPaths.length === this.delivered.size &&
      nextPaths.every((dirPath) => this.delivered.has(dirPath));
    if (unchanged) {
      this.pendingReload = false;
      return;
    }
    this.pendingReload = true;
    const key = nextPaths.join("\n");
    if (key !== this.lastNotifiedKey) {
      this.lastNotifiedKey = key;
      state.ui?.notify("MCP verified skills updated — run /reload to refresh Pi skills.", "info");
    }
  }

  consumePendingReload(): boolean {
    const pending = this.pendingReload;
    this.pendingReload = false;
    return pending;
  }

  register(pi: ExtensionAPI, readHostState: () => HostSkillsStateSnapshot): void {
    pi.on("resources_discover", (_event, ctx) =>
      this.discover({
        readHostState,
        ctx,
      }),
    );
  }
}
