import { isConfigObject, isUnknownArray, isStringArray } from "./config-validation.ts";
import type { ServerEntry } from "./config-types.ts";
import { toStringRecord } from "./utils.ts";

function safeOpenCodeBase(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const safe = { ...base };
  if (typeof override.type === "string" && override.type !== safe.type) {
    for (const field of ["command", "environment", "cwd", "url", "headers", "oauth"]) {
      delete safe[field];
    }
  }
  if (typeof override.url === "string" && override.url !== safe.url) {
    delete safe.headers;
    delete safe.oauth;
  }
  if (isUnknownArray(override.command) && commandChanged(safe.command, override.command)) {
    delete safe.environment;
    delete safe.cwd;
  }
  if (Object.hasOwn(override, "cwd") && override.cwd !== safe.cwd) {
    delete safe.environment;
  }
  return safe;
}

function commandChanged(base: unknown, next: unknown[]): boolean {
  return (
    !isUnknownArray(base) ||
    next.length !== base.length ||
    next.some((value, index) => value !== base[index])
  );
}

function mergeOpenCodeEntry(base: unknown, next: unknown): unknown {
  if (!isConfigObject(base) || !isConfigObject(next)) {
    return next;
  }
  const safe = safeOpenCodeBase(base, next);
  const merged = { ...safe, ...next };
  for (const field of ["headers", "oauth"]) {
    const baseField = safe[field];
    const nextField = next[field];
    if (isConfigObject(baseField) && isConfigObject(nextField)) {
      merged[field] = { ...baseField, ...nextField };
    }
  }
  return merged;
}

export function mergeOpenCodeConfigs(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const mergedMcp: Record<string, unknown> = isConfigObject(base.mcp) ? { ...base.mcp } : {};
  if (isConfigObject(next.mcp)) {
    for (const [name, entry] of Object.entries(next.mcp)) {
      mergedMcp[name] = mergeOpenCodeEntry(mergedMcp[name], entry);
    }
  }
  return { ...base, ...next, mcp: mergedMcp };
}

function mapRemoteEntry(raw: Record<string, unknown>, url: string): ServerEntry {
  const headers = toStringRecord(raw.headers);
  const mapped: ServerEntry = { url, ...(headers ? { headers } : {}) };
  if (raw.oauth === false) {
    mapped.oauth = false;
  } else if (isConfigObject(raw.oauth)) {
    const oauth = raw.oauth;
    mapped.auth = "oauth";
    mapped.oauth = {
      ...(typeof oauth.clientId === "string" ? { clientId: oauth.clientId } : {}),
      ...(typeof oauth.clientSecret === "string" ? { clientSecret: oauth.clientSecret } : {}),
      ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
    };
  }
  return mapped;
}

export function mapOpenCodeEntry(raw: unknown): ServerEntry | undefined {
  if (!isConfigObject(raw) || raw.enabled === false) {
    return undefined;
  }
  if (raw.type === "remote" && typeof raw.url === "string") {
    return mapRemoteEntry(raw, raw.url);
  }
  if (raw.type !== "local" || !isStringArray(raw.command)) {
    return undefined;
  }
  const [command] = raw.command;
  if (command === undefined) {
    return undefined;
  }
  const env = toStringRecord(raw.environment);
  return {
    command,
    args: raw.command.slice(1),
    ...(env ? { env } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
  };
}
