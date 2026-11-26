import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import type { ConfigSourceSpec } from "./config-contracts.ts";
import type { NativeServerPolicy } from "./config-native-pi-exposure.ts";
import {
  readNativePiGlobalConfig,
  readNativePiProjectConfig,
  resolveNativeCwd,
} from "./config-native-pi.ts";
import { isPathInsideProject, IMPORT_PATHS } from "./config-paths.ts";
import { validateConfigWithDiagnostics } from "./config-diagnostics.ts";
import type {
  McpConfig,
  McpConfigValidationError,
  ServerEntry,
  ImportKind,
} from "./config-types.ts";
import type { ServerProvenance } from "./types.ts";
import { isConfigObject, isServerEntry, isImportKind } from "./config-validation.ts";
import { mergeOpenCodeConfigs, mapOpenCodeEntry } from "./config-opencode.ts";

function openCodeProjectPath(cwd: string): string {
  const start = resolve(cwd);
  let current = start;
  let gitRoot: string | undefined;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      gitRoot = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (gitRoot === undefined) {
    return join(start, "opencode.json");
  }
  current = start;
  while (true) {
    const projectConfig = join(current, "opencode.json");
    if (existsSync(projectConfig) || current === gitRoot) {
      return projectConfig;
    }
    current = dirname(current);
  }
}

function resolveImportCandidates(
  importKind: ImportKind,
  cwd: string,
  includeProject: boolean,
): string[] {
  return IMPORT_PATHS[importKind]
    .map((candidate) => {
      if (importKind === "opencode" && candidate === "./opencode.json") {
        return openCodeProjectPath(cwd);
      }
      return candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
    })
    .filter((candidate) => includeProject || !isPathInsideProject(candidate, cwd));
}

export function parseJsonConfig(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw, { trailingCommas: true }));
}
function readImportedConfig(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return path.endsWith(".toml") ? parseToml(raw) : parseJsonConfig(raw);
}

function loadOpenCodeConfig(
  paths: string[],
  warningPrefix: string,
): { path: string; value: unknown } | null {
  let merged: Record<string, unknown> = {};
  let highestPrecedencePath: string | undefined;
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const value = readImportedConfig(path);
      if (isConfigObject(value)) {
        merged = mergeOpenCodeConfigs(merged, value);
        highestPrecedencePath = path;
      }
    } catch (error) {
      console.warn(warningPrefix, error);
    }
  }
  return highestPrecedencePath !== undefined
    ? { path: highestPrecedencePath, value: merged }
    : null;
}

export function loadImportedConfig(
  importKind: ImportKind,
  cwd: string,
  warningPrefix: string,
  includeProject = true,
): { path: string; value: unknown } | null {
  const paths = resolveImportCandidates(importKind, cwd, includeProject);
  if (importKind === "opencode") {
    return loadOpenCodeConfig(paths, warningPrefix);
  }
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      return { path, value: readImportedConfig(path) };
    } catch (error) {
      console.warn(warningPrefix, error);
    }
  }
  return null;
}

export function readValidatedConfigWithDiagnostics(
  path: string,
  label: string,
): { config: McpConfig | null; errors: McpConfigValidationError[] } {
  if (!existsSync(path)) {
    return { config: null, errors: [] };
  }
  try {
    const parsed = parseJsonConfig(readFileSync(path, "utf-8"));
    const { config, errors } = validateConfigWithDiagnostics(parsed, path);
    if (errors.length > 0) {
      const firstError = errors.find((entry) => entry.severity === "error") ?? errors[0];
      console.warn(
        `Config validation issues in ${label}: ${errors.map((entry) => entry.message).join("; ")}`,
        new Error(firstError?.message ?? "Config validation warning"),
      );
    }
    return { config, errors };
  } catch (error) {
    console.warn(`Failed to load ${label}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: null,
      errors: [{ severity: "error", kind: "parse_error", filePath: path, message }],
    };
  }
}

export function readValidatedConfig(path: string, label: string): McpConfig | null {
  return readValidatedConfigWithDiagnostics(path, label).config;
}

export interface LoadedSourceConfig {
  readonly config: McpConfig;
  readonly replacedServers?: ReadonlySet<string>;
  readonly nativePolicies?: ReadonlyMap<string, NativeServerPolicy>;
  readonly errors?: readonly McpConfigValidationError[];
}

export interface ReadConfigSourceResult {
  readonly loaded: LoadedSourceConfig | null;
  readonly errors: readonly McpConfigValidationError[];
}

function projectConfigRoot(source: ConfigSourceSpec): string | undefined {
  if (source.id === "shared-project") {
    return dirname(source.readPath);
  }
  if (source.id === "pi-project") {
    return dirname(dirname(dirname(source.readPath)));
  }
  return undefined;
}

function resolveProjectConfigCwds(config: McpConfig, projectRoot: string): McpConfig {
  let changed = false;
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (typeof entry.cwd === "string" && entry.cwd !== "") {
      const resolved = resolveNativeCwd(entry.cwd, projectRoot);
      if (resolved !== entry.cwd) {
        mcpServers[name] = { ...entry, cwd: resolved };
        changed = true;
        continue;
      }
    }
    mcpServers[name] = entry;
  }
  return changed ? { ...config, mcpServers } : config;
}

export function applySourceConfigTransforms(
  source: ConfigSourceSpec,
  config: McpConfig,
  errors: readonly McpConfigValidationError[],
): LoadedSourceConfig {
  const projectRoot = projectConfigRoot(source);
  const resolved =
    projectRoot !== undefined ? resolveProjectConfigCwds(config, projectRoot) : config;
  return {
    config: resolved,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function readConfigSourceWithDiagnostics(
  source: ConfigSourceSpec,
  cwd: string,
  existingServers?: Readonly<Record<string, ServerEntry>>,
  nativePolicies?: ReadonlyMap<string, NativeServerPolicy>,
): ReadConfigSourceResult {
  if (source.id === "native-pi-global") {
    const loaded = readNativePiGlobalConfig(source.readPath, cwd);
    return { loaded, errors: loaded?.config.configErrors ?? [] };
  }
  if (source.id === "native-pi-project") {
    // Resolve relative stdio `cwd` against the project root owning `.pi/mcp.json`.
    const projectRoot = dirname(dirname(source.readPath));
    const loaded = readNativePiProjectConfig(
      source.readPath,
      projectRoot,
      existingServers,
      nativePolicies,
    );
    return { loaded, errors: loaded?.config.configErrors ?? [] };
  }
  const { config, errors } = readValidatedConfigWithDiagnostics(
    source.readPath,
    `MCP config from ${source.readPath}`,
  );
  if (!config) {
    return { loaded: null, errors };
  }
  return { loaded: applySourceConfigTransforms(source, config, errors), errors };
}

export function readConfigSource(
  source: ConfigSourceSpec,
  cwd: string,
  existingServers?: Readonly<Record<string, ServerEntry>>,
  nativePolicies?: ReadonlyMap<string, NativeServerPolicy>,
): LoadedSourceConfig | null {
  return readConfigSourceWithDiagnostics(source, cwd, existingServers, nativePolicies).loaded;
}

function importedServers(config: Record<string, unknown>, kind: ImportKind): unknown {
  switch (kind) {
    case "claude-desktop":
    case "claude-code":
      return config.mcpServers;
    case "codex":
      return config.mcp_servers ?? config.mcpServers;
    case "cursor":
    case "windsurf":
    case "vscode":
      return config.mcpServers ?? config["mcp-servers"];
    case "opencode":
      return config.mcp;
  }
}

function mapCodexEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const mapped = { ...entry };
  if (typeof mapped.bearer_token_env_var === "string") {
    mapped.bearerTokenEnv = mapped.bearer_token_env_var;
    if (mapped.auth === undefined) {
      mapped.auth = "bearer";
    }
  }
  if (isConfigObject(mapped.http_headers)) {
    mapped.headers = {
      ...(isConfigObject(mapped.headers) ? mapped.headers : {}),
      ...mapped.http_headers,
    };
  }
  if (isConfigObject(mapped.env_http_headers)) {
    const headers = { ...(isConfigObject(mapped.headers) ? mapped.headers : {}) };
    for (const [header, envVar] of Object.entries(mapped.env_http_headers)) {
      if (typeof envVar === "string" && headers[header] === undefined) {
        headers[header] = `$env:${envVar}`;
      }
    }
    mapped.headers = headers;
  }
  delete mapped.bearer_token_env_var;
  delete mapped.http_headers;
  delete mapped.env_http_headers;
  return mapped;
}

export function extractServers(
  config: unknown,
  kind: ImportKind,
  filePath?: string,
  errors?: McpConfigValidationError[],
): Record<string, ServerEntry> {
  if (!isConfigObject(config)) {
    return {};
  }
  const servers = importedServers(config, kind);
  if (!isConfigObject(servers)) {
    return {};
  }
  const mapped: Record<string, ServerEntry> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const entry = kind === "opencode" ? mapOpenCodeEntry(raw) : mapImportedEntry(raw, kind);
    if (entry !== undefined) {
      mapped[name] = entry;
    } else if (errors !== undefined) {
      errors.push({
        severity: "warning",
        kind: "invalid_server",
        filePath: filePath ?? kind,
        serverName: name,
        message: `Skipped invalid ${kind} server entry "${name}"`,
      });
    }
  }
  return mapped;
}

function mapImportedEntry(raw: unknown, kind: ImportKind): ServerEntry | undefined {
  const entry = kind === "codex" && isConfigObject(raw) ? mapCodexEntry(raw) : raw;
  return isServerEntry(entry) ? entry : undefined;
}

export function addDiscoveredHostProvenance(
  provenance: Map<string, ServerProvenance>,
  userPath: string,
  cwd: string,
): void {
  for (const imported of importedServerSources(
    Object.keys(IMPORT_PATHS).filter(isImportKind),
    cwd,
  )) {
    for (const name of imported.names) {
      provenance.set(name, { path: userPath, kind: "import", importKind: imported.importKind });
    }
  }
}

export function addSourceServerProvenance(
  provenance: Map<string, ServerProvenance>,
  source: ConfigSourceSpec,
  serverNames: readonly string[],
): void {
  for (const name of serverNames) {
    provenance.set(name, {
      path: source.writePath,
      kind: source.kind,
      ...(source.importKind !== undefined ? { importKind: source.importKind } : {}),
    });
  }
}

export function* importedServerSources(
  importKinds: ImportKind[],
  cwd: string,
  readImport?: (importKind: ImportKind) => { path: string; value: unknown } | null,
): Generator<{ importKind: ImportKind; path: string; names: string[] }> {
  for (const importKind of importKinds) {
    const imported = readImport
      ? readImport(importKind)
      : loadImportedConfig(
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

export function addInheritedProvenance(
  provenance: Map<string, ServerProvenance>,
  importKinds: ImportKind[],
  target: {
    userPath: string;
    cwd: string;
    readImport?: (importKind: ImportKind) => { path: string; value: unknown } | null;
  },
): void {
  const { userPath, cwd, readImport } = target;
  for (const imported of importedServerSources(importKinds, cwd, readImport)) {
    for (const name of imported.names) {
      if (!provenance.has(name)) {
        provenance.set(name, { path: userPath, kind: "import", importKind: imported.importKind });
      }
    }
  }
}
