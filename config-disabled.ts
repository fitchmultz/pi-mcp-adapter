import { existsSync, readFileSync } from "node:fs";
import type { McpConfig } from "./config-types.ts";
import type { ServerDisabledOverrideResult } from "./config-contracts.ts";
import { isServerDisabled } from "./config-protocol.ts";
import { isConfigObject, isUnknownArray, isImportKind } from "./config-validation.ts";
import { getProjectPiConfigPath, getConfigSources } from "./config-paths.ts";
import { parseJsonConfig, readValidatedConfig } from "./config-imports.ts";
import { mergeConfigs, expandImports } from "./config-merge.ts";
import { withConfigWrite, writeRawConfigObject, getServersKey } from "./config-file.ts";

function readProjectOverride(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = parseJsonConfig(readFileSync(filePath, "utf-8"));
    if (!isConfigObject(parsed)) {
      throw new Error("root value must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to read project MCP override at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function lowerPrecedenceConfig(
  overridePath: string | undefined,
  cwd: string,
  raw: Record<string, unknown>,
): McpConfig {
  const filePath = getProjectPiConfigPath(cwd);
  let lower: McpConfig = { mcpServers: {} };
  for (const source of getConfigSources(overridePath, cwd)) {
    if (source.readPath === filePath) {
      continue;
    }
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (loaded) {
      lower = mergeConfigs(lower, expandImports(loaded, cwd, true));
    }
  }
  if (raw.imports === undefined) {
    return lower;
  }
  if (!isUnknownArray(raw.imports) || !raw.imports.every(isImportKind)) {
    throw new Error(
      `Failed to update project MCP override at ${filePath}: imports contains an unsupported config kind`,
    );
  }
  return mergeConfigs(lower, expandImports({ mcpServers: {}, imports: raw.imports }, cwd, true));
}

function nextEnabledOverride(
  existing: Record<string, unknown> | undefined,
  inheritedDisabled: boolean,
): Record<string, unknown> {
  const next = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"),
  );
  if (inheritedDisabled) {
    next.disabled = false;
  }
  return next;
}

function projectServerOverrides(
  raw: Record<string, unknown>,
  filePath: string,
): Record<string, unknown> {
  const serverKey = getServersKey(raw);
  const rawServers = raw[serverKey];
  if (rawServers === undefined) {
    return {};
  }
  if (!isConfigObject(rawServers)) {
    throw new Error(
      `Failed to update project MCP override at ${filePath}: ${serverKey} must be an object`,
    );
  }
  return rawServers;
}

/** Persist only the local disabled field; inherited definitions and credentials remain in their source. */
export function writeProjectServerDisabledOverride(
  overridePath: string | undefined,
  cwd: string,
  serverName: string,
  disabled: boolean,
): ServerDisabledOverrideResult {
  const filePath = getProjectPiConfigPath(cwd);
  return withConfigWrite(filePath, () =>
    updateProjectServerDisabledOverride(overridePath, cwd, serverName, disabled),
  );
}

function updateProjectServerDisabledOverride(
  overridePath: string | undefined,
  cwd: string,
  serverName: string,
  disabled: boolean,
): ServerDisabledOverrideResult {
  const filePath = getProjectPiConfigPath(cwd);
  const raw = readProjectOverride(filePath);
  const serverKey = getServersKey(raw);
  const servers = projectServerOverrides(raw, filePath);
  const existing = servers[serverName];
  if (existing !== undefined && !isConfigObject(existing)) {
    throw new Error(
      `Failed to update project MCP override at ${filePath}: server "${serverName}" must be an object`,
    );
  }
  const next = disabled
    ? { ...existing, disabled: true }
    : nextEnabledOverride(
        existing,
        isServerDisabled(lowerPrecedenceConfig(overridePath, cwd, raw).mcpServers[serverName]),
      );
  if (
    (existing === undefined && Object.keys(next).length === 0) ||
    JSON.stringify(existing) === JSON.stringify(next)
  ) {
    return { path: filePath, changed: false };
  }
  if (Object.keys(next).length === 0) {
    delete servers[serverName];
  } else {
    servers[serverName] = next;
  }
  raw[serverKey] = servers;
  writeRawConfigObject(filePath, raw);
  return { path: filePath, changed: true };
}
