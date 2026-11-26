import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadSkillsFromDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./agent-dir.ts";
import { getServerProvenance, isPathInsideProject } from "./config.ts";
import { logger } from "./logger.ts";
import { discoverServerSkills, type VerifiedSkillBundle } from "./mcp-skills.ts";
import type { ServerConnection } from "./server-connection.ts";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type ServerEntry, type SkillMetadata } from "./types.ts";

const SKILLS_DIR_NAME = "mcp-skills";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STARTUP_SKILLS_DISCOVERY_WAIT_MS = 2_500;

interface StateSkillMaps {
  readonly runtimeId: string;
  readonly metadata: Map<string, SkillMetadata[]>;
  readonly paths: Map<string, string[]>;
}

const fallbackSkillMaps = new WeakMap<McpExtensionState, StateSkillMaps>();

function getSkillMaps(state: McpExtensionState): StateSkillMaps {
  if (
    state.skillsRuntimeId !== undefined &&
    state.skillMetadata !== undefined &&
    state.skillPaths !== undefined
  ) {
    return {
      runtimeId: state.skillsRuntimeId,
      metadata: state.skillMetadata,
      paths: state.skillPaths,
    };
  }
  let maps = fallbackSkillMaps.get(state);
  if (!maps) {
    maps = {
      runtimeId: state.skillsRuntimeId ?? createSkillsRuntimeId(),
      metadata: state.skillMetadata ?? new Map<string, SkillMetadata[]>(),
      paths: state.skillPaths ?? new Map<string, string[]>(),
    };
    fallbackSkillMaps.set(state, maps);
  }
  return maps;
}

function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  chmodSync(dirPath, DIR_MODE);
}

function assertWithinParent(parentDir: string, childPath: string): string {
  const resolvedParent = resolve(parentDir);
  const resolvedChild = resolve(childPath);
  if (!resolvedChild.startsWith(`${resolvedParent}${sep}`)) {
    throw new Error(`Path escapes adapter skills directory: ${childPath}`);
  }
  return resolvedChild;
}

function sanitizeServerDirName(serverName: string): string {
  const cleaned = serverName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeBase =
    cleaned === "" || cleaned === "." || cleaned === ".." ? "server" : cleaned.slice(0, 48);
  const digest = createHash("sha256").update(serverName, "utf8").digest("hex").slice(0, 8);
  return `${safeBase}-${digest}`;
}

export function createSkillsRuntimeId(): string {
  return `${process.pid}-${randomUUID()}`;
}

function getSkillsRootDir(): string {
  return join(getAgentDir(), SKILLS_DIR_NAME);
}

function getRuntimeSkillsDir(runtimeId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runtimeId)) {
    throw new Error(`Unsafe skills runtime identifier: ${runtimeId}`);
  }
  return assertWithinParent(getSkillsRootDir(), join(getSkillsRootDir(), runtimeId));
}

function materializeSingleSkill(
  serverStageDir: string,
  bundle: VerifiedSkillBundle,
  serverName: string,
): { metadata: SkillMetadata; dir: string } | null {
  const skillDir = assertWithinParent(serverStageDir, join(serverStageDir, bundle.dirName));
  ensurePrivateDir(skillDir);
  for (const file of bundle.files) {
    const filePath = assertWithinParent(skillDir, join(skillDir, ...file.relativeSegments));
    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE });
    writeFileSync(filePath, file.content, { mode: FILE_MODE, flag: "wx" });
  }
  const loaded = loadSkillsFromDir({ dir: skillDir, source: "mcp" });
  if (loaded.skills.length !== 1 || loaded.skills[0]?.name !== bundle.dirName) {
    rmSync(skillDir, { recursive: true, force: true });
    logger.warn(
      `MCP: skipped skill "${bundle.dirName}" from ${serverName} — rejected by Pi skill loader`,
    );
    return null;
  }
  return { metadata: bundle.metadata, dir: skillDir };
}

function materializeVerifiedSkills(input: {
  readonly runtimeId: string;
  readonly serverName: string;
  readonly bundles: readonly VerifiedSkillBundle[];
}): { metadata: SkillMetadata[]; paths: string[] } {
  const { runtimeId, serverName, bundles } = input;
  const rootDir = getSkillsRootDir();
  const runtimeDir = getRuntimeSkillsDir(runtimeId);
  ensurePrivateDir(rootDir);
  ensurePrivateDir(runtimeDir);

  const serverSlug = sanitizeServerDirName(serverName);
  const serverDir = assertWithinParent(runtimeDir, join(runtimeDir, serverSlug));
  const stageDir = assertWithinParent(
    runtimeDir,
    join(runtimeDir, `.stage-${serverSlug}-${randomUUID()}`),
  );
  ensurePrivateDir(stageDir);

  const accepted: SkillMetadata[] = [];
  const relativeSkillDirs: string[] = [];
  try {
    for (const bundle of bundles) {
      const result = materializeSingleSkill(stageDir, bundle, serverName);
      if (result) {
        accepted.push(result.metadata);
        relativeSkillDirs.push(bundle.dirName);
      }
    }
    rmSync(serverDir, { recursive: true, force: true });
    if (accepted.length === 0) {
      rmSync(stageDir, { recursive: true, force: true });
      return { metadata: [], paths: [] };
    }
    renameSync(stageDir, serverDir);
    ensurePrivateDir(serverDir);
    return {
      metadata: accepted,
      paths: relativeSkillDirs.map((dirName) =>
        assertWithinParent(serverDir, join(serverDir, dirName)),
      ),
    };
  } catch (error) {
    rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function isTrustedSkillOrigin(
  state: McpExtensionState,
  serverName: string,
  definition: ServerEntry,
): boolean {
  if (state.projectTrusted !== false) {
    return true;
  }
  if (state.programmaticConfig === true || state.cwd === undefined) {
    return false;
  }
  const options = state.includeNativePi === false ? { includeNativePi: false } : undefined;
  const provenance = getServerProvenance(state.configPath, state.cwd, options).get(serverName);
  if (!provenance || provenance.kind === "project") {
    return false;
  }
  if (isPathInsideProject(provenance.path, state.cwd)) {
    return false;
  }
  return definition.cwd === undefined || !isPathInsideProject(definition.cwd, state.cwd);
}

export function canExposeServerSkills(state: McpExtensionState, serverName: string): boolean {
  if (state.config.settings?.exposeSkills === false) {
    return false;
  }
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition) || definition.exposeSkills === false) {
    return false;
  }
  return isTrustedSkillOrigin(state, serverName, definition);
}

export function cleanupServerSkills(state: McpExtensionState, serverName: string): void {
  const maps = getSkillMaps(state);
  maps.metadata.delete(serverName);
  maps.paths.delete(serverName);
  const runtimeDir = getRuntimeSkillsDir(maps.runtimeId);
  const serverDir = assertWithinParent(
    runtimeDir,
    join(runtimeDir, sanitizeServerDirName(serverName)),
  );
  rmSync(serverDir, { recursive: true, force: true });
}

export function cleanupRuntimeSkills(state: McpExtensionState): void {
  const maps = getSkillMaps(state);
  maps.metadata.clear();
  maps.paths.clear();
  const runtimeDir = getRuntimeSkillsDir(maps.runtimeId);
  rmSync(runtimeDir, { recursive: true, force: true });
}

export function syncConnectedServerSkills(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
): void {
  if (!canExposeServerSkills(state, serverName)) {
    cleanupServerSkills(state, serverName);
    return;
  }
  const bundles = connection.verifiedSkillBundles ?? [];
  if (bundles.length === 0) {
    cleanupServerSkills(state, serverName);
    return;
  }
  const maps = getSkillMaps(state);
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
}

function syncSingleServerSkillState(
  state: McpExtensionState,
  maps: StateSkillMaps,
  name: string,
  definition: ServerEntry,
): void {
  if (isServerDisabled(definition) || !canExposeServerSkills(state, name)) {
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

export function syncAllStateSkills(state: McpExtensionState): void {
  const maps = getSkillMaps(state);
  for (const name of Array.from(maps.metadata.keys())) {
    if (!canExposeServerSkills(state, name)) {
      cleanupServerSkills(state, name);
    }
  }
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    syncSingleServerSkillState(state, maps, name, definition);
  }
}

export function getActiveSkillPaths(state: McpExtensionState): string[] {
  const maps = getSkillMaps(state);
  const paths = new Set<string>();
  for (const [name, serverPaths] of maps.paths.entries()) {
    if (!canExposeServerSkills(state, name)) {
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
): Promise<void> {
  const result = await discoverServerSkills({
    serverName: name,
    client: connection.client,
    exposeSkills: true,
    signal: state.owner.signal,
  });
  if (state.owner.signal.aborted || state.manager.getConnection(name) !== connection) {
    return;
  }
  if (result.failed !== true && result.supported) {
    Object.assign(connection, {
      skills: result.skills.map((bundle) => bundle.metadata),
      verifiedSkillBundles: result.skills,
    });
    syncConnectedServerSkills(state, name, connection);
  }
}

export async function refreshLiveSkillsForEnabledServers(state: McpExtensionState): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    if (isServerDisabled(definition) || !canExposeServerSkills(state, name)) {
      continue;
    }
    const connection = state.manager.getConnection(name);
    if (!connection || connection.status !== "connected" || connection.skills !== undefined) {
      continue;
    }
    tasks.push(refreshServerSkillsForConnection(state, name, connection));
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
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

function canAnyStartupServerExposeSkills(state: McpExtensionState | null): boolean {
  if (!state) {
    return true;
  }
  if (state.config.settings?.exposeSkills === false) {
    return false;
  }
  return Object.values(state.config.mcpServers).some(
    (definition) => !isServerDisabled(definition) && definition.exposeSkills !== false,
  );
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
    readHostState: () => {
      initPromise: Promise<McpExtensionState> | null;
      startPromise: Promise<void> | null;
      state: McpExtensionState | null;
    };
    ctx: ExtensionContext;
  }): Promise<ResourcesDiscoverResult | undefined> {
    await awaitPromiseWithGrace(input.readHostState().startPromise);
    if (canAnyStartupServerExposeSkills(input.readHostState().state)) {
      await awaitPromiseWithGrace(input.readHostState().initPromise);
    }
    const state = input.readHostState().state;
    if (!state) {
      return undefined;
    }
    this.activeContext = { projectTrusted: input.ctx.isProjectTrusted(), cwd: input.ctx.cwd };
    const scopedState: McpExtensionState = {
      ...state,
      projectTrusted: this.activeContext.projectTrusted,
      cwd: this.activeContext.cwd,
    };
    syncAllStateSkills(scopedState);
    const skillPaths = getActiveSkillPaths(scopedState);
    this.discovered = true;
    this.delivered = new Set(skillPaths);
    this.pendingReload = false;
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  }

  handleStateUpdate(state: McpExtensionState | null): void {
    if (!state) {
      return;
    }
    const scopedState =
      this.activeContext === undefined
        ? state
        : {
            ...state,
            projectTrusted: this.activeContext.projectTrusted,
            cwd: this.activeContext.cwd,
          };
    syncAllStateSkills(scopedState);
    if (!this.discovered) {
      return;
    }
    const nextPaths = getActiveSkillPaths(scopedState);
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

  register(
    pi: ExtensionAPI,
    readHostState: () => {
      initPromise: Promise<McpExtensionState> | null;
      startPromise: Promise<void> | null;
      state: McpExtensionState | null;
    },
  ): void {
    pi.on("resources_discover", (_event, ctx) =>
      this.discover({
        readHostState,
        ctx,
      }),
    );
  }
}
