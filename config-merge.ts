import { isDeepStrictEqual } from "node:util";
import type { McpConfig, ServerEntry, ImportKind } from "./config-types.ts";
import { loadImportedConfig, extractServers } from "./config-imports.ts";
import { hasServerUrl } from "./utils.ts";

export function hasConfiguredTransport(entry: ServerEntry): boolean {
  return (
    (typeof entry.command === "string" && entry.command.trim() !== "") ||
    hasServerUrl(entry) ||
    (typeof entry.socket === "string" && entry.socket.trim() !== "")
  );
}

/** True for adapter override stubs (such as `{ directTools: true }`) whose backing transport was removed. */
export function isOrphanOverrideEntry(entry: ServerEntry): boolean {
  if (hasConfiguredTransport(entry) || entry.disabled === true) {
    return false;
  }
  const keys = Object.keys(entry);
  return (
    keys.length > 0 &&
    keys.every((key) => key === "directTools" || key === "toolExposure" || key === "disabled")
  );
}

export function pruneOrphanOverrideEntries(config: McpConfig): McpConfig {
  let changed = false;
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (isOrphanOverrideEntry(entry)) {
      changed = true;
      continue;
    }
    mcpServers[name] = entry;
  }
  return changed ? { ...config, mcpServers } : config;
}

export function mergeConfigs(
  base: McpConfig,
  next: McpConfig,
  options?: { readonly replaceServers?: ReadonlySet<string> },
): McpConfig {
  const imports = mergeImports(base.imports, next.imports);
  const settings = next.settings ? { ...base.settings, ...next.settings } : base.settings;
  return {
    mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers, options?.replaceServers),
    ...(imports !== undefined ? { imports } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

// Credential-bearing fields whose value is bound to a specific server `url`.
// When a higher-precedence config source repoints an existing server at a
// different url, these MUST NOT be inherited from the lower-precedence entry —
// otherwise the original endpoint's credentials would be shipped to the new
// url. Explicit replacement credentials are applied after inherited fields are stripped.
const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv"] as const;

function mergeServerMaps(
  base: Record<string, ServerEntry>,
  next: Record<string, ServerEntry>,
  replaceServers?: ReadonlySet<string>,
): Record<string, ServerEntry> {
  const merged = { ...base };
  for (const [name, definition] of Object.entries(next)) {
    if (replaceServers?.has(name) === true) {
      merged[name] = definition;
      continue;
    }
    const existing = merged[name];
    merged[name] = { ...inheritableServerFields(existing, definition), ...definition };
  }
  return merged;
}

// Bind inherited credentials and stdio environment to their original endpoint/program.
function inheritableServerFields(
  existing: ServerEntry | undefined,
  definition: ServerEntry,
): ServerEntry {
  const base = transportBase(existing, definition);
  if (!existing) {
    return base;
  }
  if (
    base.url !== existing.url ||
    (definition.url !== undefined && definition.url !== existing.url)
  ) {
    for (const field of URL_BOUND_AUTH_FIELDS) {
      delete base[field];
    }
    if (base.oauth !== false) {
      delete base.oauth;
    }
  }
  if (
    existing.command !== undefined &&
    existing.command !== "" &&
    stdioProgramChanged(existing, definition)
  ) {
    delete base.env;
  }
  return base;
}

function transportBase(existing: ServerEntry | undefined, definition: ServerEntry): ServerEntry {
  const base: ServerEntry = { ...existing };
  if (existing && typeof definition.socket === "string") {
    for (const field of [
      "command",
      "args",
      "env",
      "cwd",
      "url",
      "headers",
      "auth",
      "bearerToken",
      "bearerTokenEnv",
      "oauth",
    ] as const) {
      delete base[field];
    }
  } else {
    const hasCommand = typeof definition.command === "string" && definition.command !== "";
    if (hasCommand) {
      delete base.url;
    }
    if ((base.socket ?? "") !== "" && (hasCommand || hasServerUrl(definition))) {
      delete base.socket;
    }
  }
  return base;
}

function stdioProgramChanged(existing: ServerEntry, definition: ServerEntry): boolean {
  return (
    (definition.command !== undefined && definition.command !== existing.command) ||
    (definition.args !== undefined && !isDeepStrictEqual(definition.args, existing.args ?? [])) ||
    (definition.cwd !== undefined && definition.cwd !== existing.cwd)
  );
}

function mergeImports(
  left: ImportKind[] | undefined,
  right: ImportKind[] | undefined,
): ImportKind[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  return [...new Set(merged)];
}

export function expandImports(config: McpConfig, cwd: string, includeProject: boolean): McpConfig {
  if (config.imports === undefined || config.imports.length === 0) {
    return config;
  }

  const importedServers: Record<string, ServerEntry> = {};
  for (const importKind of config.imports) {
    const imported = loadImportedConfig(
      importKind,
      cwd,
      `Failed to import MCP config from ${importKind}:`,
      includeProject,
    );
    if (!imported) {
      continue;
    }

    const servers = extractServers(imported.value, importKind);
    for (const [name, definition] of Object.entries(servers)) {
      if (!importedServers[name]) {
        importedServers[name] = definition;
      }
    }
  }

  return {
    imports: config.imports,
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    mcpServers: mergeServerMaps(importedServers, config.mcpServers),
  };
}
