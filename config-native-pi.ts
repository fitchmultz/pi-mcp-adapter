import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
import type { McpConfig, ServerEntry } from "./config-types.ts";
import { isConfigObject, isStringArray, isStringRecord } from "./config-validation.ts";
import {
  mapNativeOAuth,
  warnNativeEntry,
  warnNativeEntryFalse,
  warnNativeField,
  type NativeEntryContext,
} from "./config-native-pi-oauth.ts";

export interface LoadedNativePiConfig {
  readonly config: McpConfig;
  readonly replacedServers: ReadonlySet<string>;
}

type NativeExposure = "codemode" | "deferred" | "direct" | "hidden";

interface NativeBaseFields {
  readonly enabled?: boolean;
  readonly timeout?: number;
  readonly exposure?: NativeExposure;
  readonly toolExposure?: Record<string, NativeExposure>;
}

const NATIVE_OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);
const ENV_REF_PREFIX = /^(?:\$\{\w+\}|\$env:\w+|\{env:\w+\})/;

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  return value.startsWith("~/") || value.startsWith("~\\")
    ? join(homedir(), value.slice(2))
    : value;
}

function resolveNativeCwd(value: string, projectCwd: string): string {
  const expanded = expandHomePath(value);
  return isAbsolute(expanded) || ENV_REF_PREFIX.test(expanded)
    ? expanded
    : resolve(projectCwd, expanded);
}

function resolveExposure(value: unknown): NativeExposure | undefined {
  if (value === "codemode-deferred") {
    return "codemode";
  }
  return value === "codemode" || value === "deferred" || value === "direct" || value === "hidden"
    ? value
    : undefined;
}

function parseToolExposure(raw: unknown): Record<string, NativeExposure> | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isConfigObject(raw)) {
    return null;
  }
  const result: Record<string, NativeExposure> = {};
  for (const [tool, value] of Object.entries(raw)) {
    const resolved = resolveExposure(value);
    if (resolved === undefined) {
      return null;
    }
    result[tool] = resolved;
  }
  return result;
}

function validateScalarBaseFields(raw: Record<string, unknown>, ctx: NativeEntryContext): boolean {
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return warnNativeEntryFalse(ctx, "enabled must be a boolean");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return warnNativeEntryFalse(ctx, "description must be a string");
  }
  const { timeout } = raw;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    return warnNativeEntryFalse(ctx, "timeout must be a positive number of seconds");
  }
  return true;
}

function parseBaseFields(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
): NativeBaseFields | null {
  if (!validateScalarBaseFields(raw, ctx)) {
    return null;
  }
  const exposure = raw.exposure === undefined ? undefined : resolveExposure(raw.exposure);
  if (raw.exposure !== undefined && exposure === undefined) {
    return warnNativeEntry(ctx, "unsupported exposure value");
  }
  const toolExposure = parseToolExposure(raw.toolExposure);
  if (toolExposure === null) {
    return warnNativeEntry(ctx, "toolExposure must map tool names to valid exposures");
  }
  return {
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
    ...(exposure !== undefined ? { exposure } : {}),
    ...(toolExposure !== undefined ? { toolExposure } : {}),
  };
}

function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  if (/\$\{\w+\}|\$env:\w+|\{env:\w+\}/.test(trimmed)) {
    return /^https?:\/\//i.test(trimmed);
  }
  if (!URL.canParse(trimmed)) {
    return false;
  }
  const { protocol } = new URL(trimmed);
  return protocol === "http:" || protocol === "https:";
}

function collectExactDirectNames(keys: readonly string[], ctx: NativeEntryContext): string[] {
  const exact = keys.filter((key) => !key.includes("*"));
  const globs = keys.filter((key) => key.includes("*"));
  if (globs.length > 0) {
    warnNativeField(
      ctx,
      `wildcard direct toolExposure (${globs.join(", ")}) cannot pin tools in Fitch MCP Adapter`,
    );
  }
  return exact;
}

function matchesNativeToolPattern(pattern: string, toolName: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

function hasUnrepresentableToolExposure(entries: ReadonlyArray<[string, NativeExposure]>): boolean {
  const hiddenPatterns = entries
    .filter(([key, exp]) => exp === "hidden" && key.includes("*"))
    .map(([key]) => key);
  const exactVisible = entries
    .filter(([key, exp]) => exp !== "hidden" && !key.includes("*"))
    .map(([key]) => key);
  if (
    hiddenPatterns.some((pattern) =>
      exactVisible.some((name) => matchesNativeToolPattern(pattern, name)),
    )
  ) {
    return true;
  }
  let seenVisiblePattern = false;
  for (const [key, exp] of entries) {
    if (!key.includes("*")) {
      continue;
    }
    if (exp !== "hidden") {
      seenVisiblePattern = true;
    } else if (seenVisiblePattern) {
      return true;
    }
  }
  return false;
}

function hiddenExposureFields(
  visibleKeys: readonly string[],
  hiddenKeys: readonly string[],
  directKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  if (visibleKeys.length === 0) {
    return { disabled: true };
  }
  const exact = collectExactDirectNames(directKeys, ctx);
  return {
    includeTools: [...visibleKeys],
    ...(hiddenKeys.length > 0 ? { excludeTools: [...hiddenKeys] } : {}),
    directTools: exact.length > 0 ? exact : false,
  };
}

function directExposureFields(
  entries: ReadonlyArray<[string, NativeExposure]>,
  hiddenKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const downgraded = entries
    .filter(([, exp]) => exp === "codemode" || exp === "deferred")
    .map(([key]) => key);
  if (downgraded.length > 0) {
    warnNativeField(
      ctx,
      `per-tool deferred overrides (${downgraded.join(", ")}) remain pinned under directTools: true`,
    );
  }
  return {
    directTools: true,
    ...(hiddenKeys.length > 0 ? { excludeTools: [...hiddenKeys] } : {}),
  };
}

function defaultExposureFields(
  exposure: NativeExposure | undefined,
  directKeys: readonly string[],
  hiddenKeys: readonly string[],
  ctx: NativeEntryContext,
): Partial<ServerEntry> {
  const exact = collectExactDirectNames(directKeys, ctx);
  const result: Partial<ServerEntry> = {};
  if (hiddenKeys.length > 0) {
    result.excludeTools = [...hiddenKeys];
  }
  if (exact.length > 0) {
    result.directTools = exact;
  } else if (exposure !== undefined) {
    result.directTools = false;
  }
  return result;
}

function exposureFields(
  base: NativeBaseFields,
  ctx: NativeEntryContext,
): Partial<ServerEntry> | null {
  const entries = base.toolExposure ? Object.entries(base.toolExposure) : [];
  if (hasUnrepresentableToolExposure(entries)) {
    return warnNativeEntry(
      ctx,
      "toolExposure mixes hidden wildcards with conflicting visible rules that cannot be represented safely",
    );
  }
  const directKeys = entries.filter(([, exp]) => exp === "direct").map(([key]) => key);
  const hiddenKeys = entries.filter(([, exp]) => exp === "hidden").map(([key]) => key);
  if (base.exposure === "hidden") {
    const visibleKeys = entries.filter(([, exp]) => exp !== "hidden").map(([key]) => key);
    return hiddenExposureFields(visibleKeys, hiddenKeys, directKeys, ctx);
  }
  if (base.exposure === "direct") {
    return directExposureFields(entries, hiddenKeys, ctx);
  }
  return defaultExposureFields(base.exposure, directKeys, hiddenKeys, ctx);
}

function resolveDisabledOverride(
  enabled: boolean | undefined,
  hiddenDisabled: boolean,
): Partial<ServerEntry> {
  if (enabled === false || hiddenDisabled) {
    return { disabled: true };
  }
  return enabled === true ? { disabled: false } : {};
}

function mapOverrideEntry(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
  existingServers: Readonly<Record<string, ServerEntry>> | undefined,
): ServerEntry | null {
  const extra = Object.keys(raw).filter((key) => !NATIVE_OVERRIDE_KEYS.has(key));
  if (extra.length > 0) {
    return warnNativeEntry(
      ctx,
      `an override without command or url can only set enabled, exposure, or toolExposure (unexpected: ${extra.join(", ")})`,
    );
  }
  if (existingServers !== undefined && !Object.hasOwn(existingServers, ctx.serverName)) {
    return warnNativeEntry(
      ctx,
      'needs "command" or "url", or a lower-precedence server to override',
    );
  }
  const base = parseBaseFields(raw, ctx);
  if (!base) {
    return null;
  }
  const mappedExposure = exposureFields(base, ctx);
  if (!mappedExposure) {
    return null;
  }
  return {
    ...mappedExposure,
    ...resolveDisabledOverride(base.enabled, mappedExposure.disabled === true),
  };
}

function validateHttpFields(raw: Record<string, unknown>, ctx: NativeEntryContext): boolean {
  if (typeof raw.command === "string" && raw.command.trim() !== "") {
    return warnNativeEntryFalse(ctx, 'cannot set both "url" and "command"');
  }
  if (typeof raw.url !== "string" || !isValidHttpUrl(raw.url)) {
    return warnNativeEntryFalse(ctx, "url must be an http or https URL");
  }
  if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
    return warnNativeEntryFalse(ctx, "headers must map names to strings");
  }
  return true;
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return (
    headers !== undefined &&
    Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
  );
}

function shouldEnableNativeOAuth(
  headers: Readonly<Record<string, string>> | undefined,
  hasOAuthConfig: boolean,
): boolean {
  if (hasAuthorizationHeader(headers)) {
    return false;
  }
  return hasOAuthConfig || (headers !== undefined && Object.keys(headers).length > 0);
}

function mapHttpEntry(raw: Record<string, unknown>, ctx: NativeEntryContext): ServerEntry | null {
  if (!validateHttpFields(raw, ctx) || typeof raw.url !== "string") {
    return null;
  }
  const oauth = mapNativeOAuth(raw.oauth, ctx);
  if (oauth === null) {
    return null;
  }
  const entry: ServerEntry = { url: raw.url };
  const headers = isStringRecord(raw.headers) ? { ...raw.headers } : undefined;
  if (headers !== undefined) {
    entry.headers = headers;
  }
  if (oauth !== undefined) {
    entry.oauth = oauth;
  }
  if (shouldEnableNativeOAuth(headers, oauth !== undefined)) {
    entry.auth = "oauth";
  }
  return entry;
}

function validateStdioFields(raw: Record<string, unknown>, ctx: NativeEntryContext): boolean {
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    return warnNativeEntryFalse(ctx, "command must be a non-empty string");
  }
  if (raw.args !== undefined && !isStringArray(raw.args)) {
    return warnNativeEntryFalse(ctx, "args must be an array of strings");
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    return warnNativeEntryFalse(ctx, "env must map names to strings");
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
    return warnNativeEntryFalse(ctx, "cwd must be a string");
  }
  return true;
}

function mapStdioEntry(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
  projectCwd: string,
): ServerEntry | null {
  if (!validateStdioFields(raw, ctx) || typeof raw.command !== "string") {
    return null;
  }
  const entry: ServerEntry = { command: expandHomePath(raw.command) };
  if (isStringArray(raw.args)) {
    entry.args = raw.args.map(expandHomePath);
  }
  if (isStringRecord(raw.env)) {
    entry.env = { ...raw.env };
  }
  if (typeof raw.cwd === "string") {
    entry.cwd = resolveNativeCwd(raw.cwd, projectCwd);
  }
  return entry;
}

function mapTransportEntry(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
  cwd: string,
): ServerEntry | null {
  const { type, url, command } = raw;
  if (
    typeof url === "string" &&
    (type === undefined || type === "http" || type === "streamable-http")
  ) {
    return mapHttpEntry(raw, ctx);
  }
  if (typeof command === "string" && (type === undefined || type === "stdio")) {
    return mapStdioEntry(raw, ctx, cwd);
  }
  return warnNativeEntry(ctx, 'needs either "command" (stdio) or "url" (streamable HTTP)');
}

function validateDefinitionTypeAndAuth(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
): boolean {
  const { type, auth } = raw;
  if (type === "sse") {
    return warnNativeEntryFalse(ctx, "legacy SSE transport is not supported");
  }
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
    return warnNativeEntryFalse(ctx, "unsupported transport type");
  }
  if (auth !== undefined) {
    return warnNativeEntryFalse(ctx, "project native Pi auth is not supported");
  }
  return true;
}

function mapDefinitionEntry(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
  cwd: string,
): ServerEntry | null {
  if (!validateDefinitionTypeAndAuth(raw, ctx)) {
    return null;
  }
  const base = parseBaseFields(raw, ctx);
  if (!base) {
    return null;
  }
  const transport = mapTransportEntry(raw, ctx, cwd);
  if (!transport) {
    return null;
  }
  const mappedExposure = exposureFields(base, ctx);
  if (!mappedExposure) {
    return null;
  }
  return {
    ...transport,
    ...(base.timeout !== undefined ? { requestTimeoutMs: Math.round(base.timeout * 1000) } : {}),
    ...mappedExposure,
    ...resolveDisabledOverride(base.enabled, mappedExposure.disabled === true),
  };
}

function mapNativeServerEntry(
  raw: unknown,
  ctx: NativeEntryContext,
  cwd: string,
  existingServers: Readonly<Record<string, ServerEntry>> | undefined,
): { readonly entry: ServerEntry; readonly replacesExisting: boolean } | null {
  if (!isConfigObject(raw)) {
    return warnNativeEntry(ctx, "server entry must be an object");
  }
  if (raw.command === undefined && raw.url === undefined && raw.type === undefined) {
    const entry = mapOverrideEntry(raw, ctx, existingServers);
    return entry === null ? null : { entry, replacesExisting: false };
  }
  const entry = mapDefinitionEntry(raw, ctx, cwd);
  return entry === null ? null : { entry, replacesExisting: true };
}

function parseNativeConfigFile(filePath: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    const rawText = readFileSync(filePath, "utf-8");
    const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    raw = JSON.parse(stripJsonComments(text, { trailingCommas: true }));
  } catch (error) {
    console.warn(`Failed to load native Pi MCP config from ${filePath}:`, error);
    return null;
  }
  if (!isConfigObject(raw)) {
    console.warn(`Failed to load native Pi MCP config from ${filePath}: expected an object`);
    return null;
  }
  return raw;
}

/**
 * Read and translate a native Pi project `.pi/mcp.json` file into Fitch MCP Adapter config.
 * Invalid entries warn and are skipped individually so sibling servers remain usable.
 */
export function readNativePiProjectConfig(
  filePath: string,
  cwd: string,
  existingServers?: Readonly<Record<string, ServerEntry>>,
): LoadedNativePiConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = parseNativeConfigFile(filePath);
  if (!raw) {
    return null;
  }
  if (raw.mcpServers === undefined) {
    return { config: { mcpServers: {} }, replacedServers: new Set() };
  }
  if (!isConfigObject(raw.mcpServers)) {
    console.warn(
      `Failed to load native Pi MCP config from ${filePath}: mcpServers must be an object`,
    );
    return null;
  }
  const mcpServers: Record<string, ServerEntry> = {};
  const replacedServers = new Set<string>();
  for (const [serverName, value] of Object.entries(raw.mcpServers)) {
    const mapped = mapNativeServerEntry(value, { filePath, serverName }, cwd, existingServers);
    if (mapped !== null) {
      mcpServers[serverName] = mapped.entry;
      if (mapped.replacesExisting) {
        replacedServers.add(serverName);
      }
    }
  }
  return { config: { mcpServers }, replacedServers };
}
