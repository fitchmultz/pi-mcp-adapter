import { existsSync, readFileSync } from "node:fs";
import type {
  BlockedServerInfo,
  ConfigDiscoverySource,
  ConfigSourceReport,
  ConfigSourceSpec,
  ImportConfigSummary,
  McpConfigConflict,
  McpDiscoverySummary,
  RepoPromptDiscovery,
} from "./config-contracts.ts";
import { extractServers, parseJsonConfig, type LoadedSourceConfig } from "./config-imports.ts";
import {
  getGenericGlobalConfigPath,
  IMPORT_PATHS,
  REPOPROMPT_BINARY_CANDIDATES,
  findProjectRoot,
  getProjectConfigPath,
  isProjectConfigSource,
} from "./config-paths.ts";
import type {
  HostConfigDiscovery,
  ImportKind,
  McpConfigValidationError,
  ServerEntry,
} from "./config-types.ts";
import { isConfigObject, isImportKind } from "./config-validation.ts";

export interface LoadedConfigSource {
  readonly source: ConfigSourceSpec;
  readonly loaded: LoadedSourceConfig | null;
}

export interface ImportReader {
  readonly readImport: (
    kind: ImportKind,
    warningPrefix?: string,
  ) => { path: string; value: unknown } | null;
}

type ConflictSource = { kind: "shared" | "pi" | "host"; path: string };

function readStaticServerNames(filePath: string): string[] {
  try {
    const parsed = parseJsonConfig(readFileSync(filePath, "utf-8"));
    if (!isConfigObject(parsed)) {
      return [];
    }
    const rawServers = parsed.mcpServers ?? parsed["mcp-servers"];
    return isConfigObject(rawServers) ? Object.keys(rawServers) : [];
  } catch {
    return [];
  }
}

export function inspectBlockedProjectSources(
  allSources: readonly ConfigSourceSpec[],
  cwd: string,
  includeProject: boolean,
  activeServerNames: ReadonlySet<string> = new Set(),
): { blockedServers: BlockedServerInfo[]; blockedPaths: Map<string, string[]> } {
  const blockedServers: BlockedServerInfo[] = [];
  const blockedPaths = new Map<string, string[]>();
  if (includeProject) {
    return { blockedServers, blockedPaths };
  }
  const seenServers = new Set<string>();
  for (const source of allSources) {
    if (!isProjectConfigSource(source, cwd) || !existsSync(source.readPath)) {
      continue;
    }
    const names = readStaticServerNames(source.readPath);
    blockedPaths.set(source.readPath, names);
    for (const name of names) {
      if (!activeServerNames.has(name) && !seenServers.has(name)) {
        seenServers.add(name);
        blockedServers.push({
          name,
          sourcePath: source.readPath,
          reason: "Project is not trusted",
        });
      }
    }
  }
  return { blockedServers, blockedPaths };
}

function resolveConfigSourceStatus(input: {
  source: ConfigSourceSpec;
  match: LoadedConfigSource | undefined;
  errorPaths: ReadonlySet<string>;
  exists: boolean;
  excludedReason: string | undefined;
}): "loaded" | "excluded" | "error" | "missing" {
  const { source, match, errorPaths, exists, excludedReason } = input;
  if (match?.loaded !== null && match?.loaded !== undefined) {
    return "loaded";
  }
  if (errorPaths.has(match?.source.readPath ?? source.readPath)) {
    return "error";
  }
  if (!exists) {
    return "missing";
  }
  return excludedReason === undefined ? "error" : "excluded";
}

function buildSingleSourceReport(input: {
  source: ConfigSourceSpec;
  loadedByPath: ReadonlyMap<string, LoadedConfigSource>;
  errorPaths: ReadonlySet<string>;
  blockedPaths: ReadonlyMap<string, string[]>;
  excludedReasons: ReadonlyMap<string, string> | undefined;
}): ConfigSourceReport {
  const { source, loadedByPath, errorPaths, blockedPaths, excludedReasons } = input;
  const blockedNames = blockedPaths.get(source.readPath);
  if (blockedNames !== undefined) {
    return {
      id: source.id,
      label: source.label,
      path: source.readPath,
      kind: source.kind,
      scope: source.scope,
      status: "blocked",
      serverCount: blockedNames.length,
      blockedReason: "Project is not trusted",
    };
  }
  const match = loadedByPath.get(source.readPath);
  const exists = existsSync(source.readPath);
  const matchedExclusion = excludedReasons?.get(source.readPath);
  const status = resolveConfigSourceStatus({
    source,
    match,
    errorPaths,
    exists,
    excludedReason: matchedExclusion,
  });
  const excludedReason = status === "excluded" ? matchedExclusion : undefined;
  return {
    id: source.id,
    label: source.label,
    path: source.readPath,
    kind: source.kind,
    scope: source.scope,
    status,
    serverCount: match?.loaded ? Object.keys(match.loaded.config.mcpServers).length : 0,
    ...(excludedReason !== undefined ? { excludedReason } : {}),
  };
}

function buildImportSourceReport(input: {
  imp: ImportConfigSummary;
  errorPaths: ReadonlySet<string>;
  hostConfigDiscovery: HostConfigDiscovery | undefined;
  activeImportKinds: ReadonlySet<ImportKind> | undefined;
}): ConfigSourceReport {
  const { imp, errorPaths, hostConfigDiscovery, activeImportKinds } = input;
  if (errorPaths.has(imp.path)) {
    return {
      id: `import-${imp.kind}`,
      label: imp.kind,
      path: imp.path,
      kind: "import",
      scope: "global",
      status: "error",
      serverCount: imp.serverCount,
      importKind: imp.kind,
    };
  }
  const active = hostConfigDiscovery === "on" || activeImportKinds?.has(imp.kind) === true;
  return {
    id: `import-${imp.kind}`,
    label: imp.kind,
    path: imp.path,
    kind: "import",
    scope: "global",
    status: active ? "loaded" : "excluded",
    serverCount: imp.serverCount,
    importKind: imp.kind,
    ...(active ? {} : { excludedReason: "Host config discovery is off" }),
  };
}

export function buildSourceReports(input: {
  allSources: readonly ConfigSourceSpec[];
  loadedSources: readonly LoadedConfigSource[];
  errors: readonly McpConfigValidationError[];
  blockedPaths: ReadonlyMap<string, string[]>;
  imports: readonly ImportConfigSummary[];
  excludedReasons?: ReadonlyMap<string, string>;
  hostConfigDiscovery?: HostConfigDiscovery;
  activeImportKinds?: ReadonlySet<ImportKind>;
}): ConfigSourceReport[] {
  const loadedByPath = new Map(input.loadedSources.map((entry) => [entry.source.readPath, entry]));
  const errorPaths = new Set(
    input.errors.filter((error) => error.severity === "error").map((error) => error.filePath),
  );
  const reports = input.allSources.map((source) =>
    buildSingleSourceReport({
      source,
      loadedByPath,
      errorPaths,
      blockedPaths: input.blockedPaths,
      excludedReasons: input.excludedReasons,
    }),
  );
  for (const imp of input.imports) {
    reports.push(
      buildImportSourceReport({
        imp,
        errorPaths,
        hostConfigDiscovery: input.hostConfigDiscovery,
        activeImportKinds: input.activeImportKinds,
      }),
    );
  }
  return reports;
}

export function buildImportsSummary(cache: ImportReader): ImportConfigSummary[] {
  return Object.keys(IMPORT_PATHS)
    .filter(isImportKind)
    .map((kind) => {
      const imported = cache.readImport(
        kind,
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
}

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

function detectRepoPrompt(
  loadedSources: readonly LoadedConfigSource[],
  cwd: string,
): RepoPromptDiscovery {
  for (const { source, loaded } of loadedSources) {
    if (!source.shared || !loaded) {
      continue;
    }
    for (const [name, entry] of Object.entries(loaded.config.mcpServers)) {
      if (isRepoPromptServer(name, entry)) {
        return { configured: true, configuredPath: source.readPath };
      }
    }
  }
  const executablePath = REPOPROMPT_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
  if (executablePath === undefined) {
    return { configured: false };
  }
  const projectRoot = findProjectRoot(cwd);
  const targetPath =
    projectRoot !== null ? getProjectConfigPath(projectRoot) : getGenericGlobalConfigPath();
  return {
    configured: false,
    executablePath,
    targetPath,
    serverName: "repoprompt",
    entry: { command: executablePath, args: [], lifecycle: "lazy" },
  };
}

function recordConflictSource(
  seen: Map<string, ConflictSource[]>,
  name: string,
  source: ConflictSource,
): void {
  const entries = seen.get(name) ?? [];
  if (!entries.some((entry) => entry.kind === source.kind && entry.path === source.path)) {
    entries.push(source);
  }
  seen.set(name, entries);
}

function collectImportConflicts(
  seen: Map<string, ConflictSource[]>,
  importKinds: readonly ImportKind[],
  cache: ImportReader,
): void {
  for (const importKind of importKinds) {
    const imported = cache.readImport(importKind);
    if (!imported) {
      continue;
    }
    for (const name of Object.keys(extractServers(imported.value, importKind))) {
      recordConflictSource(seen, name, { kind: "host", path: imported.path });
    }
  }
}

function getConfigConflicts(
  loadedSources: readonly LoadedConfigSource[],
  imports: readonly ImportConfigSummary[],
  cache: ImportReader,
): McpConfigConflict[] {
  const seen = new Map<string, ConflictSource[]>();
  collectImportConflicts(
    seen,
    imports.map((entry) => entry.kind),
    cache,
  );
  for (const { source, loaded } of loadedSources) {
    if (!loaded) {
      continue;
    }
    collectImportConflicts(seen, loaded.config.imports ?? [], cache);
    const kind = source.shared ? "shared" : "pi";
    for (const name of Object.keys(loaded.config.mcpServers)) {
      recordConflictSource(seen, name, { kind, path: source.readPath });
    }
  }
  const conflicts: McpConfigConflict[] = [];
  for (const [serverName, sources] of seen) {
    const winner = sources.at(-1);
    if (sources.length > 1 && winner !== undefined) {
      conflicts.push({ serverName, sources, winner });
    }
  }
  return conflicts.sort((left, right) => left.serverName.localeCompare(right.serverName));
}

export function buildDiscoverySummary(input: {
  loadedSources: readonly LoadedConfigSource[];
  imports: readonly ImportConfigSummary[];
  hostConfigDiscovery: HostConfigDiscovery;
  cache: ImportReader;
  cwd: string;
}): McpDiscoverySummary {
  const sources = input.loadedSources.map(({ source, loaded }) => ({
    id: source.id,
    label: source.label,
    path: source.readPath,
    exists: existsSync(source.readPath),
    scope: source.scope,
    kind: source.shared ? "shared" : "pi",
    serverCount: loaded ? Object.keys(loaded.config.mcpServers).length : 0,
  })) satisfies ConfigDiscoverySource[];
  const hostConfigs = input.imports.map((entry) => ({
    ...entry,
    active: input.hostConfigDiscovery === "on",
  }));
  const totalServerCount = sources.reduce((sum, source) => sum + source.serverCount, 0);
  const hasSharedServers = sources.some(
    (source) => source.kind === "shared" && source.serverCount > 0,
  );
  const hasPiOwnedServers = sources.some(
    (source) => source.kind === "pi" && source.serverCount > 0,
  );
  const hasAnyDetectedPaths = sources.some((source) => source.exists) || input.imports.length > 0;
  const hasAnyConfig =
    totalServerCount > 0 ||
    input.imports.some((entry) => entry.serverCount > 0) ||
    hasAnyDetectedPaths;
  return {
    sources,
    imports: [...input.imports],
    hostConfigs,
    hostConfigDiscovery: input.hostConfigDiscovery,
    conflicts: getConfigConflicts(input.loadedSources, input.imports, input.cache),
    hasAnyConfig,
    hasAnyDetectedPaths,
    hasSharedServers,
    hasPiOwnedServers,
    totalServerCount,
    repoPrompt: detectRepoPrompt(input.loadedSources, input.cwd),
  };
}
