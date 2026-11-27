import { getAgentDir } from "./agent-dir.ts";
import type {
  ReloadedServerSkillEntry,
  ReloadedServerSkills,
  VerifiedSkillBundle,
} from "./mcp-skills.ts";
import { applyReloadedServerSkills, getSyncedSkillBundles } from "./mcp-skills-store.ts";
import { canExposeServerSkills } from "./mcp-skills-trust.ts";
import { computeServerHash } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, startsAtBoot, type ServerEntry } from "./types.ts";

export type { ReloadedServerSkillEntry, ReloadedServerSkills };

const RELOAD_SKILLS_KEY = Symbol.for("fitch-mcp-adapter/reload-skills/v1");
const RELOAD_SKILLS_TTL_MS = 60_000;

export interface ReloadSessionContextLike {
  readonly sessionManager?: { readonly getSessionId: () => string } | undefined;
}

interface ReloadSkillsSnapshot {
  readonly agentDir: string;
  readonly stashedAt: number;
  readonly servers: Map<string, ReloadedServerSkillEntry>;
}

interface ReloadSkillsStoreHost {
  readonly Date: DateConstructor;
  [RELOAD_SKILLS_KEY]?: Map<string, ReloadSkillsSnapshot> | undefined;
}

function getReloadSkillsStore(): Map<string, ReloadSkillsSnapshot> {
  const host: ReloadSkillsStoreHost = globalThis;
  let store = host[RELOAD_SKILLS_KEY];
  if (!store) {
    store = new Map();
    host[RELOAD_SKILLS_KEY] = store;
  }
  const now = Date.now();
  for (const [sessionId, entry] of store.entries()) {
    if (entry.stashedAt > now || now - entry.stashedAt > RELOAD_SKILLS_TTL_MS) {
      store.delete(sessionId);
    }
  }
  return store;
}

export function computeSafeServerHash(definition: ServerEntry): string | undefined {
  try {
    return computeServerHash(definition);
  } catch {
    return undefined;
  }
}

export function matchesServerConfigHash(definition: ServerEntry, expectedHash: string): boolean {
  const currentHash = computeSafeServerHash(definition);
  return currentHash !== undefined && currentHash === expectedHash;
}

export function readReloadSessionId(
  ctx?: ReloadSessionContextLike,
  fallbackSessionManager?: ReloadSessionContextLike["sessionManager"],
): string | undefined {
  const id = ctx?.sessionManager?.getSessionId() ?? fallbackSessionManager?.getSessionId();
  return id !== undefined && id.length > 0 ? id : undefined;
}

export function stashReloadSkillsMap(
  sessionId: string,
  servers: Map<string, ReloadedServerSkillEntry>,
): void {
  const store = getReloadSkillsStore();
  if (servers.size === 0) {
    store.delete(sessionId);
    return;
  }
  store.set(sessionId, {
    agentDir: getAgentDir(),
    stashedAt: Date.now(),
    servers: new Map(servers),
  });
}

export function consumeReloadSkillsMap(sessionId: string): ReloadedServerSkills | undefined {
  const store = getReloadSkillsStore();
  const snapshot = store.get(sessionId);
  store.delete(sessionId);
  if (!snapshot || snapshot.agentDir !== getAgentDir()) {
    return undefined;
  }
  return snapshot.servers.size > 0 ? snapshot.servers : undefined;
}

export function clearReloadSkillsMap(sessionId: string): void {
  getReloadSkillsStore().delete(sessionId);
}

export function snapshotSessionReloadSkills(
  state: McpExtensionState,
): Map<string, ReloadedServerSkillEntry> {
  const snapshot = new Map<string, ReloadedServerSkillEntry>();
  const entries: ReadonlyMap<string, readonly VerifiedSkillBundle[]> = getSyncedSkillBundles(state);
  for (const [name, bundles] of entries.entries()) {
    const definition = state.config.mcpServers[name];
    if (
      bundles.length === 0 ||
      !definition ||
      isServerDisabled(definition) ||
      startsAtBoot(definition) ||
      !canExposeServerSkills(state, name)
    ) {
      continue;
    }
    const configHash = computeSafeServerHash(definition);
    if (configHash !== undefined) {
      snapshot.set(name, { configHash, bundles });
    }
  }
  return snapshot;
}

export function restoreReloadedServerSkills(
  state: McpExtensionState,
  reloaded: ReloadedServerSkills,
): void {
  for (const [name, entry] of reloaded.entries()) {
    const definition = state.config.mcpServers[name];
    if (
      !definition ||
      isServerDisabled(definition) ||
      startsAtBoot(definition) ||
      !canExposeServerSkills(state, name) ||
      !matchesServerConfigHash(definition, entry.configHash)
    ) {
      continue;
    }
    applyReloadedServerSkills(state, name, entry.configHash, entry.bundles);
  }
}

export function takeSessionStartReloadSkills(
  event: { readonly reason?: string | undefined } | undefined,
  ctx: ReloadSessionContextLike | undefined,
  previousState: McpExtensionState | null,
): ReloadedServerSkills | undefined {
  const sessionId = readReloadSessionId(ctx);
  if (sessionId === undefined) {
    return undefined;
  }
  if (event?.reason !== "reload") {
    clearReloadSkillsMap(sessionId);
    return undefined;
  }
  const stashed = consumeReloadSkillsMap(sessionId);
  if (stashed) {
    return stashed;
  }
  const fallback = previousState ? snapshotSessionReloadSkills(previousState) : undefined;
  return fallback && fallback.size > 0 ? fallback : undefined;
}

export function completeSessionShutdownReloadSkills(
  event: { readonly reason?: string | undefined } | undefined,
  ctx: ReloadSessionContextLike | undefined,
  fallbackSessionManager: ReloadSessionContextLike["sessionManager"],
  state: McpExtensionState | null,
): void {
  const sessionId = readReloadSessionId(ctx, fallbackSessionManager);
  if (sessionId === undefined) {
    return;
  }
  if (event?.reason === "reload" && state !== null) {
    stashReloadSkillsMap(sessionId, snapshotSessionReloadSkills(state));
    return;
  }
  clearReloadSkillsMap(sessionId);
}
