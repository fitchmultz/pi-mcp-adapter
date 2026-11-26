import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { ProxyToolUpdateCallback } from "./proxy-result.ts";
import {
  isServerDisabled,
  type McpOperationContext,
  type McpToolCallIdentity,
  type McpResource,
  type McpResourceTemplate,
} from "./types.ts";
import { executeCall, prepareMcpConnection } from "./proxy-modes.ts";
import { paginate } from "./search-ranking.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { isUiResourceUri } from "./tool-metadata.ts";
import {
  applyServerMetadata,
  notifyToolMetadataUpdated,
  updateMetadataCache,
} from "./init-metadata.ts";
import type { ServerConnection } from "./server-manager.ts";

export async function executeResourceList(
  state: McpExtensionState,
  {
    server,
    limit = 12,
    offset = 0,
    signal,
    onUpdate,
  }: {
    server: string;
    limit?: number | undefined;
    offset?: number | undefined;
    signal?: AbortSignal | undefined;
    onUpdate?: ProxyToolUpdateCallback | undefined;
  },
): Promise<AgentToolResult<Record<string, unknown>>> {
  throwIfAborted(combineAbortSignals(state.owner.signal, signal));
  const definition = state.config.mcpServers[server];
  if (!definition || isServerDisabled(definition)) {
    return unavailableResourceList(server, definition !== undefined);
  }
  if (definition.exposeResources === false) {
    const empty = { ...paginate<McpResource>([], offset, limit), resourceTemplates: [] };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ server, ...empty }, null, 2) }],
      details: { mode: "resources", server, ...empty },
    };
  }
  if (needsResourceDiscovery(state, server)) {
    const prepared = await prepareMcpConnection(state, server, signal, onUpdate);
    if (prepared.error) {
      return prepared.error;
    }
    await refreshStaleResourceTemplates(state, server, signal);
  }
  const page = paginate(listExposedResources(state, server), offset, limit);
  const resourceTemplates = listExposedResourceTemplates(state, server);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ server, ...page, resourceTemplates }, null, 2),
      },
    ],
    details: { mode: "resources", server, ...page, resourceTemplates },
  };
}

function needsResourceDiscovery(state: McpExtensionState, server: string): boolean {
  return (
    !state.toolMetadata.has(server) || state.manager.getConnection(server)?.status === "connected"
  );
}

const METHOD_NOT_FOUND_CODE: number = ProtocolErrorCode.MethodNotFound;

function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === METHOD_NOT_FOUND_CODE;
}

function applyRefreshedResourceTemplates(
  state: McpExtensionState,
  server: string,
  connection: ServerConnection,
  templates: McpResourceTemplate[],
): void {
  const current = state.manager.getConnection(server);
  if (current === connection && current.status === "connected") {
    const hadPendingResources = current.pendingResources !== undefined;
    if (current.pendingResources !== undefined) {
      current.resources = current.pendingResources;
      current.pendingResources = undefined;
    }
    current.resourceTemplates = templates;
    current.resourceTemplatesStale = false;
    const definition = state.config.mcpServers[server];
    if (definition) {
      applyServerMetadata(state, { serverName: server, connection: current, definition });
    } else {
      state.resourceTemplates.set(
        server,
        templates.filter((template) => !isUiResourceUri(template.uriTemplate)),
      );
    }
    updateMetadataCache(state, server, { preserveEmptyResources: false });
    if (hadPendingResources) {
      notifyToolMetadataUpdated(state, server, "resources-list-changed");
    }
  }
}

async function refreshStaleResourceTemplates(
  state: McpExtensionState,
  server: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const connection = state.manager.getConnection(server);
  if (connection?.status !== "connected" || connection.resourceTemplatesStale !== true) {
    return;
  }
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  const options = state.manager.getRequestOptions(server, ownedSignal);
  try {
    const result = await connection.client.listResourceTemplates(undefined, {
      ...options,
      cacheMode: "refresh",
    });
    applyRefreshedResourceTemplates(state, server, connection, result.resourceTemplates);
  } catch (error) {
    if (ownedSignal?.aborted === true) {
      throwIfAborted(ownedSignal);
    }
    // Keep resourceTemplatesStale=true on transient errors so the next list retries;
    // on MethodNotFound clear any previously advertised templates and update the cache.
    if (isMethodNotFoundError(error)) {
      applyRefreshedResourceTemplates(state, server, connection, []);
    }
  }
}

function unavailableResourceList(
  server: string,
  configured: boolean,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      {
        type: "text",
        text: `Server "${server}" is ${configured ? "disabled" : "not configured"}.`,
      },
    ],
    details: {
      mode: "resources",
      server,
      error: configured ? "server_disabled" : "server_not_found",
    },
  };
}

function listExposedResources(
  state: McpExtensionState,
  server: string,
): Array<Pick<McpResource, "uri" | "description">> {
  const connection = state.manager.getConnection(server);
  if (connection?.status === "connected") {
    return connection.resources.filter(
      (resource) => resource.name !== "" && resource.uri !== "" && !isUiResourceUri(resource.uri),
    );
  }
  const tools = state.toolMetadata.get(server) ?? [];
  return tools.flatMap((tool) => {
    if (tool.resourceUri === undefined || isUiResourceUri(tool.resourceUri)) {
      return [];
    }
    return [tool.resourceDescriptor ?? { uri: tool.resourceUri, description: tool.description }];
  });
}

function listExposedResourceTemplates(
  state: McpExtensionState,
  server: string,
): McpResourceTemplate[] {
  const connection = state.manager.getConnection(server);
  const templates =
    connection?.status === "connected"
      ? (connection.resourceTemplates ?? [])
      : (state.resourceTemplates.get(server) ?? []);
  return templates.filter(
    (template) =>
      template.name !== "" && template.uriTemplate !== "" && !isUiResourceUri(template.uriTemplate),
  );
}

export async function executeResourceRead(
  state: McpExtensionState,
  {
    server,
    uri,
    signal,
    onUpdate,
    identity = {},
    beforeDispatch,
  }: {
    server: string;
    uri: string;
    signal?: AbortSignal | undefined;
    onUpdate?: ProxyToolUpdateCallback | undefined;
    identity?: McpToolCallIdentity | undefined;
    beforeDispatch?:
      | ((signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>)
      | undefined;
  },
): ReturnType<typeof executeCall> {
  return executeCall(state, {
    toolName: uri,
    args: {},
    serverOverride: server,
    signal,
    onUpdate,
    identity,
    beforeDispatch,
    options: { resourceUri: uri },
  });
}
