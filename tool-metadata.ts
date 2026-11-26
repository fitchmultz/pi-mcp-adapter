import type { McpExtensionState } from "./state.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import { logger } from "./logger.ts";
import {
  type ToolMetadata,
  type McpTool,
  type McpResource,
  type ServerEntry,
  type ToolPrefix,
  disambiguateToolName,
  formatToolName,
  getToolNameCandidates,
  isServerDisabled,
  isServerToolAllowed,
  resolveToolPrefix,
} from "./types.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.ts";

export { formatSchema } from "./schema-format.ts";

/** Natural pre-loader name for catalog-disambiguated ToolMetadata entries so refreshes preserve names and de-collision restores originals. */
const baseToolNames = new WeakMap<ToolMetadata, string>();

export function getBaseToolName(tool: ToolMetadata): string {
  return baseToolNames.get(tool) ?? tool.name;
}

export function applyResolvedToolName(tool: ToolMetadata, resolvedName: string): ToolMetadata {
  if (tool.name === resolvedName) {
    return tool;
  }
  const baseName = getBaseToolName(tool);
  const cloned: ToolMetadata = { ...tool, name: resolvedName };
  const result = Object.isFrozen(tool) ? Object.freeze(cloned) : cloned;
  if (resolvedName !== baseName) {
    baseToolNames.set(result, baseName);
  }
  return result;
}

function collectResolvedOverrides(
  previous: readonly ToolMetadata[] | undefined,
): Map<string, { resolvedName: string; baseName: string }> {
  const byOriginal = new Map<string, { resolvedName: string; baseName: string }>();
  if (!previous) {
    return byOriginal;
  }
  for (const tool of previous) {
    const baseName = (tool.resourceUri ?? "").length > 0 ? undefined : baseToolNames.get(tool);
    if (baseName !== undefined && tool.name !== baseName) {
      byOriginal.set(tool.originalName, { resolvedName: tool.name, baseName });
    }
  }
  return byOriginal;
}

/**
 * Re-apply loader-resolved public names onto freshly rebuilt per-server metadata when the natural
 * base name still matches, so live connects and call refreshes never revert disambiguated names.
 */
export function preserveResolvedToolNames(
  previous: readonly ToolMetadata[] | undefined,
  fresh: ToolMetadata[],
): ToolMetadata[] {
  const byOriginal = collectResolvedOverrides(previous);
  if (byOriginal.size === 0) {
    return fresh;
  }
  const preserved: ToolMetadata[] = [];
  for (const tool of fresh) {
    const entry =
      (tool.resourceUri ?? "").length > 0 ? undefined : byOriginal.get(tool.originalName);
    preserved.push(
      entry !== undefined && entry.baseName === tool.name
        ? applyResolvedToolName(tool, entry.resolvedName)
        : tool,
    );
  }
  return preserved;
}

export function buildToolMetadata({
  tools,
  resources,
  definition,
  serverName,
  prefix,
}: {
  tools: McpTool[];
  resources: McpResource[];
  definition: ServerEntry;
  serverName: string;
  prefix: ToolPrefix;
}): { metadata: ToolMetadata[]; failedTools: string[] } {
  const callable: ToolMetadata[] = [];
  const failedTools: string[] = [];
  if (isServerDisabled(definition)) {
    return { metadata: callable, failedTools };
  }
  const context: MetadataContext = {
    definition,
    serverName,
    prefix: resolveToolPrefix(definition, prefix),
  };
  for (const tool of tools) {
    if (tool.name === "") {
      failedTools.push("(unnamed)");
      continue;
    }
    if (!allowsTool(context, tool.name)) {
      continue;
    }
    const uiVisibility = extractUiToolVisibility(tool._meta);
    if (!isUiToolVisibleToModel(uiVisibility)) {
      continue;
    }
    callable.push(describeTool(tool, context, failedTools, uiVisibility));
  }
  const disambiguatedTools = disambiguateServerTools(callable, serverName);
  if (definition.exposeResources === false) {
    return { metadata: disambiguatedTools, failedTools };
  }
  const taken = new Set(disambiguatedTools.map((tool) => tool.name));
  const disambiguatedResources = disambiguateServerResources(
    resourceMetadata(resources, context),
    serverName,
    taken,
  );
  return { metadata: [...disambiguatedTools, ...disambiguatedResources], failedTools };
}

export function estimateToolTokens(tool: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

interface MetadataContext {
  definition: ServerEntry;
  serverName: string;
  prefix: ToolPrefix;
}

function uniqueHashedName(base: string, identity: string, taken: ReadonlySet<string>): string {
  let candidate = disambiguateToolName(base, identity);
  let suffix = 1;
  while (taken.has(candidate)) {
    candidate = disambiguateToolName(base, `${identity}\0${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function disambiguateServerTools(tools: ToolMetadata[], serverName: string): ToolMetadata[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  const taken = new Set(
    tools.filter((tool) => counts.get(tool.name) === 1).map((tool) => tool.name),
  );
  return tools.map((tool) => {
    if ((counts.get(tool.name) ?? 0) <= 1) {
      return tool;
    }
    const identity = `${serverName}\0${tool.originalName}`;
    const renamed = uniqueHashedName(tool.name, identity, taken);
    taken.add(renamed);
    logger.debug(
      `MCP: disambiguated colliding tool "${tool.originalName}" on ${serverName} (${tool.name} -> ${renamed})`,
    );
    return { ...tool, name: renamed };
  });
}

function disambiguateServerResources(
  resources: ToolMetadata[],
  serverName: string,
  taken: Set<string>,
): ToolMetadata[] {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    counts.set(resource.name, (counts.get(resource.name) ?? 0) + 1);
  }
  return resources.map((resource) => {
    const collides = taken.has(resource.name) || (counts.get(resource.name) ?? 0) > 1;
    if (!collides) {
      taken.add(resource.name);
      return resource;
    }
    const identity = `${serverName}\0resource\0${resource.resourceUri ?? resource.originalName}`;
    const renamed = uniqueHashedName(resource.name, identity, taken);
    taken.add(renamed);
    logger.debug(
      `MCP: disambiguated colliding resource "${resource.originalName}" on ${serverName} (${resource.name} -> ${renamed})`,
    );
    return { ...resource, name: renamed };
  });
}

function describeTool(
  tool: McpTool,
  context: MetadataContext,
  failedTools: string[],
  uiVisibility: ReturnType<typeof extractUiToolVisibility>,
): ToolMetadata {
  const uiResourceUri = readUiResourceUri(tool, failedTools);
  const uiStreamMode = extractToolUiStreamMode(tool._meta);
  return {
    ...tool,
    name: formatToolName(tool.name, context.serverName, context.prefix),
    originalName: tool.name,
    description: tool.description ?? "",
    ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
    ...(uiVisibility !== undefined ? { uiVisibility } : {}),
    ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
  };
}

function allowsTool(context: MetadataContext, name: string): boolean {
  return isServerToolAllowed(name, context.serverName, context.prefix, context.definition);
}

function readUiResourceUri(tool: McpTool, failedTools: string[]): string | undefined {
  try {
    // Read cached MCP Apps metadata without loading the SDK client.
    const uri = asObjectRecord(tool._meta?.ui)?.resourceUri;
    const resourceUri = uri === undefined ? tool._meta?.["ui/resourceUri"] : uri;
    if (typeof resourceUri === "string" && resourceUri.startsWith("ui://")) {
      return resourceUri;
    }
    if (resourceUri !== undefined) {
      failedTools.push(tool.name);
    }
  } catch {
    failedTools.push(tool.name);
  }
  return undefined;
}

export function isUiResourceUri(uri: string): boolean {
  return uri.startsWith("ui://");
}

function resourceMetadata(resources: McpResource[], context: MetadataContext): ToolMetadata[] {
  const metadata: ToolMetadata[] = [];
  for (const resource of resources) {
    if (resource.name === "" || resource.uri === "" || isUiResourceUri(resource.uri)) {
      continue;
    }
    const baseName = `read_${resourceNameToToolName(resource.name)}`;
    metadata.push({
      name: formatToolName(baseName, context.serverName, context.prefix),
      originalName: baseName,
      description: resource.description ?? `Read resource: ${resource.uri}`,
      resourceUri: resource.uri,
      resourceDescriptor: resource,
    });
  }
  return metadata;
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.filter((tool) => tool.resourceUri === undefined).length;
  }
  return count;
}

export function toToolDescriptor(
  server: string,
  tool: ToolMetadata,
): Omit<
  ToolMetadata,
  | "name"
  | "originalName"
  | "resourceUri"
  | "resourceDescriptor"
  | "uiResourceUri"
  | "uiVisibility"
  | "uiStreamMode"
> & { server: string; path: string; name: string } {
  const {
    name: path,
    originalName: name,
    resourceUri: _resourceUri,
    resourceDescriptor: _resourceDescriptor,
    uiResourceUri: _uiResourceUri,
    uiVisibility: _uiVisibility,
    uiStreamMode: _uiStreamMode,
    ...descriptor
  } = tool;
  return { ...descriptor, server, path, name };
}

export function catalogCoverage(
  state: McpExtensionState,
  server?: string,
): {
  complete: boolean;
  knownServers: string[];
  unknownServers: string[];
} {
  const servers = Object.keys(state.config.mcpServers).filter(
    (name) =>
      (server === undefined || server === "" || name === server) &&
      !isServerDisabled(state.config.mcpServers[name]),
  );
  const knownServers = servers.filter((name) => state.toolMetadata.has(name));
  const unknownServers = servers.filter((name) => !state.toolMetadata.has(name));
  return { complete: unknownServers.length === 0, knownServers, unknownServers };
}

export function undiscoveredServersHint(state: McpExtensionState, server?: string): string {
  const { unknownServers } = catalogCoverage(state, server);
  if (unknownServers.length === 0) {
    return "";
  }
  const sorted = [...unknownServers].sort((left, right) => left.localeCompare(right));
  return ` Undiscovered servers: ${sorted.join(", ")}. Use mcp({ action: "connect", server: ${JSON.stringify(sorted[0])} }) to discover one.`;
}

/**
 * Match a tool by exact original name or legacy prefixed alias (`<server>_<tool>`,
 * `<short>_<tool>`, `mcp__<server>__<tool>`, `mcp__<server>_<tool>`) without matching
 * hyphen-swapped bare typos.
 */
export function matchesBackwardCompatibleToolName(
  tool: ToolMetadata,
  serverName: string,
  toolName: string,
  prefix: ToolPrefix,
): boolean {
  if (tool.originalName === toolName) {
    return true;
  }
  if (formatToolName(tool.originalName, serverName, prefix) === toolName) {
    return true;
  }
  if (prefix === "none") {
    return false;
  }
  const normalized = toolName.replace(/-/g, "_");
  if (normalized === tool.originalName.replace(/-/g, "_")) {
    return false;
  }
  return getToolNameCandidates(tool.originalName, serverName, prefix).has(normalized);
}

export function findToolByName(
  metadata: ToolMetadata[] | undefined,
  toolName: string,
): ToolMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const exact = metadata.filter((m) => m.name === toolName);
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : undefined;
  }
  const normalized = toolName.replace(/-/g, "_");
  const matches = metadata.filter((m) => m.name.replace(/-/g, "_") === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "") // Remove leading underscores
    .replace(/_+$/, "") // Remove trailing underscores
    .toLowerCase();

  // Ensure we have a valid name
  if (result === "" || /^\d/.test(result)) {
    result = "resource" + (result !== "" ? "_" + result : "");
  }

  return result;
}
