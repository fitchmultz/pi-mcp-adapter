import MiniSearch, { type SearchOptions, type SearchResult } from "minisearch";
import type { McpExtensionState } from "./state.ts";
import {
  type ServerEntry,
  type ToolMetadata,
  type ToolPrefix,
  getServerPrefix,
  isServerDisabled,
  isToolAllowed,
  resolveToolPrefix,
} from "./types.ts";

type ToolCatalog = Readonly<Pick<McpExtensionState, "config" | "toolMetadata">>;

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
  if (schema === null || typeof schema !== "object") {
    return "";
  }
  if (Array.isArray(schema)) {
    return schema.map(schemaSearchText).join(" ");
  }
  return Object.entries(schema)
    .flatMap(([key, value]: [string, unknown]) => schemaEntrySearchText(key, value))
    .join(" ");
}

function isSchemaTextKey(key: string): boolean {
  return key === "description" || key === "title" || key === "const";
}

function schemaEntrySearchText(key: string, value: unknown): string[] {
  if (isSchemaTextKey(key) && typeof value === "string") {
    return [value];
  }
  if (key === "enum" && Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (key === "properties" && value !== null && typeof value === "object") {
    return [Object.keys(value).join(" "), schemaSearchText(value)];
  }
  return [schemaSearchText(value)];
}

interface SearchDocument {
  id: number;
  name: string;
  originalName: string;
  description: string;
  schema: string;
}

type CatalogTool = Pick<RankedToolMatch, "server" | "tool">;

interface CatalogIndex {
  metadata: Map<string, ToolMetadata[]>;
  index: MiniSearch<SearchDocument>;
  documents: Map<number, CatalogTool>;
}

const indexes = new WeakMap<ToolCatalog, CatalogIndex>();

function getIndex(state: ToolCatalog): CatalogIndex {
  const cached = indexes.get(state);
  // Catalog publishers replace each server's metadata array on discovery/reconnect.
  if (
    cached &&
    cached.metadata.size === state.toolMetadata.size &&
    [...state.toolMetadata].every(([server, metadata]) => cached.metadata.get(server) === metadata)
  ) {
    return cached;
  }

  const index = new MiniSearch<SearchDocument>({
    fields: ["name", "originalName", "description", "schema"],
    searchOptions: {
      fields: ["name", "description", "schema"],
      boost: { name: 2, description: 1, schema: 1 },
      prefix: true,
    },
  });
  const documents = new Map<number, CatalogTool>();
  let id = 0;
  for (const [server, tools] of state.toolMetadata) {
    for (const tool of tools) {
      if (tool.resourceUri !== undefined) {
        continue;
      }
      const documentId = id++;
      index.add({
        id: documentId,
        name: normalizeSearchText(tool.name),
        originalName: normalizeSearchText(tool.originalName),
        description: normalizeSearchText([tool.title, tool.description].filter(Boolean).join(" ")),
        schema: normalizeSearchText(schemaSearchText(tool.inputSchema)),
      });
      documents.set(documentId, { server, tool });
    }
  }
  const catalog = { metadata: new Map(state.toolMetadata), index, documents };
  indexes.set(state, catalog);
  return catalog;
}

function storedDocument(documents: CatalogIndex["documents"], result: SearchResult): CatalogTool {
  const id: unknown = result.id;
  const document = typeof id === "number" ? documents.get(id) : undefined;
  if (document === undefined) {
    throw new Error("Search index returned an unknown document");
  }
  return document;
}

function searchCatalog(
  state: ToolCatalog,
  query: string,
  server?: string,
  options?: SearchOptions,
): RankedToolMatch[] {
  const { index, documents } = getIndex(state);
  return index
    .search(normalizeSearchText(query), {
      ...options,
      filter: (result) => {
        const match = storedDocument(documents, result);
        if (server !== undefined && server !== "" && match.server !== server) {
          return false;
        }
        const definition = state.config.mcpServers[match.server];
        if (!definition || isServerDisabled(definition)) {
          return false;
        }
        const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix);
        return isToolAllowed(
          match.tool.originalName,
          match.server,
          prefix,
          definition.includeTools,
          definition.excludeTools,
        );
      },
    })
    .map((result) => {
      const match = storedDocument(documents, result);
      return { server: match.server, tool: match.tool, score: result.score };
    })
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      return scoreDiff === 0 || Number.isNaN(scoreDiff)
        ? a.tool.name.localeCompare(b.tool.name)
        : scoreDiff;
    });
}

export function rankToolMatches(
  state: ToolCatalog,
  query: string,
  server?: string,
): RankedToolMatch[] {
  const matches = searchCatalog(state, query, server);
  const identity = query.trim();
  const exact = ({ tool }: RankedToolMatch) =>
    tool.name === identity || (Boolean(server) && tool.originalName === identity);
  // Stable partition retains MiniSearch order and scores within both groups.
  return [...matches.filter(exact), ...matches.filter((match) => !exact(match))];
}

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)))
    : 1;
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

/** Normalize optional names where an empty string means "unset". */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

interface SuggestionContext {
  explicitServer: string | undefined;
  matchedServer: string | undefined;
  query: string;
  fields: Array<"name" | "originalName">;
}

export function rankSuggestions(
  state: ToolCatalog,
  name: string,
  limit: number,
  server?: string,
): string[] {
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return [];
  }

  const globalPrefix = state.config.settings?.toolPrefix ?? "server";
  const context = buildSuggestionContext(state, name, server, globalPrefix);
  if (context === null) {
    return [];
  }
  const suggestions = searchCatalog(state, context.query, context.matchedServer, {
    fields: context.fields,
    combineWith: "AND",
    fuzzy: 2,
  })
    .slice(0, limit)
    .map((match) => match.tool.name);
  return suggestions.length > 0 || context.explicitServer === undefined
    ? suggestions
    : rankSuggestions(state, name, limit);
}

function buildSuggestionContext(
  state: ToolCatalog,
  name: string,
  server: string | undefined,
  globalPrefix: ToolPrefix,
): SuggestionContext | null {
  const explicitServer = nonEmpty(server);
  const inferred =
    explicitServer === undefined ? inferServerPrefix(state, name, globalPrefix) : undefined;
  const matchedServer = nonEmpty(server ?? inferred?.server);
  const definition =
    matchedServer !== undefined ? state.config.mcpServers[matchedServer] : undefined;
  if (matchedServer !== undefined && (definition === undefined || isServerDisabled(definition))) {
    return null;
  }
  const prefix = resolveSuggestionPrefix(inferred, matchedServer, definition, globalPrefix);
  const query = suggestionQuery(name, prefix);
  return {
    explicitServer,
    matchedServer,
    query,
    fields: [matchedServer !== undefined ? "originalName" : "name"],
  };
}

function resolveSuggestionPrefix(
  inferred: InferredServerPrefix | undefined,
  matchedServer: string | undefined,
  definition: Pick<ServerEntry, "toolPrefix"> | undefined,
  globalPrefix: ToolPrefix,
): string {
  if (inferred !== undefined) {
    return inferred.prefix;
  }
  if (matchedServer === undefined) {
    return "";
  }
  return getServerPrefix(matchedServer, resolveToolPrefix(definition, globalPrefix));
}

function suggestionQuery(name: string, prefix: string): string {
  return prefix !== "" && name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name;
}

interface InferredServerPrefix {
  server: string;
  prefix: string;
}

function inferServerPrefix(
  state: ToolCatalog,
  name: string,
  globalPrefix: ToolPrefix,
): InferredServerPrefix | undefined {
  return Object.entries(state.config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([candidateServer, definition]) => ({
      server: candidateServer,
      prefix: getServerPrefix(candidateServer, resolveToolPrefix(definition, globalPrefix)),
    }))
    .filter((candidate) => candidate.prefix !== "" && name.startsWith(`${candidate.prefix}_`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}
