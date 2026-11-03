import { resolve } from "node:path";
import type { McpConfig, ServerEntry, ImportKind } from "./config-types.ts";
import type { ServerProvenance } from "./types.ts";
import type { ConfigWritePreview } from "./config-contracts.ts";
import { getPiGlobalConfigPath, getProjectConfigPath } from "./config-paths.ts";
import {
  readRawConfigObject,
  writeRawConfigObject,
  getServersObject,
  withServersObject,
  buildConfigWritePreview,
} from "./config-file.ts";
import { isConfigObject, isUnknownArray } from "./config-validation.ts";

export function previewCompatibilityImports(
  importKinds: ImportKind[],
  overridePath?: string,
): ConfigWritePreview {
  const targetPath = getPiGlobalConfigPath(overridePath);
  const raw = readRawConfigObject(targetPath);
  const currentImports = isUnknownArray(raw.imports)
    ? raw.imports.filter((value): value is string => typeof value === "string")
    : [];
  const merged = [...new Set([...currentImports, ...importKinds])];
  const nextRaw = { ...raw, imports: merged };
  return buildConfigWritePreview(
    targetPath,
    withServersObject(nextRaw, getServersObject(nextRaw, targetPath)),
  );
}

export function ensureCompatibilityImports(
  importKinds: ImportKind[],
  overridePath?: string,
): { path: string; added: ImportKind[] } {
  const targetPath = getPiGlobalConfigPath(overridePath);
  const raw = readRawConfigObject(targetPath);
  const currentImports = isUnknownArray(raw.imports)
    ? raw.imports.filter((value): value is string => typeof value === "string")
    : [];
  const merged = [...new Set([...currentImports, ...importKinds])];
  const added = [...new Set(importKinds)].filter((kind) => !currentImports.includes(kind));
  if (added.length === 0) {
    return { path: targetPath, added: [] };
  }

  raw.imports = merged;
  const servers = getServersObject(raw, targetPath);
  writeRawConfigObject(targetPath, withServersObject(raw, servers));
  return { path: targetPath, added };
}

export function buildStarterProjectConfig(): McpConfig {
  return {
    mcpServers: {},
  };
}

export function previewStarterProjectConfig(cwd = process.cwd()): ConfigWritePreview {
  const targetPath = getProjectConfigPath(cwd);
  const nextRaw = { mcpServers: buildStarterProjectConfig().mcpServers };
  return buildConfigWritePreview(targetPath, nextRaw);
}

export function writeStarterProjectConfig(cwd = process.cwd()): string {
  const targetPath = getProjectConfigPath(cwd);
  const raw = { mcpServers: buildStarterProjectConfig().mcpServers };
  writeRawConfigObject(targetPath, raw);
  return targetPath;
}

export function previewSharedServerEntry(
  filePath: string,
  serverName: string,
  entry: ServerEntry,
): ConfigWritePreview {
  const raw = readRawConfigObject(filePath);
  const nextRaw = { ...raw };
  const servers = getServersObject(nextRaw, filePath);
  servers[serverName] = entry;
  return buildConfigWritePreview(filePath, withServersObject(nextRaw, servers));
}

export function writeSharedServerEntry(
  filePath: string,
  serverName: string,
  entry: ServerEntry,
): string {
  const raw = readRawConfigObject(filePath);
  const servers = getServersObject(raw, filePath);
  servers[serverName] = entry;
  writeRawConfigObject(filePath, withServersObject(raw, servers));
  return filePath;
}

export function writeDirectToolsConfig(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
): void {
  const byPath = new Map<string, { name: string; value: true | string[] | false }[]>();

  for (const [serverName, value] of changes) {
    const prov = provenance.get(serverName);
    if (!prov) {
      continue;
    }

    const targetPath = prov.path;

    const entries = byPath.get(targetPath) ?? [];
    entries.push({ name: serverName, value });
    byPath.set(targetPath, entries);
  }

  for (const [filePath, entries] of byPath) {
    const raw = readRawConfigObject(filePath);
    const servers = getServersObject(raw, filePath);

    for (const { name, value } of entries) {
      // Keep inherited connection details in their source file.
      const existing = servers[name];
      if (existing !== undefined && !isConfigObject(existing)) {
        throw new Error(`Invalid MCP config at ${filePath}: server "${name}" must be an object`);
      }
      servers[name] = { ...existing, directTools: value };
    }

    writeRawConfigObject(filePath, withServersObject(raw, servers));
  }
}

export function resolveConfiguredOAuthDir(raw: unknown, cwd = process.cwd()): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("settings.oauthDir must be a string");
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  return resolve(cwd, trimmed);
}
