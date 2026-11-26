import type {
  ConfigSourceSpec,
  LoadMcpConfigOptions,
  McpConfigSnapshot,
} from "./config-contracts.ts";
import {
  buildDiscoverySummary,
  buildImportsSummary,
  buildSourceReports,
  inspectBlockedProjectSources,
  type ImportReader,
  type LoadedConfigSource,
} from "./config-discovery.ts";
import {
  addInheritedProvenance,
  addSourceServerProvenance,
  applySourceConfigTransforms,
  extractServers,
  loadImportedConfig,
  readConfigSourceWithDiagnostics,
  readValidatedConfigWithDiagnostics,
  type LoadedSourceConfig,
} from "./config-imports.ts";
import {
  expandImports,
  hasConfiguredTransport,
  mergeConfigs,
  pruneOrphanOverrideEntries,
} from "./config-merge.ts";
import {
  updateNativePolicyTracking,
  type NativeServerPolicy,
} from "./config-native-pi-exposure.ts";
import {
  IMPORT_PATHS,
  getConfigSources,
  getPiGlobalWriteTarget,
  isProjectConfigSource,
} from "./config-paths.ts";
import type {
  HostConfigDiscovery,
  ImportKind,
  McpConfig,
  McpConfigValidationError,
  ServerEntry,
} from "./config-types.ts";
import { isImportKind } from "./config-validation.ts";
import type { ServerProvenance } from "./types.ts";

interface CachedImportEntry {
  readonly path: string;
  readonly value: unknown;
}

export class ConfigReadCache implements ImportReader {
  private readonly cwd: string;
  private readonly includeProject: boolean;
  private readonly validatedByPath = new Map<
    string,
    { config: McpConfig | null; errors: McpConfigValidationError[] }
  >();
  private readonly importsByKind = new Map<ImportKind, CachedImportEntry | null>();

  constructor(cwd: string, includeProject: boolean) {
    this.cwd = cwd;
    this.includeProject = includeProject;
  }

  readValidated(
    filePath: string,
    label: string,
  ): { config: McpConfig | null; errors: McpConfigValidationError[] } {
    const cached = this.validatedByPath.get(filePath);
    if (cached) {
      return cached;
    }
    const result = readValidatedConfigWithDiagnostics(filePath, label);
    this.validatedByPath.set(filePath, result);
    return result;
  }

  readImport(kind: ImportKind, warningPrefix?: string): CachedImportEntry | null {
    if (this.importsByKind.has(kind)) {
      return this.importsByKind.get(kind) ?? null;
    }
    const loaded = loadImportedConfig(
      kind,
      this.cwd,
      warningPrefix ?? `Failed to import MCP config from ${kind}:`,
      this.includeProject,
    );
    this.importsByKind.set(kind, loaded);
    return loaded;
  }
}

export function getFilteredConfigSources(
  overridePath: string | undefined,
  cwd: string,
  options: LoadMcpConfigOptions = {},
): ConfigSourceSpec[] {
  const includeProject = options.includeProject !== false;
  const includeNativePi = options.includeNativePi !== false;
  const includeNativePiProject = includeNativePi && options.includeNativePiProject !== false;
  return getConfigSources(overridePath, cwd).filter(
    (source) =>
      (includeProject || !isProjectConfigSource(source, cwd)) &&
      (includeNativePi || source.id !== "native-pi-global") &&
      (includeNativePiProject || source.id !== "native-pi-project"),
  );
}

function deduplicateConfigErrors(
  errors: readonly McpConfigValidationError[],
): McpConfigValidationError[] {
  const seen = new Set<string>();
  const result: McpConfigValidationError[] = [];
  for (const error of errors) {
    const key = `${error.severity}\0${error.kind}\0${error.filePath}\0${error.serverName ?? ""}\0${error.field ?? ""}\0${error.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(error);
    }
  }
  return result;
}

function supportsHostDiscoverySetting(
  source: ConfigSourceSpec,
  cwd: string,
  includeProject: boolean,
): boolean {
  return (
    source.id !== "native-pi-global" &&
    source.id !== "native-pi-project" &&
    (includeProject || !isProjectConfigSource(source, cwd))
  );
}

function resolveHostConfigDiscovery(
  allSources: readonly ConfigSourceSpec[],
  cwd: string,
  includeProject: boolean,
  cache: ConfigReadCache,
): HostConfigDiscovery {
  let configured: HostConfigDiscovery = "off";
  for (const source of allSources) {
    if (!supportsHostDiscoverySetting(source, cwd, includeProject)) {
      continue;
    }
    const { config } = cache.readValidated(source.readPath, `MCP config from ${source.readPath}`);
    const value = config?.settings?.hostConfigDiscovery;
    if (value === "off" || value === "on") {
      configured = value;
    }
  }
  return configured;
}

function loadDiscoveredHostLayer(
  cache: ConfigReadCache,
  provenance: Map<string, ServerProvenance> | undefined,
  writePath: string,
): McpConfig {
  let config: McpConfig = { mcpServers: {} };
  for (const importKind of Object.keys(IMPORT_PATHS).filter(isImportKind)) {
    const imported = cache.readImport(
      importKind,
      `Failed to discover imported MCP config from ${importKind}:`,
    );
    if (!imported) {
      continue;
    }
    const importErrors: McpConfigValidationError[] = [];
    const servers = extractServers(imported.value, importKind, imported.path, importErrors);
    if (provenance !== undefined) {
      for (const name of Object.keys(servers)) {
        provenance.set(name, { path: writePath, kind: "import", importKind });
      }
    }
    config = mergeConfigs(config, {
      mcpServers: servers,
      ...(importErrors.length > 0 ? { configErrors: importErrors } : {}),
    });
  }
  return config;
}

function collectReplacedServers(
  replacedServers: ReadonlySet<string> | undefined,
  expanded: McpConfig,
  remainingBaseServers: Set<string>,
): ReadonlySet<string> | undefined {
  if (remainingBaseServers.size === 0) {
    return replacedServers;
  }
  const combined = new Set(replacedServers ?? []);
  for (const [name, entry] of Object.entries(expanded.mcpServers)) {
    if (hasConfiguredTransport(entry) && remainingBaseServers.has(name)) {
      combined.add(name);
      remainingBaseServers.delete(name);
    }
  }
  return combined.size > 0 ? combined : undefined;
}

function mergeLayerWithBase(
  config: McpConfig,
  next: McpConfig,
  replacedServers: ReadonlySet<string> | undefined,
  remainingBaseServers: Set<string>,
): McpConfig {
  const replaceServers = collectReplacedServers(replacedServers, next, remainingBaseServers);
  return mergeConfigs(config, next, replaceServers ? { replaceServers } : undefined);
}

function readCachedSource(
  source: ConfigSourceSpec,
  context: {
    cwd: string;
    cache: ConfigReadCache;
    existingServers: Readonly<Record<string, ServerEntry>>;
    nativePolicies: ReadonlyMap<string, NativeServerPolicy>;
  },
): { loaded: LoadedSourceConfig | null; errors: readonly McpConfigValidationError[] } {
  if (source.id === "native-pi-global" || source.id === "native-pi-project") {
    return readConfigSourceWithDiagnostics(
      source,
      context.cwd,
      context.existingServers,
      context.nativePolicies,
    );
  }
  const { config, errors } = context.cache.readValidated(
    source.readPath,
    `MCP config from ${source.readPath}`,
  );
  if (!config) {
    return { loaded: null, errors };
  }
  return { loaded: applySourceConfigTransforms(source, config, errors), errors };
}

interface LayerAccumulationState {
  config: McpConfig;
  readonly remainingBaseServers: Set<string>;
  readonly provenance: Map<string, ServerProvenance>;
  readonly nativePolicies: Map<string, NativeServerPolicy>;
  readonly loadedSources: LoadedConfigSource[];
  readonly allErrors: McpConfigValidationError[];
  readonly cwd: string;
  readonly includeProject: boolean;
  readonly writePath: string;
  readonly pruneOrphans: boolean;
  readonly collectProvenance: boolean;
  readonly cache: ConfigReadCache;
  readonly readImport: (kind: ImportKind) => CachedImportEntry | null;
}

function applySingleSourceLayer(source: ConfigSourceSpec, acc: LayerAccumulationState): McpConfig {
  const { loaded, errors } = readCachedSource(source, {
    cwd: acc.cwd,
    cache: acc.cache,
    existingServers: acc.config.mcpServers,
    nativePolicies: acc.nativePolicies,
  });
  acc.allErrors.push(...errors);
  acc.loadedSources.push({ source, loaded });
  if (!loaded) {
    return acc.config;
  }
  const expanded = expandImports(loaded.config, acc.cwd, acc.includeProject, acc.readImport);
  acc.allErrors.push(...(expanded.configErrors ?? []));
  updateNativePolicyTracking(acc.nativePolicies, source.id, {
    ...(loaded.nativePolicies ? { loadedPolicies: loaded.nativePolicies } : {}),
    servers: expanded.mcpServers,
    hasTransport: hasConfiguredTransport,
  });
  let nextConfig = mergeLayerWithBase(
    acc.config,
    expanded,
    loaded.replacedServers,
    acc.remainingBaseServers,
  );
  if (acc.pruneOrphans && (source.id === "pi-global" || source.id === "pi-project")) {
    nextConfig = pruneOrphanOverrideEntries(nextConfig);
  }
  if (acc.collectProvenance) {
    addInheritedProvenance(acc.provenance, loaded.config.imports ?? [], {
      userPath: acc.writePath,
      cwd: acc.cwd,
      readImport: acc.readImport,
    });
    addSourceServerProvenance(acc.provenance, source, Object.keys(loaded.config.mcpServers));
  }
  return nextConfig;
}

export interface MergeConfigLayersOptions {
  readonly overridePath?: string | undefined;
  readonly cwd?: string;
  readonly loadOptions?: LoadMcpConfigOptions;
  readonly baseConfig?: McpConfig;
  readonly sourceFilter?: (source: ConfigSourceSpec) => boolean;
  readonly includeHostDiscovery?: boolean;
  readonly pruneOrphans?: boolean;
  readonly collectProvenance?: boolean;
}

export interface MergeConfigLayersResult {
  readonly config: McpConfig;
  readonly allSources: readonly ConfigSourceSpec[];
  readonly loadedSources: LoadedConfigSource[];
  readonly excludedReasons: ReadonlyMap<string, string>;
  readonly provenance: Map<string, ServerProvenance>;
  readonly errors: McpConfigValidationError[];
  readonly hostConfigDiscovery: HostConfigDiscovery;
  readonly cache: ConfigReadCache;
}

function createLayerAccumulation(input: {
  options: MergeConfigLayersOptions;
  cwd: string;
  includeProject: boolean;
  cache: ConfigReadCache;
}): LayerAccumulationState {
  const { options, cwd, includeProject, cache } = input;
  const initialConfig: McpConfig = options.baseConfig
    ? structuredClone(options.baseConfig)
    : { mcpServers: {} };
  const collectProvenance = options.collectProvenance === true;
  const pruneOrphans = options.pruneOrphans !== false;
  const { writePath } = getPiGlobalWriteTarget(options.overridePath, cwd);
  const importVerb = collectProvenance && !pruneOrphans ? "inspect imported" : "import";
  return {
    config: initialConfig,
    remainingBaseServers: new Set(Object.keys(initialConfig.mcpServers)),
    provenance: new Map(),
    nativePolicies: new Map(),
    loadedSources: [],
    allErrors: [...(initialConfig.configErrors ?? [])],
    cwd,
    includeProject,
    writePath,
    pruneOrphans,
    collectProvenance,
    cache,
    readImport: (kind) =>
      cache.readImport(kind, `Failed to ${importVerb} MCP config from ${kind}:`),
  };
}

function applyDiscoveredHostLayerIfEnabled(
  hostConfigDiscovery: HostConfigDiscovery,
  acc: LayerAccumulationState,
): McpConfig {
  if (hostConfigDiscovery !== "on") {
    return acc.config;
  }
  const discovered = loadDiscoveredHostLayer(
    acc.cache,
    acc.collectProvenance ? acc.provenance : undefined,
    acc.writePath,
  );
  acc.allErrors.push(...(discovered.configErrors ?? []));
  return mergeLayerWithBase(acc.config, discovered, undefined, acc.remainingBaseServers);
}

function classifyExcludedSource(
  source: ConfigSourceSpec,
  options: {
    cwd: string;
    includeProject: boolean;
    includeNativePi: boolean;
    includeNativePiProject: boolean;
    sourceFilter: ((source: ConfigSourceSpec) => boolean) | undefined;
  },
): string | undefined {
  if (!options.includeProject && isProjectConfigSource(source, options.cwd)) {
    return "Project is not trusted";
  }
  if (!options.includeNativePi && source.id === "native-pi-global") {
    return "Native Pi user config disabled";
  }
  if (!options.includeNativePiProject && source.id === "native-pi-project") {
    return "Native Pi project config disabled";
  }
  return options.sourceFilter && !options.sourceFilter(source)
    ? "Excluded by host source filter"
    : undefined;
}

function classifyExcludedSources(input: {
  allSources: readonly ConfigSourceSpec[];
  cwd: string;
  loadOptions: LoadMcpConfigOptions;
  sourceFilter: ((source: ConfigSourceSpec) => boolean) | undefined;
}): Map<string, string> {
  const { allSources, cwd, loadOptions, sourceFilter } = input;
  const includeProject = loadOptions.includeProject !== false;
  const includeNativePi = loadOptions.includeNativePi !== false;
  const includeNativePiProject = includeNativePi && loadOptions.includeNativePiProject !== false;
  const excludedReasons = new Map<string, string>();
  for (const source of allSources) {
    const reason = classifyExcludedSource(source, {
      cwd,
      includeProject,
      includeNativePi,
      includeNativePiProject,
      sourceFilter,
    });
    if (reason !== undefined) {
      excludedReasons.set(source.readPath, reason);
    }
  }
  return excludedReasons;
}

export function mergeConfigLayers(options: MergeConfigLayersOptions = {}): MergeConfigLayersResult {
  const cwd = options.cwd ?? process.cwd();
  const loadOptions = options.loadOptions ?? {};
  const includeProject = loadOptions.includeProject !== false;
  const allSources = getConfigSources(options.overridePath, cwd);
  const sourceFilter = options.sourceFilter;
  const excludedReasons = classifyExcludedSources({ allSources, cwd, loadOptions, sourceFilter });
  const filteredSources = getFilteredConfigSources(options.overridePath, cwd, loadOptions).filter(
    (source) => (sourceFilter ? sourceFilter(source) : true),
  );
  const cache = new ConfigReadCache(cwd, includeProject);
  const hostConfigDiscovery =
    options.includeHostDiscovery === false
      ? "off"
      : resolveHostConfigDiscovery(allSources, cwd, includeProject, cache);
  const acc = createLayerAccumulation({ options, cwd, includeProject, cache });
  acc.config = applyDiscoveredHostLayerIfEnabled(hostConfigDiscovery, acc);
  for (const source of filteredSources) {
    acc.config = applySingleSourceLayer(source, acc);
  }
  if (acc.pruneOrphans) {
    acc.config = pruneOrphanOverrideEntries(acc.config);
  }
  const errors = deduplicateConfigErrors(acc.allErrors);
  if (errors.length > 0) {
    acc.config = { ...acc.config, configErrors: errors };
  }
  return {
    config: acc.config,
    allSources,
    loadedSources: acc.loadedSources,
    excludedReasons,
    provenance: acc.provenance,
    errors,
    hostConfigDiscovery,
    cache,
  };
}

export function inspectMcpConfigSnapshot(
  overridePath?: string,
  cwd = process.cwd(),
  options: LoadMcpConfigOptions = {},
  baseConfig?: McpConfig,
): McpConfigSnapshot {
  const merged = mergeConfigLayers({
    overridePath,
    cwd,
    loadOptions: options,
    ...(baseConfig !== undefined ? { baseConfig } : {}),
    collectProvenance: true,
  });
  const includeProject = options.includeProject !== false;
  const imports = buildImportsSummary(merged.cache);
  const discoverySummary = buildDiscoverySummary({
    loadedSources: merged.loadedSources,
    imports,
    hostConfigDiscovery: merged.hostConfigDiscovery,
    cache: merged.cache,
    cwd,
  });
  const { blockedServers, blockedPaths } = inspectBlockedProjectSources(
    merged.allSources,
    cwd,
    includeProject,
    new Set(Object.keys(merged.config.mcpServers)),
  );
  const activeImportKinds = new Set<ImportKind>(
    merged.loadedSources.flatMap((entry) => entry.loaded?.config.imports ?? []),
  );
  return {
    config: merged.config,
    provenance: merged.provenance,
    discoverySummary,
    errors: merged.errors,
    sources: buildSourceReports({
      allSources: merged.allSources,
      loadedSources: merged.loadedSources,
      errors: merged.errors,
      blockedPaths,
      imports,
      excludedReasons: merged.excludedReasons,
      hostConfigDiscovery: merged.hostConfigDiscovery,
      activeImportKinds,
    }),
    blockedServers,
  };
}
