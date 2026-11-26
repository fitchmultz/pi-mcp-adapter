import type {
  McpConfig,
  McpPanelCallbacks,
  McpPanelConnectionStatus,
  ServerEntry,
  ServerProvenance,
  ToolPrefix,
} from "./types.ts";
import {
  reconstructToolMetadata,
  type MetadataCache,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { estimateToolTokens } from "./tool-metadata.ts";
import { matchesFuzzy } from "./mcp-panel-text.ts";

/** The panel adds its local reconnect transition to the reported connection status. */
type ConnectionStatus = McpPanelConnectionStatus | "connecting";

export interface ToolState {
  name: string;
  description: string;
  isDirect: boolean;
  wasDirect: boolean;
  estimatedTokens: number;
}

export interface ServerState {
  name: string;
  expanded: boolean;
  source: "user" | "project" | "import";
  importKind?: string;
  definition: ServerEntry;
  toolFilter: true | string[] | false;
  resourceCount: number;
  connectionStatus: ConnectionStatus;
  failureMessage?: string | null;
  tools: ToolState[];
  hasCachedData: boolean;
}

export interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

export class PanelServer {
  readonly data: ServerState;
  private readonly prefix: ToolPrefix;
  constructor(data: ServerState, prefix: ToolPrefix) {
    this.data = data;
    this.prefix = prefix;
  }
  setConnectionStatus(status: ConnectionStatus): void {
    this.data.connectionStatus = status;
  }
  refreshConnection(callbacks: McpPanelCallbacks): void {
    this.data.connectionStatus = callbacks.getConnectionStatus(this.data.name);
    this.data.failureMessage = callbacks.getFailureMessage?.(this.data.name) ?? null;
  }
  rebuildTools(entry: ServerCacheEntry): void {
    const existingState = new Map(this.data.tools.map((tool) => [tool.name, tool]));
    const metadata = reconstructToolMetadata(
      this.data.name,
      entry,
      this.prefix,
      this.data.definition,
    );
    this.data.resourceCount = metadata.filter((tool) => tool.resourceUri !== undefined).length;
    this.data.tools = metadata
      .filter((tool) => tool.resourceUri === undefined)
      .map((tool) => {
        const previous = existingState.get(tool.originalName);
        const pinned =
          this.data.toolFilter === true ||
          (Array.isArray(this.data.toolFilter) && this.data.toolFilter.includes(tool.originalName));
        return {
          name: tool.originalName,
          description: tool.description,
          isDirect: previous?.isDirect ?? pinned,
          wasDirect: previous?.wasDirect ?? pinned,
          estimatedTokens: estimateToolTokens(tool),
        };
      });
    this.data.hasCachedData = true;
  }
}
interface PanelServersInput {
  config: McpConfig;
  cache: MetadataCache | null;
  provenance: Map<string, ServerProvenance>;
  callbacks: McpPanelCallbacks;
  authOnly: boolean;
}

function panelServerDefaults(
  config: McpConfig,
  definition: ServerEntry,
): { toolFilter: ServerState["toolFilter"]; prefix: ToolPrefix } {
  return {
    toolFilter: definition.directTools ?? config.settings?.directTools ?? false,
    prefix: config.settings?.toolPrefix ?? "server",
  };
}

function createPanelServer(
  input: PanelServersInput,
  name: string,
  definition: ServerEntry,
): PanelServer {
  const provenance = input.provenance.get(name);
  const cache = input.cache?.servers[name];
  const defaults = panelServerDefaults(input.config, definition);
  return new PanelServer(
    {
      name,
      expanded: false,
      source: provenance?.kind ?? "user",
      ...(provenance?.importKind !== undefined ? { importKind: provenance.importKind } : {}),
      definition,
      toolFilter: defaults.toolFilter,
      resourceCount: 0,
      connectionStatus: input.callbacks.getConnectionStatus(name),
      failureMessage: input.callbacks.getFailureMessage?.(name) ?? null,
      tools: [],
      hasCachedData: Boolean(cache),
    },
    defaults.prefix,
  );
}

export function buildPanelServers(input: PanelServersInput): PanelServer[] {
  const servers: PanelServer[] = [];
  for (const [name, definition] of Object.entries(input.config.mcpServers)) {
    if (input.authOnly && !input.callbacks.canAuthenticate(name)) {
      continue;
    }
    const server = createPanelServer(input, name, definition);
    servers.push(server);
    const cache = input.cache?.servers[name];
    if (cache && !input.authOnly) {
      server.rebuildTools(cache);
    }
  }
  return servers;
}

interface PanelQuery {
  text: string;
  mode: "name" | "desc";
}

function matchesTool(tool: ToolState, serverName: string, query: PanelQuery): boolean {
  if (query.text.length === 0) {
    return true;
  }
  return query.mode === "name"
    ? matchesFuzzy(query.text, tool.name) || matchesFuzzy(query.text, serverName)
    : matchesFuzzy(query.text, tool.description);
}

function getServerItems(
  server: ServerState,
  serverIndex: number,
  query: PanelQuery,
  authOnly: boolean,
): VisibleItem[] {
  if (query.text.length > 0 && authOnly) {
    return query.mode === "name" && matchesFuzzy(query.text, server.name)
      ? [{ type: "server", serverIndex }]
      : [];
  }
  const items: VisibleItem[] = [{ type: "server", serverIndex }];
  if (server.expanded || query.text.length > 0) {
    server.tools.forEach((tool, toolIndex) => {
      if (matchesTool(tool, server.name, query)) {
        items.push({ type: "tool", serverIndex, toolIndex });
      }
    });
  }
  return items;
}

function serverMatchesSearchWithoutTools(server: ServerState, query: PanelQuery): boolean {
  const keepsWithoutMatchingTools =
    !server.hasCachedData ||
    server.connectionStatus === "failed" ||
    server.connectionStatus === "needs-auth" ||
    server.connectionStatus === "blocked";
  if (!keepsWithoutMatchingTools) {
    return false;
  }
  if (query.mode === "name") {
    return matchesFuzzy(query.text, server.name);
  }
  const extra = [server.definition.description ?? "", server.failureMessage ?? ""].join(" ");
  return matchesFuzzy(query.text, server.name) || matchesFuzzy(query.text, extra);
}

export function buildVisibleItems(input: {
  servers: readonly PanelServer[];
  descSearchActive: boolean;
  descQuery: string;
  nameQuery: string;
  authOnly: boolean;
}): VisibleItem[] {
  const query: PanelQuery = {
    text: input.descSearchActive ? input.descQuery : input.nameQuery,
    mode: input.descSearchActive ? "desc" : "name",
  };
  const items = input.servers.flatMap((server, index) =>
    getServerItems(server.data, index, query, input.authOnly),
  );
  if (query.text.length === 0 || input.authOnly) {
    return items;
  }
  const matchingServers = new Set(
    items.filter((item) => item.type === "tool").map((item) => item.serverIndex),
  );
  return items.filter((item) => {
    if (item.type !== "server") {
      return true;
    }
    if (matchingServers.has(item.serverIndex)) {
      return true;
    }
    const server = input.servers[item.serverIndex];
    return server !== undefined && serverMatchesSearchWithoutTools(server.data, query);
  });
}
