import { hash } from "node:crypto";
import { isUnknownArray } from "./config-validation.ts";
import type { NativeToolExposure, ServerEntry, ToolPrefix } from "./config-types.ts";

/** Default tool prefix aligned with Pi's built-in MCP naming (`mcp__<server>__<tool>`). */
export const DEFAULT_TOOL_PREFIX: ToolPrefix = "mcp";

/** OpenAI, Anthropic, and Gemini enforce a 64-character maximum on provider tool names. */
export const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;

/** Eight hex chars (32 bits of SHA-256) keep truncated and disambiguated names compact and deterministic. */
const TOOL_NAME_HASH_LENGTH = 8;

function sanitizeServerSegment(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_]/g, "_");
}

function sanitizeToolSegment(toolName: string): string {
  const sanitized = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized !== "" ? sanitized : "tool";
}

function shortIdentityHash(identity: string): string {
  return hash("sha256", identity, "hex").slice(0, TOOL_NAME_HASH_LENGTH);
}

/**
 * Append a deterministic hash suffix while enforcing the 64-character provider tool-name limit.
 */
export function disambiguateToolName(
  formattedName: string,
  identity: string,
  maxLength = MAX_PROVIDER_TOOL_NAME_LENGTH,
): string {
  const safeBase = formattedName.replace(/[^A-Za-z0-9_-]/g, "_");
  const digest = shortIdentityHash(identity);
  const headLength = Math.max(1, maxLength - digest.length - 1);
  return `${safeBase.slice(0, headLength)}_${digest}`;
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") {
    return "";
  }
  if (mode === "short") {
    const short = sanitizeServerSegment(serverName.replace(/-?mcp$/i, ""));
    return short !== "" ? short : "mcp";
  }
  if (mode === "mcp") {
    return `mcp__${sanitizeServerSegment(serverName)}`;
  }
  return sanitizeServerSegment(serverName);
}

/**
 * Separator placed between `getServerPrefix(serverName, mode)` and the sanitized tool name.
 */
export function getToolPrefixDelimiter(mode: ToolPrefix): string {
  if (mode === "none") {
    return "";
  }
  return mode === "mcp" ? "__" : "_";
}

/**
 * Full prefix string preceding the tool name (including its trailing `_` or `__` separator).
 */
export function getServerToolPrefix(serverName: string, mode: ToolPrefix): string {
  const prefix = getServerPrefix(serverName, mode);
  return prefix !== "" ? `${prefix}${getToolPrefixDelimiter(mode)}` : "";
}

/**
 * Format a provider-safe tool name (`[A-Za-z0-9_-]`, max 64 chars) with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const head = getServerToolPrefix(serverName, prefix);
  const sanitized = sanitizeToolSegment(toolName);
  const candidate = head !== "" ? `${head}${sanitized}` : sanitized;
  if (candidate.length <= MAX_PROVIDER_TOOL_NAME_LENGTH) {
    return candidate;
  }
  return disambiguateToolName(candidate, `${serverName}\0${toolName}`);
}

export function resolveToolPrefix(
  definition?: Pick<ServerEntry, "toolPrefix">,
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? DEFAULT_TOOL_PREFIX;
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
  const serverPart =
    prefix === "short" ? getServerPrefix(serverName, "short") : sanitizeServerSegment(serverName);
  return `mcp__${serverPart !== "" ? serverPart : "server"}__${sanitizePromptName(promptName)}`;
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

function legacySingleUnderscoreMcpName(toolName: string, serverName: string): string {
  const raw = `mcp__${sanitizeServerSegment(serverName)}_${sanitizeToolSegment(toolName)}`;
  return raw.length <= MAX_PROVIDER_TOOL_NAME_LENGTH
    ? raw
    : disambiguateToolName(raw, `${serverName}\0${toolName}`);
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
    normalizeToolName(legacySingleUnderscoreMcpName(toolName, serverName)),
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

function matchesNativeExposurePattern(pattern: string, toolName: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

export function resolveToolExposure(
  toolName: string,
  toolExposure?: Readonly<Record<string, NativeToolExposure>>,
): NativeToolExposure | undefined {
  if (!toolExposure) {
    return undefined;
  }
  const exact = toolExposure[toolName];
  if (exact !== undefined) {
    return exact;
  }
  for (const [pattern, exposure] of Object.entries(toolExposure)) {
    if (pattern.includes("*") && matchesNativeExposurePattern(pattern, toolName)) {
      return exposure;
    }
  }
  return undefined;
}

export function hasDirectToolExposure(
  toolExposure?: Readonly<Record<string, NativeToolExposure>>,
): boolean {
  return toolExposure !== undefined && Object.values(toolExposure).includes("direct");
}

export function isToolAllowedByExposure(
  toolName: string,
  toolExposure?: Readonly<Record<string, NativeToolExposure>>,
): boolean {
  return resolveToolExposure(toolName, toolExposure) !== "hidden";
}

export function isServerToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  definition: Pick<ServerEntry, "includeTools" | "excludeTools" | "toolExposure">,
): boolean {
  return (
    isToolAllowed(toolName, serverName, prefix, definition.includeTools, definition.excludeTools) &&
    isToolAllowedByExposure(toolName, definition.toolExposure)
  );
}
