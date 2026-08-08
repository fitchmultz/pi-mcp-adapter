import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { getServerPrefix, isServerDisabled, resolveToolPrefix } from "./types.ts";

/**
 * Shortest field token allowed to stem-match a longer query token.
 * Real descriptions tokenize possessives into single letters ("project's" -> ["project", "s"]),
 * which would otherwise make every query starting with that letter a match.
 */
const MIN_STEM_LENGTH = 4;
export const MAX_PAGE_SIZE = 100;
export const MAX_TOOL_NAME_LENGTH = 512;

const FIELD_WEIGHTS = {
  name: 12,
  originalName: 10,
  server: 8,
  description: 5,
} as const;

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

export function tokenize(value: string): string[] {
  return normalizeSearchText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

export function scoreToolMatch(tool: ToolMetadata, server: string, query: string): number | null {
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;

  const fields = {
    name: normalizeSearchText(tool.name),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(server),
    description: normalizeSearchText(tool.description),
  };
  let score = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, value] of Object.entries(fields) as Array<[keyof typeof FIELD_WEIGHTS, string]>) {
    const weight = FIELD_WEIGHTS[field];
    const fieldTokens = tokenize(value);
    if (value === normalizedQuery) {
      score += weight * 14;
      phraseMatched = true;
      wholeFieldExact = true;
    } else if (value.startsWith(normalizedQuery)) {
      score += weight * 9;
      phraseMatched = true;
    } else if (value.includes(normalizedQuery)) {
      score += weight * 6;
      phraseMatched = true;
    }

    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        score += weight * 4;
        matchedTokens.add(token);
      } else if (fieldTokens.some(fieldToken => fieldToken.startsWith(token) || (fieldToken.length >= MIN_STEM_LENGTH && token.startsWith(fieldToken)))) {
        score += weight * 2;
        matchedTokens.add(token);
      } else if (value.includes(token)) {
        score += weight;
        matchedTokens.add(token);
      }
    }
  }

  const coverage = matchedTokens.size / queryTokens.length;
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null;

  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  const firstQueryToken = queryTokens[0];
  if (firstQueryToken !== undefined && tokenize(fields.name).includes(firstQueryToken)) score += 8;
  if (wholeFieldExact) score += 20;
  return score;
}

export function rankToolMatches(state: McpExtensionState, query: string, server?: string): RankedToolMatch[] {
  const matches: RankedToolMatch[] = [];
  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    if (isServerDisabled(state.config.mcpServers[serverName])) continue;
    for (const tool of metadata) {
      const score = scoreToolMatch(tool, serverName, query);
      if (score !== null) matches.push({ server: serverName, tool, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
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

function editDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      rowMin = Math.min(rowMin, current[j]!);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length]!;
}

function rankClosest(tools: ToolMetadata[], query: string, limit: number, candidateName: (tool: ToolMetadata) => string): string[] {
  const normalizedQuery = normalizeSearchText(query).replace(/\s+/g, "_");
  const maxDistance = Math.max(2, Math.floor(normalizedQuery.length * 0.2));
  return tools
    .map(tool => ({
      tool,
      distance: editDistance(normalizedQuery, normalizeSearchText(candidateName(tool)).replace(/\s+/g, "_"), maxDistance),
    }))
    .filter(({ distance }) => distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => tool.name);
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
  if (!matchedServer) {
    const tools = [...state.toolMetadata.entries()]
      .filter(([candidateServer]) => !isServerDisabled(state.config.mcpServers[candidateServer]))
      .flatMap(([, metadata]) => metadata);
    const closest = rankClosest(tools, name, limit, tool => tool.name);
    return closest.length > 0 ? closest : rankToolMatches(state, name).slice(0, limit).map(match => match.tool.name);
  }

  const definition = state.config.mcpServers[matchedServer];
  if (!definition || isServerDisabled(definition)) return [];
  const prefix = inferred?.prefix ?? getServerPrefix(matchedServer, resolveToolPrefix(definition, globalPrefix));
  const query = prefix && name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name;
  const tools = state.toolMetadata.get(matchedServer) ?? [];
  const closest = rankClosest(tools, query, limit, tool => tool.originalName);
  if (closest.length > 0) return closest;

  const queryTokens = tokenize(query);
  return rankToolMatches(state, query, matchedServer)
    .filter(({ tool }) => {
      const candidateTokens = tokenize(tool.originalName);
      return queryTokens.every(token => candidateTokens.some(candidate =>
        candidate === token
        || candidate.startsWith(token)
        || (candidate.length >= MIN_STEM_LENGTH && token.startsWith(candidate))));
    })
    .slice(0, limit)
    .map(match => match.tool.name);
}
