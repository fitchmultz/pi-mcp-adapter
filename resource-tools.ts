import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import {
  isServerDisabled,
  isToolAllowed,
  resolveToolPrefix,
  type McpOperationContext,
  type McpToolCallIdentity,
  type ToolMetadata,
  type ServerEntry,
  type McpResource,
} from "./types.ts";
import { executeCall, prepareMcpConnection } from "./proxy-modes.ts";
import { paginate } from "./search-ranking.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";

export async function executeResourceList(
  state: McpExtensionState,
  {
    server,
    limit = 12,
    offset = 0,
    signal,
  }: {
    server: string;
    limit?: number | undefined;
    offset?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<AgentToolResult<Record<string, unknown>>> {
  throwIfAborted(combineAbortSignals(state.owner.signal, signal));
  const definition = state.config.mcpServers[server];
  if (!definition || isServerDisabled(definition)) {
    return unavailableResourceList(server, definition !== undefined);
  }
  if (needsResourceDiscovery(state, server)) {
    const prepared = await prepareMcpConnection(state, server, signal);
    if (prepared.error) {
      return prepared.error;
    }
  }
  const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix);
  const page = paginate(
    listAllowedResources(state.toolMetadata.get(server) ?? [], { definition, server, prefix }),
    offset,
    limit,
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ server, ...page }, null, 2) }],
    details: { mode: "resources", server, ...page },
  };
}

function needsResourceDiscovery(state: McpExtensionState, server: string): boolean {
  return (
    !state.toolMetadata.has(server) || state.manager.getConnection(server)?.status === "connected"
  );
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

function listAllowedResources(
  tools: ToolMetadata[],
  context: {
    definition: ServerEntry;
    server: string;
    prefix: ReturnType<typeof resolveToolPrefix>;
  },
): Array<Pick<McpResource, "uri" | "description">> {
  const { definition, server, prefix } = context;
  if (definition.exposeResources === false) {
    return [];
  }
  return tools.flatMap((tool) => {
    if (
      tool.resourceUri === undefined ||
      !isToolAllowed(
        tool.originalName,
        server,
        prefix,
        definition.includeTools,
        definition.excludeTools,
      )
    ) {
      return [];
    }
    return [tool.resourceDescriptor ?? { uri: tool.resourceUri, description: tool.description }];
  });
}

export async function executeResourceRead(
  state: McpExtensionState,
  {
    server,
    uri,
    signal,
    identity = {},
    beforeDispatch,
    raw = false,
  }: {
    server: string;
    uri: string;
    signal?: AbortSignal | undefined;
    identity?: McpToolCallIdentity | undefined;
    beforeDispatch?:
      | ((signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>)
      | undefined;
    raw?: boolean | undefined;
  },
): ReturnType<typeof executeCall> {
  return executeCall(state, {
    toolName: uri,
    args: {},
    serverOverride: server,
    signal,
    identity,
    beforeDispatch,
    options: {
      resourceUri: uri,
      raw,
    },
  });
}
