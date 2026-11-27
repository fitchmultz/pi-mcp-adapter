import { getServerProvenance, isPathInsideProject } from "./config.ts";
import type { McpExtensionState } from "./state.ts";
import {
  isServerDisabled,
  type McpConfig,
  type ServerEntry,
  type ServerProvenance,
} from "./types.ts";

export interface SkillTrustContext {
  readonly projectTrusted: boolean;
  readonly cwd?: string | undefined;
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
