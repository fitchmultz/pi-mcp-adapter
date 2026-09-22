import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, isToolAllowed, resolveToolPrefix, type McpOperationContext, type McpToolCallIdentity } from "./types.ts";
import { executeCall, prepareMcpConnection } from "./proxy-modes.ts";
import { paginate } from "./search-ranking.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";

export async function executeResourceList(state: McpExtensionState, server: string, limit = 12, offset = 0, signal?: AbortSignal) {
  throwIfAborted(combineAbortSignals(state.owner?.signal, signal));
  const definition = state.config.mcpServers[server];
  if (!definition || isServerDisabled(definition)) {
    return { content: [{ type: "text" as const, text: `Server "${server}" is ${definition ? "disabled" : "not configured"}.` }], details: { mode: "resources", server, error: definition ? "server_disabled" : "server_not_found" } };
  }
  if (!state.toolMetadata.has(server) || state.manager.getConnection(server)?.status === "connected") {
    const prepared = await prepareMcpConnection(state, server, signal);
    if (prepared.error) return prepared.error;
  }
  const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix);
  const page = paginate((state.toolMetadata.get(server) ?? [])
    .filter(tool => tool.resourceUri !== undefined && definition.exposeResources !== false
      && isToolAllowed(tool.originalName, server, prefix, definition.includeTools, definition.excludeTools))
    .map(tool => tool.resourceDescriptor ?? { uri: tool.resourceUri!, description: tool.description }), offset, limit);
  return { content: [{ type: "text" as const, text: JSON.stringify({ server, ...page }, null, 2) }], details: { mode: "resources", server, ...page } };
}

export async function executeResourceRead(
  state: McpExtensionState,
  server: string,
  uri: string,
  signal?: AbortSignal,
  identity: McpToolCallIdentity = {},
  beforeDispatch?: (signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>,
  raw = false,
) {
  return executeCall(state, uri, {}, server, undefined, signal, identity, beforeDispatch, { resourceUri: uri, raw });
}

export function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")  // Remove leading underscores
    .replace(/_+$/, "")  // Remove trailing underscores
    .toLowerCase();
  
  // Ensure we have a valid name
  if (!result || /^\d/.test(result)) {
    result = "resource" + (result ? "_" + result : "");
  }
  
  return result;
}
