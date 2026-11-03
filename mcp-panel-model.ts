import type {
  McpConfig,
  McpPanelCallbacks,
  ServerEntry,
  ServerProvenance,
  ToolPrefix,
} from "./types.ts";
import {
  reconstructToolMetadata,
  type MetadataCache,
  type ServerCacheEntry,
  type CachedTool,
} from "./metadata-cache.ts";
import { fuzzyScore } from "./mcp-panel-text.ts";
function estimateTokens(tool: CachedTool): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

type ConnectionStatus = ReturnType<McpPanelCallbacks["getConnectionStatus"]> | "connecting";

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
          estimatedTokens: estimateTokens(tool),
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
  const score =
    query.mode === "name"
      ? Math.max(fuzzyScore(query.text, tool.name), fuzzyScore(query.text, serverName) * 0.6)
      : fuzzyScore(query.text, tool.description);
  return score > 0;
}

function getServerItems(
  server: ServerState,
  serverIndex: number,
  query: PanelQuery,
  authOnly: boolean,
): VisibleItem[] {
  if (query.text.length > 0 && authOnly) {
    return query.mode === "name" && fuzzyScore(query.text, server.name) > 0
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
  return items.filter((item) => item.type !== "server" || matchingServers.has(item.serverIndex));
}
