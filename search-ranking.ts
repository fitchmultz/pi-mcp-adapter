import MiniSearch, { type SearchOptions, type SearchResult } from "minisearch";
import type { McpExtensionState } from "./state.ts";
import {
  DEFAULT_TOOL_PREFIX,
  type ServerEntry,
  type ToolMetadata,
  type ToolPrefix,
  getServerToolPrefix,
  isServerDisabled,
  isServerToolAllowed,
  resolveToolPrefix,
} from "./types.ts";

type ToolCatalog = Readonly<Pick<McpExtensionState, "config" | "toolMetadata">>;

export const MAX_PAGE_SIZE = 100;
export const MAX_TOOL_NAME_LENGTH = 512;

/** Minimum stemmed term length for edit-distance fuzziness so short tokens avoid noisy matches. */
const MIN_FUZZY_TERM_LENGTH = 4;

/** MiniSearch edit-distance factor (1 typo on 4-7 char terms, 2 typos on >=8 char terms). */
const SEARCH_FUZZY_FACTOR = 0.2;

/** Minimum length for stripping trailing "ies"/"es" plural forms without mangling short roots. */
const MIN_ES_STEM_LENGTH = 5;

/** Minimum length for stripping a trailing singular "s" without mangling short identifiers. */
const MIN_S_STEM_LENGTH = 4;

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

/** Lightweight plural-to-singular stemmer mirroring Pi's built-in tool_search ranker. */
function stemTerm(term: string): string {
  const lower = term.toLowerCase();
  if (lower.length >= MIN_ES_STEM_LENGTH && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length >= MIN_ES_STEM_LENGTH && /(?:ches|shes|sses|xes|zes)$/.test(lower)) {
    return lower.slice(0, -2);
  }
  if (
    lower.length >= MIN_S_STEM_LENGTH &&
    lower.endsWith("s") &&
    !lower.endsWith("ss") &&
    !lower.endsWith("us") &&
    !lower.endsWith("is")
  ) {
    return lower.slice(0, -1);
  }
  return lower;
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
  serverName: string;
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
    fields: ["serverName", "name", "originalName", "description", "schema"],
    processTerm: stemTerm,
    searchOptions: {
      fields: ["serverName", "name", "description", "schema"],
      boost: { name: 2, serverName: 1.5, description: 1, schema: 1 },
      prefix: true,
      fuzzy: (term) => (term.length >= MIN_FUZZY_TERM_LENGTH ? SEARCH_FUZZY_FACTOR : false),
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
        serverName: normalizeSearchText(server),
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
        return isServerToolAllowed(match.tool.originalName, match.server, prefix, definition);
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
  matchedServer: string | undefined;
  query: string;
  fields: Array<"name" | "originalName">;
}

/** Proportional suggestion fuzziness: exact on <=3 chars, 1 edit on 4-6 chars, up to 2 edits on 7+ chars. */
const SUGGESTION_FUZZY_ONE_MIN_LENGTH = 4;
/** Longer tool tokens tolerate two edits (e.g., transpositions like "datadgo" -> "datadog"). */
const SUGGESTION_FUZZY_TWO_MIN_LENGTH = 7;

function suggestionFuzzy(term: string): number | false {
  if (term.length >= SUGGESTION_FUZZY_TWO_MIN_LENGTH) {
    return 2;
  }
  return term.length >= SUGGESTION_FUZZY_ONE_MIN_LENGTH ? 1 : false;
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

  const globalPrefix = state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX;
  const context = buildSuggestionContext(state, name, server, globalPrefix);
  if (context === null) {
    return [];
  }
  const strict = searchCatalog(state, context.query, context.matchedServer, {
    fields: context.fields,
    combineWith: "AND",
    fuzzy: suggestionFuzzy,
  });
  if (strict.length > 0) {
    return strict.slice(0, limit).map((match) => match.tool.name);
  }
  return searchCatalog(state, context.query, context.matchedServer, {
    fields: context.fields,
    combineWith: "OR",
    fuzzy: suggestionFuzzy,
  })
    .slice(0, limit)
    .map((match) => match.tool.name);
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
  const matchedServer = nonEmpty(explicitServer ?? inferred?.server);
  const definition =
    matchedServer !== undefined ? state.config.mcpServers[matchedServer] : undefined;
  if (matchedServer !== undefined && (definition === undefined || isServerDisabled(definition))) {
    return null;
  }
  const prefixHead = resolveSuggestionPrefixHead(inferred, matchedServer, definition, globalPrefix);
  const query = suggestionQuery(name, prefixHead);
  return {
    matchedServer,
    query,
    fields: [matchedServer !== undefined ? "originalName" : "name"],
  };
}

function resolveSuggestionPrefixHead(
  inferred: InferredServerPrefix | undefined,
  matchedServer: string | undefined,
  definition: Pick<ServerEntry, "toolPrefix"> | undefined,
  globalPrefix: ToolPrefix,
): string {
  if (inferred !== undefined) {
    return inferred.prefixHead;
  }
  if (matchedServer === undefined) {
    return "";
  }
  return getServerToolPrefix(matchedServer, resolveToolPrefix(definition, globalPrefix));
}

function suggestionQuery(name: string, prefixHead: string): string {
  return prefixHead !== "" && name.startsWith(prefixHead) ? name.slice(prefixHead.length) : name;
}

interface InferredServerPrefix {
  server: string;
  prefixHead: string;
}

function candidatePrefixHeads(
  server: string,
  definition: Pick<ServerEntry, "toolPrefix">,
  globalPrefix: ToolPrefix,
): string[] {
  const activeMode = resolveToolPrefix(definition, globalPrefix);
  const activeHead = getServerToolPrefix(server, activeMode);
  const heads = activeHead !== "" ? [activeHead] : [];
  if (activeMode === "mcp") {
    const legacyServer = getServerToolPrefix(server, "server");
    const legacySingleMcp = `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}_`;
    heads.push(legacySingleMcp);
    if (legacyServer !== "") {
      heads.push(legacyServer);
    }
  }
  return heads;
}

function inferServerPrefix(
  state: ToolCatalog,
  name: string,
  globalPrefix: ToolPrefix,
): InferredServerPrefix | undefined {
  return Object.entries(state.config.mcpServers)
    .flatMap(([candidateServer, definition]) =>
      candidatePrefixHeads(candidateServer, definition, globalPrefix).map((prefixHead) => ({
        server: candidateServer,
        prefixHead,
      })),
    )
    .filter((candidate) => candidate.prefixHead !== "" && name.startsWith(candidate.prefixHead))
    .sort((a, b) => b.prefixHead.length - a.prefixHead.length)[0];
}
