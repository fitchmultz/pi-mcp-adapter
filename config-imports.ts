import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { isPathInsideProject, IMPORT_PATHS } from "./config-paths.ts";
import { validateUnknownServerProtocolConfig } from "./config-protocol.ts";
import type { McpConfig, ServerEntry, ImportKind } from "./config-types.ts";
import {
  isConfigObject,
  isUnknownArray,
  isServerEntry,
  isMcpSettings,
  isImportKind,
} from "./config-validation.ts";
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

export function readValidatedConfig(path: string, label: string): McpConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return validateConfig(parseJsonConfig(readFileSync(path, "utf-8")));
  } catch (error) {
    console.warn(`Failed to load ${label}:`, error);
    return null;
  }
}

function validateServerMap(raw: Record<string, unknown>): Record<string, ServerEntry> {
  const servers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(raw)) {
    validateUnknownServerProtocolConfig(entry);
    if (!isServerEntry(entry)) {
      throw new Error(`Invalid MCP server configuration: ${name}`);
    }
    servers[name] = entry;
  }
  return servers;
}

function normalizeLegacySettings(raw: unknown): unknown {
  return isConfigObject(raw) && raw.hostConfigDiscovery === "prompt"
    ? { ...raw, hostConfigDiscovery: "off" }
    : raw;
}

function validateConfig(raw: unknown): McpConfig {
  if (!isConfigObject(raw)) {
    return { mcpServers: {} };
  }
  const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!isConfigObject(servers)) {
    return { mcpServers: {} };
  }
  const rawSettings = raw.settings;
  const settings = normalizeLegacySettings(rawSettings);
  if (settings !== undefined && !isMcpSettings(settings)) {
    throw new Error("Invalid MCP settings");
  }
  return {
    mcpServers: validateServerMap(servers),
    ...(isUnknownArray(raw.imports) ? { imports: raw.imports.filter(isImportKind) } : {}),
    ...(isMcpSettings(settings) ? { settings } : {}),
  };
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

export function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
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
    }
  }
  return mapped;
}

function mapImportedEntry(raw: unknown, kind: ImportKind): ServerEntry | undefined {
  const entry = kind === "codex" && isConfigObject(raw) ? mapCodexEntry(raw) : raw;
  return isServerEntry(entry) ? entry : undefined;
}
