import MiniSearch, { type SearchOptions } from "minisearch";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { getServerPrefix, isServerDisabled, isToolAllowed, resolveToolPrefix } from "./types.ts";

export const MAX_PAGE_SIZE = 100;
export const MAX_TOOL_NAME_LENGTH = 512;

export interface RankedToolMatch {
  server: string;
  tool: ToolMetadata;
  score: number;
}

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

function schemaSearchText(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema)) return schema.map(schemaSearchText).join(" ");
  return Object.entries(schema).flatMap(([key, value]) => {
    if ((key === "description" || key === "title" || key === "const") && typeof value === "string") return value;
    if (key === "enum" && Array.isArray(value)) return value.filter(item => typeof item === "string");
    if (key === "properties" && value && typeof value === "object") return [Object.keys(value).join(" "), schemaSearchText(value)];
    return schemaSearchText(value);
  }).join(" ");
}

interface SearchDocument {
  id: number;
  server: string;
  tool: ToolMetadata;
  name: string;
  originalName: string;
  description: string;
  schema: string;
}

const indexes = new WeakMap<McpExtensionState, {
  metadata: Map<string, ToolMetadata[]>;
  index: MiniSearch<SearchDocument>;
}>();

function getIndex(state: McpExtensionState): MiniSearch<SearchDocument> {
  const cached = indexes.get(state);
  // Catalog publishers replace each server's metadata array on discovery/reconnect.
  if (cached && cached.metadata.size === state.toolMetadata.size
    && [...state.toolMetadata].every(([server, metadata]) => cached.metadata.get(server) === metadata)) {
    return cached.index;
  }

  const index = new MiniSearch<SearchDocument>({
    fields: ["name", "originalName", "description", "schema"],
    storeFields: ["server", "tool"],
    searchOptions: { fields: ["name", "description", "schema"], boost: { name: 2, description: 1, schema: 1 }, prefix: true },
  });
  let id = 0;
  for (const [server, tools] of state.toolMetadata) {
    for (const tool of tools) {
      if (tool.resourceUri !== undefined) continue;
      index.add({
        id: id++, server, tool,
        name: normalizeSearchText(tool.name),
        originalName: normalizeSearchText(tool.originalName),
        description: normalizeSearchText([tool.title, tool.description].filter(Boolean).join(" ")),
        schema: normalizeSearchText(schemaSearchText(tool.inputSchema)),
      });
    }
  }
  indexes.set(state, { metadata: new Map(state.toolMetadata), index });
  return index;
}

function searchCatalog(state: McpExtensionState, query: string, server?: string, options?: SearchOptions): RankedToolMatch[] {
  return getIndex(state).search(normalizeSearchText(query), {
    ...options,
    filter: result => {
      if (server && result.server !== server) return false;
      const definition = state.config.mcpServers[result.server];
      if (!definition || isServerDisabled(definition)) return false;
      const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix);
      return isToolAllowed(result.tool.originalName, result.server, prefix, definition.includeTools, definition.excludeTools);
    },
  }).map(({ server, tool, score }) => ({ server, tool, score }))
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
}

export function rankToolMatches(state: McpExtensionState, query: string, server?: string): RankedToolMatch[] {
  const matches = searchCatalog(state, query, server);
  const identity = query.trim();
  const exact = ({ tool }: RankedToolMatch) => tool.name === identity || (server !== undefined && tool.originalName === identity);
  // Stable partition retains MiniSearch order and scores within both groups.
  return [...matches.filter(exact), ...matches.filter(match => !exact(match))];
}

export function paginate<T>(items: T[], offset: number, limit: number): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit))) : 1;
  const total = items.length;
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length;
  return {
    items: page,
    total,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export function rankSuggestions(state: McpExtensionState, name: string, limit: number, server?: string): string[] {
  if (name.length > MAX_TOOL_NAME_LENGTH) return [];

  const globalPrefix = state.config.settings?.toolPrefix ?? "server";
  const inferred = server ? undefined : Object.entries(state.config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([candidateServer, definition]) => ({
      server: candidateServer,
      prefix: getServerPrefix(candidateServer, resolveToolPrefix(definition, globalPrefix)),
    }))
    .filter((candidate): candidate is { server: string; prefix: string } =>
      Boolean(candidate.prefix) && name.startsWith(`${candidate.prefix}_`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const matchedServer = server ?? inferred?.server;
  const definition = matchedServer ? state.config.mcpServers[matchedServer] : undefined;
  if (matchedServer && (!definition || isServerDisabled(definition))) return [];
  const prefix = inferred?.prefix ?? (matchedServer ? getServerPrefix(matchedServer, resolveToolPrefix(definition, globalPrefix)) : "");
  const query = prefix && name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name;
  const suggestions = searchCatalog(state, query, matchedServer, {
    fields: [matchedServer ? "originalName" : "name"], combineWith: "AND", fuzzy: 2,
  }).slice(0, limit).map(match => match.tool.name);
  return suggestions.length > 0 || !server ? suggestions : rankSuggestions(state, name, limit);
}
