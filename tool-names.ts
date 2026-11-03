import { isUnknownArray } from "./config-validation.ts";
import type { ServerEntry, ToolPrefix } from "./config-types.ts";

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") {
    return "";
  }
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (short === "") {
      short = "mcp";
    }
    return short;
  }
  if (mode === "mcp") {
    return `mcp__${serverName.replace(/-/g, "_")}`;
  }
  return serverName.replace(/-/g, "_");
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const p = getServerPrefix(serverName, prefix);
  const sanitized = toolName.replace(/\./g, "_");
  return p !== "" ? `${p}_${sanitized}` : sanitized;
}

export function resolveToolPrefix(
  definition?: Pick<ServerEntry, "toolPrefix">,
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? "server";
}

export function sanitizePromptName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  if (cleaned === "") {
    return "prompt";
  }
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function formatPromptCommandName(
  promptName: string,
  serverName: string,
  prefix: ToolPrefix,
): string {
  const configuredPrefix = getServerPrefix(serverName, prefix);
  const serverPart = configuredPrefix !== "" ? configuredPrefix : serverName.replace(/-/g, "_");
  return `mcp__${serverPart !== "" ? serverPart : "server"}__${sanitizePromptName(promptName)}`;
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

export function getToolNameCandidates(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
): Set<string> {
  return new Set<string>([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
    normalizeToolName(formatToolName(toolName, serverName, "mcp")),
  ]);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean {
  if (!isUnknownArray(patterns) || patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      continue;
    }
    const normalized = normalizeToolName(pattern);
    const isGlob = normalized.includes("*") || normalized.includes("?");
    if (!isGlob && candidates.has(normalized)) {
      return true;
    }
    if (isGlob && [...candidates].some((candidate) => globToRegExp(normalized).test(candidate))) {
      return true;
    }
  }

  return false;
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
): boolean {
  if (!isUnknownArray(includeTools) || includeTools.length === 0) {
    return true;
  }
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), includeTools);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools?: unknown,
): boolean {
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), excludeTools);
}

// oxlint-disable-next-line eslint/max-params -- QX-022: retain the published five-position filtering API.
export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
): boolean {
  return (
    isToolIncluded(toolName, serverName, prefix, includeTools) &&
    !isToolExcluded(toolName, serverName, prefix, excludeTools)
  );
}
