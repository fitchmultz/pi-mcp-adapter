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
import {
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
    config.settings?.toolPrefix ?? "server",
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
    const selection = directToolSelection(config, server, env);
    for (const source of serverMetadata(server, config, cache, getState())) {
      const { name, ...tool } = source;
      if (tool.resourceUri !== undefined && tool.resourceUri !== "") {
        continue;
      }
      const exposure = resolveCatalogToolExposure(
        tool.originalName,
        selection,
        definition,
        env !== undefined,
      );
      specs.push({
        spec: { ...tool, prefixedName: name, serverName: server },
        source,
        selection: { server, tool: tool.originalName },
        name,
        ...exposure,
      });
    }
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

function catalogDescription(spec: DirectToolSpec, gatewayAvailable: boolean): string {
  const description = spec.description === "" ? "(no description)" : spec.description;
  if (spec.outputSchema) {
    return description;
  }
  if (!gatewayAvailable) {
    return `${description}\n\nCodemode: Returns display text (50 KiB by default), not raw JSON.`;
  }
  const call = `tools.mcp({ action: "call", server: ${JSON.stringify(spec.serverName)}, tool: ${JSON.stringify(spec.originalName)}, args, format: "structured" })`;
  return `${description}\n\nCodemode: Returns display text (50 KiB by default), not raw JSON. For structured or large data, use \`${call}\`. For saved JSON, join structured \`read-result\` pages' \`.text\` before parsing.`;
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
    gatewayAvailable: boolean;
  },
): ToolDefinition<
  ReturnType<typeof Type.Unsafe<Record<string, unknown>>>,
  Record<string, unknown>
> {
  const { pinned, unpinnedExposure = "deferred", gatewayAvailable } = options;
  return {
    name: spec.prefixedName,
    namespace: {
      name: `mcp_${spec.serverName}`,
      ...(instructions !== undefined ? { instructions } : {}),
    },
    ...(spec.outputSchema ? { outputSchema: nativeMcpOutputSchema(spec.outputSchema) } : {}),
    ...(spec.annotations ? { annotations: nativeAnnotations(spec.annotations) } : {}),
    ...(pinned ? { defaultActive: false } : { exposure: unpinnedExposure }),
    ...(dependencies.beforeExecute ? { executionMode: "sequential" } : {}),
    label: spec.title ?? `MCP: ${spec.originalName}`,
    description: catalogDescription(spec, gatewayAvailable),
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
