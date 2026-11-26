import type { McpConfig } from "./config-types.ts";
import type { ServerProvenance } from "./types.ts";
import type {
  KnownServerPreset,
  McpDiscoverySummary,
  LoadMcpConfigOptions,
} from "./config-contracts.ts";
import { inspectMcpConfigSnapshot, mergeConfigLayers } from "./config-snapshot.ts";
export type * from "./config-contracts.ts";
export { inspectMcpConfigSnapshot } from "./config-snapshot.ts";
export {
  getGlobalNativePiConfigPath,
  getPiGlobalConfigPath,
  getPiGlobalWriteTarget,
  getProjectConfigPath,
  getProjectNativePiConfigPath,
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
  options?: Pick<
    LoadMcpConfigOptions,
    "includeNativePi" | "includeNativePiProject" | "includeProject"
  >,
): McpDiscoverySummary {
  return inspectMcpConfigSnapshot(overridePath, cwd, options).discoverySummary;
}

export function cloneMcpConfig(config: McpConfig): McpConfig {
  return structuredClone(config);
}

export function loadMcpConfig(
  overridePath?: string,
  cwd = process.cwd(),
  options: LoadMcpConfigOptions = {},
): McpConfig {
  return loadMcpConfigWithBase(overridePath, cwd, options);
}

/**
 * Load and merge file config layers on top of an optional lower-precedence base (such as
 * `pi.registerMcpServer()` entries), pruning orphan override-only stubs at each scope boundary
 * so stale pins never survive server removal or bleed across unrelated projects.
 */
export function loadMcpConfigWithBase(
  overridePath?: string,
  cwd = process.cwd(),
  options: LoadMcpConfigOptions = {},
  baseConfig?: McpConfig,
): McpConfig {
  return mergeConfigLayers({
    overridePath,
    cwd,
    loadOptions: options,
    ...(baseConfig !== undefined ? { baseConfig } : {}),
  }).config;
}

export { writeProjectServerDisabledOverride } from "./config-disabled.ts";

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
  options?: Pick<
    LoadMcpConfigOptions,
    "includeNativePi" | "includeNativePiProject" | "includeProject"
  >,
): Map<string, ServerProvenance> {
  return mergeConfigLayers({
    overridePath,
    cwd,
    ...(options !== undefined ? { loadOptions: options } : {}),
    pruneOrphans: false,
    collectProvenance: true,
  }).provenance;
}
