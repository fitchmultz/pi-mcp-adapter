import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDirectToolExecutor, directToolSelection } from "./direct-tools.ts";
import {
  isServerCacheValid,
  reconstructToolMetadata,
  type MetadataCache,
} from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpDirectToolCallRenderer, renderMcpToolResult } from "./tool-result-renderer.ts";
import { nativeMcpOutputSchema } from "./mcp-script-output.ts";
import { logger } from "./logger.ts";
import {
  DEFAULT_TOOL_PREFIX,
  disambiguateToolName,
  isServerDisabled,
  type DirectToolSpec,
  type McpAdapterOptions,
  type McpConfig,
  type ServerEntry,
  type ToolMetadata,
} from "./types.ts";
import { resolveToolExposure } from "./tool-names.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";

export type Selection = { server: string; tool: string };
export type UnpinnedToolExposure = "deferred" | "codemode";
export type CatalogTool = {
  spec: DirectToolSpec;
  source: ToolMetadata;
  selection: Selection;
  name: string;
  pinned: boolean;
  unpinnedExposure: UnpinnedToolExposure;
  description?: string | undefined;
};
export type LoaderDependencies = {
  getState: () => McpExtensionState | null;
  getInitPromise: () => Promise<McpExtensionState> | null;
  beforeExecute?: McpAdapterOptions["beforeExecute"];
  /** Whether the current branch's recorded tool loadout ends with this tool removed. */
  removedOnBranch?: ((name: string) => boolean) | undefined;
};

function serverMetadata(
  server: string,
  config: McpConfig,
  cache: MetadataCache | null,
  state: McpExtensionState | null,
): ToolMetadata[] {
  const live = state?.toolMetadata.get(server);
  if (live !== undefined) {
    return live;
  }
  const definition = config.mcpServers[server];
  const entry = cache?.servers[server];
  if (!definition || !entry || !isServerCacheValid(entry, definition)) {
    return [];
  }
  return reconstructToolMetadata(
    server,
    entry,
    config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX,
    definition,
  );
}

function resolveCatalogToolExposure(
  originalName: string,
  selection: true | string[] | false,
  definition: ServerEntry,
  envActive: boolean,
): { readonly pinned: boolean; readonly unpinnedExposure: UnpinnedToolExposure } {
  const configured = envActive
    ? undefined
    : resolveToolExposure(originalName, definition.toolExposure);
  if (configured === "direct") {
    return { pinned: true, unpinnedExposure: "deferred" };
  }
  if (configured === "codemode") {
    return { pinned: false, unpinnedExposure: "codemode" };
  }
  if (configured === "deferred") {
    return { pinned: false, unpinnedExposure: "deferred" };
  }
  const pinned =
    selection === true || (Array.isArray(selection) && selection.includes(originalName));
  return { pinned, unpinnedExposure: "deferred" };
}

function trimmedDescription(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

function collectServerCatalog(input: {
  server: string;
  definition: ServerEntry;
  tools: readonly ToolMetadata[];
  selection: ReturnType<typeof directToolSelection>;
  envActive: boolean;
  description: string | undefined;
}): CatalogTool[] {
  const { server, definition, tools, selection, envActive, description } = input;
  const specs: CatalogTool[] = [];
  for (const source of tools) {
    const { name, ...tool } = source;
    if (tool.resourceUri !== undefined && tool.resourceUri !== "") {
      continue;
    }
    const exposure = resolveCatalogToolExposure(
      tool.originalName,
      selection,
      definition,
      envActive,
    );
    specs.push({
      spec: { ...tool, prefixedName: name, serverName: server },
      source,
      selection: { server, tool: tool.originalName },
      name,
      ...exposure,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return specs;
}

export function collectCatalog(
  config: McpConfig,
  cache: MetadataCache | null,
  env: string[] | null | undefined,
  getState: LoaderDependencies["getState"],
): CatalogTool[] {
  if (env === null) {
    return [];
  }
  const specs: CatalogTool[] = [];
  for (const [server, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) {
      continue;
    }
    specs.push(
      ...collectServerCatalog({
        server,
        definition,
        tools: serverMetadata(server, config, cache, getState()),
        selection: directToolSelection(config, server, env),
        envActive: env !== undefined,
        description: trimmedDescription(definition.description),
      }),
    );
  }
  return specs;
}

function nativeAnnotations(
  annotations: NonNullable<DirectToolSpec["annotations"]>,
): NonNullable<ToolDefinition["annotations"]> {
  return {
    ...(typeof annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
    ...(typeof annotations.idempotentHint === "boolean"
      ? { idempotentHint: annotations.idempotentHint }
      : {}),
    ...(typeof annotations.openWorldHint === "boolean"
      ? { openWorldHint: annotations.openWorldHint }
      : {}),
  };
}

function catalogDescription(spec: DirectToolSpec): string {
  return spec.description === "" ? "(no description)" : spec.description;
}

function catalogNamespace(
  serverName: string,
  description: string | undefined,
  instructions: string | undefined,
): NonNullable<ToolDefinition["namespace"]> {
  const summary = trimmedDescription(description);
  return {
    name: `mcp_${serverName}`,
    aliases: [serverName],
    ...(summary !== undefined ? { description: summary } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

/**
 * Pinned tools are direct tools that the loader activates itself (see `Loader.activatePins`). Other
 * catalog tools register with deferred exposure: Pi lists them for tool_search and codemode and
 * declares them to the model only once loaded.
 */
export function catalogDefinition(
  spec: DirectToolSpec,
  instructions: string | undefined,
  dependencies: LoaderDependencies,
  options: {
    pinned: boolean;
    unpinnedExposure?: UnpinnedToolExposure;
    description?: string | undefined;
  },
): ToolDefinition<
  ReturnType<typeof Type.Unsafe<Record<string, unknown>>>,
  Record<string, unknown>
> {
  const { pinned, unpinnedExposure = "deferred", description } = options;
  return {
    name: spec.prefixedName,
    namespace: catalogNamespace(spec.serverName, description, instructions),
    outputSchema: nativeMcpOutputSchema(spec.outputSchema),
    ...(spec.annotations ? { annotations: nativeAnnotations(spec.annotations) } : {}),
    ...(pinned ? { defaultActive: false } : { exposure: unpinnedExposure }),
    ...(dependencies.beforeExecute ? { executionMode: "sequential" } : {}),
    label: spec.title ?? `MCP: ${spec.originalName}`,
    description: catalogDescription(spec),
    parameters: Type.Unsafe<Record<string, unknown>>(
      normalizeDirectToolInputSchema(spec.inputSchema),
    ),
    execute: createDirectToolExecutor(
      dependencies.getState,
      dependencies.getInitPromise,
      spec,
      dependencies.beforeExecute,
    ),
    renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
    renderResult: renderMcpToolResult,
  };
}

const RESERVED_TOOL_NAMES = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "mcp",
]);

function uniqueCatalogName(
  item: CatalogTool,
  blocked: ReadonlySet<string>,
  assigned: ReadonlySet<string>,
): string {
  const identity = `${item.selection.server}\0${item.selection.tool}`;
  let candidate = disambiguateToolName(item.name, identity);
  let attempt = 1;
  while (blocked.has(candidate) || assigned.has(candidate)) {
    candidate = disambiguateToolName(item.name, `${identity}\0${attempt}`);
    attempt += 1;
  }
  return candidate;
}

/**
 * Resolve unique, provider-safe catalog names without overwriting reserved or foreign tools.
 * Colliding tools receive deterministic hash suffixes instead of being dropped.
 */
export function resolveCatalogNames(
  specs: readonly CatalogTool[],
  foreignNames: ReadonlySet<string>,
): CatalogTool[] {
  const blocked = new Set<string>([...RESERVED_TOOL_NAMES, ...foreignNames]);
  const counts = new Map<string, number>();
  for (const { name } of specs) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const assigned = new Set<string>(
    specs
      .filter(({ name }) => !blocked.has(name) && counts.get(name) === 1)
      .map(({ name }) => name),
  );
  const resolved: CatalogTool[] = [];
  for (const item of specs) {
    const collides = blocked.has(item.name) || (counts.get(item.name) ?? 0) > 1;
    if (!collides) {
      resolved.push(item);
      continue;
    }
    const renamed = uniqueCatalogName(item, blocked, assigned);
    assigned.add(renamed);
    logger.debug(
      `MCP: disambiguated catalog tool "${item.selection.tool}" on ${item.selection.server} (${item.name} -> ${renamed})`,
    );
    resolved.push({ ...item, name: renamed, spec: { ...item.spec, prefixedName: renamed } });
  }
  return resolved;
}
