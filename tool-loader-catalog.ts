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
import { nativeMcpOutputSchema } from "./tool-registrar.ts";
import {
  isServerDisabled,
  type DirectToolSpec,
  type McpAdapterOptions,
  type McpConfig,
  type ToolMetadata,
} from "./types.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";

import type { Selection } from "./tool-loader-snapshots.ts";
export type { Selection } from "./tool-loader-snapshots.ts";
export type CatalogTool = {
  spec: DirectToolSpec;
  source: ToolMetadata;
  selection: Selection;
  name: string;
  pinned: boolean;
};
export type LoaderDependencies = {
  getState: () => McpExtensionState | null;
  getInitPromise: () => Promise<McpExtensionState> | null;
  beforeExecute: McpAdapterOptions["beforeExecute"];
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
      specs.push({
        spec: { ...tool, prefixedName: name, serverName: server },
        source,
        selection: { server, tool: tool.originalName },
        name,
        pinned:
          selection === true || (Array.isArray(selection) && selection.includes(tool.originalName)),
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

export function catalogDefinition(
  spec: DirectToolSpec,
  instructions: string | undefined,
  dependencies: LoaderDependencies,
): ToolDefinition<
  ReturnType<typeof Type.Unsafe<Record<string, unknown>>>,
  Record<string, unknown>
> {
  return {
    name: spec.prefixedName,
    namespace: {
      name: `mcp_${spec.serverName}`,
      ...(instructions !== undefined ? { instructions } : {}),
    },
    ...(spec.outputSchema ? { outputSchema: nativeMcpOutputSchema(spec.outputSchema) } : {}),
    ...(spec.annotations ? { annotations: nativeAnnotations(spec.annotations) } : {}),
    // Inactive direct tools are not callable through codemode or nested execution.
    defaultActive: false,
    ...(dependencies.beforeExecute ? { executionMode: "sequential" } : {}),
    label: spec.title ?? `MCP: ${spec.originalName}`,
    description: spec.description === "" ? "(no description)" : spec.description,
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
