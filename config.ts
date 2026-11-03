import { isImportKind } from "./config-validation.ts";
import { existsSync } from "node:fs";
import type { HostConfigDiscovery, McpConfig, ServerEntry, ImportKind } from "./config-types.ts";
import type { ServerProvenance } from "./types.ts";
import type {
  KnownServerPreset,
  ConfigSourceSpec,
  McpDiscoverySummary,
  ConfigDiscoverySource,
  ImportConfigSummary,
  LoadMcpConfigOptions,
  McpConfigConflict,
  RepoPromptDiscovery,
} from "./config-contracts.ts";
import {
  getConfigSources,
  isProjectConfigSource,
  getPiGlobalConfigPath,
  getProjectConfigPath,
  findProjectRoot,
  GENERIC_GLOBAL_CONFIG_PATH,
  REPOPROMPT_BINARY_CANDIDATES,
  IMPORT_PATHS,
} from "./config-paths.ts";
import { loadImportedConfig, readValidatedConfig, extractServers } from "./config-imports.ts";
import { mergeConfigs, expandImports } from "./config-merge.ts";
export type * from "./config-contracts.ts";
export {
  getPiGlobalConfigPath,
  getProjectConfigPath,
  getProjectPiConfigPath,
  isPathInsideProject,
} from "./config-paths.ts";

export const KNOWN_SERVER_PRESETS: readonly KnownServerPreset[] = [
  {
    id: "deepwiki",
    name: "DeepWiki",
    summary: "Ask questions about public GitHub repositories.",
    entry: { url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    id: "context7",
    name: "Context7",
    summary: "Look up current library documentation and examples.",
    entry: { url: "https://mcp.context7.com/mcp" },
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Search and work with your Notion workspace.",
    entry: { url: "https://mcp.notion.com/mcp", auth: "oauth" },
  },
  {
    id: "github",
    name: "GitHub",
    summary: "Work with GitHub through your Copilot account.",
    entry: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    summary: "Inspect and automate a local Chrome browser.",
    entry: { command: "npx", args: ["-y", "chrome-devtools-mcp"] },
  },
];

export function getMcpDiscoverySummary(
  overridePath?: string,
  cwd = process.cwd(),
): McpDiscoverySummary {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const sources = sourceSpecs.map((source) => {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    return {
      id: source.id,
      label: source.label,
      path: source.readPath,
      exists: existsSync(source.readPath),
      scope: source.scope,
      kind: source.shared ? "shared" : "pi",
      serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
    } satisfies ConfigDiscoverySource;
  });

  const imports = Object.keys(IMPORT_PATHS)
    .filter(isImportKind)
    .map((kind) => {
      const imported = loadImportedConfig(
        kind,
        cwd,
        `Failed to inspect imported MCP config from ${kind}:`,
      );
      if (!imported) {
        return null;
      }
      return {
        kind,
        path: imported.path,
        serverCount: Object.keys(extractServers(imported.value, kind)).length,
      } satisfies ImportConfigSummary;
    })
    .filter((value): value is ImportConfigSummary => value !== null);
  const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd);
  const hostConfigs = imports.map((entry) => ({ ...entry, active: hostConfigDiscovery === "on" }));
  const totalServerCount = sources.reduce((sum, source) => sum + source.serverCount, 0);
  const hasSharedServers = sources.some(
    (source) => source.kind === "shared" && source.serverCount > 0,
  );
  const hasPiOwnedServers = sources.some(
    (source) => source.kind === "pi" && source.serverCount > 0,
  );
  const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0;
  const hasAnyConfig =
    totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;

  const summaryWithoutRepoPrompt = {
    sources,
    imports,
    hostConfigs,
    hostConfigDiscovery,
    conflicts: getConfigConflicts(sourceSpecs, imports, cwd),
    hasAnyConfig,
    hasAnyDetectedPaths,
    hasSharedServers,
    hasPiOwnedServers,
    totalServerCount,
  };

  return {
    ...summaryWithoutRepoPrompt,
    repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
  };
}

export function cloneMcpConfig(config: McpConfig): McpConfig {
  return structuredClone(config);
}

export function loadMcpConfig(
  overridePath?: string,
  cwd = process.cwd(),
  options: LoadMcpConfigOptions = {},
): McpConfig {
  const includeProject = options.includeProject !== false;
  const sourceSpecs = getConfigSources(overridePath, cwd).filter(
    (source) => includeProject || !isProjectConfigSource(source, cwd),
  );
  const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd, includeProject);
  // Host files are a lower-precedence fallback. This ordering means an opt-in
  // discovery cannot override a shared or Pi-owned definition, and all normal
  // URL-bound credential stripping remains in mergeServerMaps.
  let config: McpConfig =
    hostConfigDiscovery === "on"
      ? loadDiscoveredHostConfigs(cwd, includeProject)
      : { mcpServers: {} };

  for (const source of sourceSpecs) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) {
      continue;
    }
    config = mergeConfigs(config, expandImports(loaded, cwd, includeProject));
  }

  return config;
}

function getConfiguredHostConfigDiscovery(
  overridePath?: string,
  cwd = process.cwd(),
  includeProject = true,
): HostConfigDiscovery {
  let configured: HostConfigDiscovery = "off";
  for (const source of getConfigSources(overridePath, cwd)) {
    if (!includeProject && isProjectConfigSource(source, cwd)) {
      continue;
    }
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    const value = loaded?.settings?.hostConfigDiscovery;
    if (value === "off" || value === "on") {
      configured = value;
    }
  }
  return configured;
}

function loadDiscoveredHostConfigs(cwd: string, includeProject: boolean): McpConfig {
  let config: McpConfig = { mcpServers: {} };
  for (const importKind of Object.keys(IMPORT_PATHS).filter(isImportKind)) {
    const imported = loadImportedConfig(
      importKind,
      cwd,
      `Failed to discover imported MCP config from ${importKind}:`,
      includeProject,
    );
    if (!imported) {
      continue;
    }
    config = mergeConfigs(config, {
      mcpServers: extractServers(imported.value, importKind),
    });
  }
  return config;
}

function getConfigConflicts(
  sourceSpecs: ConfigSourceSpec[],
  imports: ImportConfigSummary[],
  cwd: string,
): McpConfigConflict[] {
  const seen = new Map<string, Array<{ kind: "shared" | "pi" | "host"; path: string }>>();
  const record = (name: string, source: { kind: "shared" | "pi" | "host"; path: string }): void => {
    const entries = seen.get(name) ?? [];
    if (!entries.some((entry) => entry.kind === source.kind && entry.path === source.path)) {
      entries.push(source);
    }
    seen.set(name, entries);
  };

  // Host candidates are listed first because, when enabled, they are the
  // lowest-precedence fallback. The fixed IMPORT_PATHS order is deterministic.
  for (const imported of importedServerSources(
    imports.map((entry) => entry.kind),
    cwd,
  )) {
    for (const name of imported.names) {
      record(name, { kind: "host", path: imported.path });
    }
  }
  for (const source of sourceSpecs) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) {
      continue;
    }
    for (const imported of importedServerSources(loaded.imports ?? [], cwd)) {
      for (const name of imported.names) {
        record(name, { kind: "host", path: imported.path });
      }
    }
    for (const name of Object.keys(loaded.mcpServers)) {
      record(name, {
        kind: source.shared ? "shared" : "pi",
        path: source.readPath,
      });
    }
  }

  return summarizeConflicts(seen);
}

function summarizeConflicts(seen: Map<string, McpConfigConflict["sources"]>): McpConfigConflict[] {
  const conflicts: McpConfigConflict[] = [];
  for (const [serverName, sources] of seen) {
    const winner = sources.at(-1);
    if (sources.length > 1 && winner !== undefined) {
      conflicts.push({ serverName, sources, winner });
    }
  }
  return conflicts.sort((left, right) => left.serverName.localeCompare(right.serverName));
}

export { writeProjectServerDisabledOverride } from "./config-disabled.ts";

function isRepoPromptServer(name: string, entry: ServerEntry): boolean {
  const normalizedName = name.toLowerCase();
  if (normalizedName.includes("repoprompt") || normalizedName === "rp") {
    return true;
  }

  const command = entry.command?.toLowerCase() ?? "";
  if (
    command.includes("repoprompt") ||
    command.includes("rp-mcp") ||
    command.endsWith("repoprompt_cli")
  ) {
    return true;
  }

  return (entry.args ?? []).some(
    (arg) => typeof arg === "string" && arg.toLowerCase().includes("repoprompt"),
  );
}

function buildRepoPromptEntry(executablePath: string): ServerEntry {
  return {
    command: executablePath,
    args: [],
    lifecycle: "lazy",
  };
}

function detectRepoPrompt(
  summary: Omit<McpDiscoverySummary, "repoPrompt">,
  cwd = process.cwd(),
): RepoPromptDiscovery {
  for (const source of summary.sources) {
    if (source.kind !== "shared" || source.serverCount === 0) {
      continue;
    }
    const config = readValidatedConfig(source.path, `MCP config from ${source.path}`);
    if (!config) {
      continue;
    }
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (isRepoPromptServer(name, entry)) {
        return { configured: true, configuredPath: source.path };
      }
    }
  }

  const executablePath = REPOPROMPT_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
  if (executablePath === undefined) {
    return { configured: false };
  }

  const projectRoot = findProjectRoot(cwd);
  const targetPath =
    projectRoot !== null ? getProjectConfigPath(projectRoot) : GENERIC_GLOBAL_CONFIG_PATH;
  return {
    configured: false,
    executablePath,
    targetPath,
    serverName: "repoprompt",
    entry: buildRepoPromptEntry(executablePath),
  };
}

export {
  previewCompatibilityImports,
  ensureCompatibilityImports,
  buildStarterProjectConfig,
  previewStarterProjectConfig,
  writeStarterProjectConfig,
  previewSharedServerEntry,
  writeSharedServerEntry,
  writeDirectToolsConfig,
  resolveConfiguredOAuthDir,
} from "./config-writes.ts";

export function getServerProvenance(
  overridePath?: string,
  cwd = process.cwd(),
): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const userPath = getPiGlobalConfigPath(overridePath);

  if (getConfiguredHostConfigDiscovery(overridePath, cwd) === "on") {
    for (const imported of importedServerSources(
      Object.keys(IMPORT_PATHS).filter(isImportKind),
      cwd,
    )) {
      for (const name of imported.names) {
        provenance.set(name, { path: userPath, kind: "import", importKind: imported.importKind });
      }
    }
  }

  for (const source of getConfigSources(overridePath, cwd)) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) {
      continue;
    }

    addInheritedProvenance(provenance, loaded.imports ?? [], userPath, cwd);

    for (const name of Object.keys(loaded.mcpServers)) {
      provenance.set(name, {
        path: source.writePath,
        kind: source.kind,
        ...(source.importKind !== undefined ? { importKind: source.importKind } : {}),
      });
    }
  }

  return provenance;
}

function* importedServerSources(
  importKinds: ImportKind[],
  cwd: string,
): Generator<{ importKind: ImportKind; path: string; names: string[] }> {
  for (const importKind of importKinds) {
    const imported = loadImportedConfig(
      importKind,
      cwd,
      `Failed to inspect imported MCP config from ${importKind}:`,
    );
    if (imported) {
      yield {
        importKind,
        path: imported.path,
        names: Object.keys(extractServers(imported.value, importKind)),
      };
    }
  }
}

function addInheritedProvenance(
  provenance: Map<string, ServerProvenance>,
  importKinds: ImportKind[],
  userPath: string,
  cwd: string,
): void {
  for (const imported of importedServerSources(importKinds, cwd)) {
    for (const name of imported.names) {
      if (!provenance.has(name)) {
        provenance.set(name, { path: userPath, kind: "import", importKind: imported.importKind });
      }
    }
  }
}
