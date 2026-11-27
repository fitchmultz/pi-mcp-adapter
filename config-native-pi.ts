import type {
  McpExposure,
  McpServerConfig,
  RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
import type { McpConfig, ServerEntry } from "./config-types.ts";
import { isConfigObject, isStringArray, isStringRecord } from "./config-validation.ts";
import {
  findAdapterOnlyServerKeys,
  findAdapterOnlyTopLevelKeys,
  mapNativeOAuth,
  warnNativeEntry,
  warnNativeEntryFalse,
  type NativeEntryContext,
} from "./config-native-pi-oauth.ts";
import {
  buildNativePolicyOverrideEntry,
  mapNativeExposureFields,
  pickNativeServerPolicy,
  type NativeServerPolicy,
} from "./config-native-pi-exposure.ts";

export interface LoadedNativePiConfig {
  readonly config: McpConfig;
  readonly replacedServers: ReadonlySet<string>;
  readonly nativePolicies?: ReadonlyMap<string, NativeServerPolicy>;
}

type NativeBaseFields = Readonly<
  Pick<McpServerConfig, "description" | "enabled" | "timeout" | "exposure" | "toolExposure">
>;

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

export function resolveNativeCwd(value: string, projectCwd: string): string {
  const expanded = expandHomePath(value);
  return isAbsolute(expanded) || ENV_REF_PREFIX.test(expanded)
    ? expanded
    : resolve(projectCwd, expanded);
}

function resolveExposure(value: unknown): McpExposure | undefined {
  if (value === "codemode-deferred") {
    return "codemode";
  }
  return value === "codemode" || value === "deferred" || value === "direct" || value === "hidden"
    ? value
    : undefined;
}

function parseToolExposure(raw: unknown): Record<string, McpExposure> | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isConfigObject(raw)) {
    return null;
  }
  const result: Record<string, McpExposure> = {};
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

function pickScalarBaseFields(
  raw: Record<string, unknown>,
): Pick<NativeBaseFields, "description" | "enabled" | "timeout"> {
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  return {
    ...(description !== "" ? { description } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
  };
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
    ...pickScalarBaseFields(raw),
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
  options: Pick<MapEntryOptions, "existingServers" | "nativePolicies">,
): { readonly entry: ServerEntry; readonly replacesExisting: boolean } | null {
  const extra = Object.keys(raw).filter((key) => !NATIVE_OVERRIDE_KEYS.has(key));
  if (extra.length > 0) {
    return warnNativeEntry(
      ctx,
      `an override without command or url can only set enabled, exposure, or toolExposure (unexpected: ${extra.join(", ")})`,
    );
  }
  if (
    options.existingServers !== undefined &&
    !Object.hasOwn(options.existingServers, ctx.serverName)
  ) {
    return warnNativeEntry(
      ctx,
      'needs "command" or "url", or a lower-precedence server to override',
    );
  }
  const base = parseBaseFields(raw, ctx);
  if (!base) {
    return null;
  }
  return buildNativePolicyOverrideEntry({
    base,
    existing: options.existingServers?.[ctx.serverName],
    nativePolicy: options.nativePolicies?.get(ctx.serverName),
    ctx,
    resolveDisabled: resolveDisabledOverride,
  });
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

interface MappedNativeEntry {
  readonly entry: ServerEntry;
  readonly replacesExisting: boolean;
  readonly policy?: NativeServerPolicy;
}

function mapDefinitionEntry(
  raw: Record<string, unknown>,
  ctx: NativeEntryContext,
  cwd: string,
): { readonly entry: ServerEntry; readonly policy: NativeServerPolicy } | null {
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
  const mappedExposure = mapNativeExposureFields(base, ctx);
  return {
    entry: {
      ...transport,
      ...(base.description !== undefined ? { description: base.description } : {}),
      ...(base.timeout !== undefined ? { requestTimeoutMs: Math.round(base.timeout * 1000) } : {}),
      ...mappedExposure,
      ...resolveDisabledOverride(base.enabled, mappedExposure.disabled === true),
    },
    policy: pickNativeServerPolicy(base),
  };
}

interface MapEntryOptions {
  readonly cwd: string;
  readonly allowOverrides: boolean;
  readonly adapterConfigHint: string;
  readonly existingServers?: Readonly<Record<string, ServerEntry>> | undefined;
  readonly nativePolicies?: ReadonlyMap<string, NativeServerPolicy> | undefined;
}

function mapNativeServerEntry(
  raw: unknown,
  ctx: NativeEntryContext,
  options: MapEntryOptions,
): MappedNativeEntry | null {
  if (!isConfigObject(raw)) {
    return warnNativeEntry(ctx, "server entry must be an object");
  }
  const adapterKeys = findAdapterOnlyServerKeys(raw);
  if (adapterKeys.length > 0) {
    return warnNativeEntry(
      ctx,
      `uses adapter-only fields (${adapterKeys.join(", ")}); move adapter-format configs to ${options.adapterConfigHint}`,
    );
  }
  if (raw.command === undefined && raw.url === undefined && raw.type === undefined) {
    if (!options.allowOverrides) {
      return warnNativeEntry(ctx, 'needs either "command" (stdio) or "url" (streamable HTTP)');
    }
    return mapOverrideEntry(raw, ctx, options);
  }
  const mapped = mapDefinitionEntry(raw, ctx, options.cwd);
  return mapped === null
    ? null
    : { entry: mapped.entry, replacesExisting: true, policy: mapped.policy };
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

function collectNativeServerEntries(
  rawServers: Record<string, unknown>,
  filePath: string,
  options: MapEntryOptions,
): LoadedNativePiConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  const replacedServers = new Set<string>();
  const nativePolicies = new Map<string, NativeServerPolicy>();
  for (const [serverName, value] of Object.entries(rawServers)) {
    const mapped = mapNativeServerEntry(value, { filePath, serverName }, options);
    if (mapped === null) {
      continue;
    }
    mcpServers[serverName] = mapped.entry;
    if (mapped.replacesExisting) {
      replacedServers.add(serverName);
    }
    if (mapped.policy) {
      nativePolicies.set(serverName, mapped.policy);
    }
  }
  return {
    config: { mcpServers },
    replacedServers,
    ...(nativePolicies.size > 0 ? { nativePolicies } : {}),
  };
}

function readNativePiConfigFile(
  filePath: string,
  options: MapEntryOptions,
): LoadedNativePiConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = parseNativeConfigFile(filePath);
  if (!raw) {
    return null;
  }
  const adapterTopKeys = findAdapterOnlyTopLevelKeys(raw);
  if (adapterTopKeys.length > 0) {
    console.warn(
      `Skipped ${filePath}: top-level adapter-only fields (${adapterTopKeys.join(", ")}) look like a legacy adapter config; move it to ${options.adapterConfigHint}`,
    );
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
  return collectNativeServerEntries(raw.mcpServers, filePath, options);
}

/**
 * Read and translate a native Pi global `<agentDir>/mcp.json` file into Fitch MCP Adapter config.
 * Invalid entries warn and are skipped individually so sibling servers remain usable.
 */
export function readNativePiGlobalConfig(
  filePath: string,
  cwd: string,
): LoadedNativePiConfig | null {
  return readNativePiConfigFile(filePath, {
    cwd,
    allowOverrides: false,
    adapterConfigHint: "<agentDir>/fitch-mcp-adapter/mcp.json",
  });
}

/**
 * Read and translate a native Pi project `.pi/mcp.json` file into Fitch MCP Adapter config.
 * Invalid entries warn and are skipped individually so sibling servers remain usable.
 */
export function readNativePiProjectConfig(
  filePath: string,
  cwd: string,
  existingServers?: Readonly<Record<string, ServerEntry>>,
  nativePolicies?: ReadonlyMap<string, NativeServerPolicy>,
): LoadedNativePiConfig | null {
  return readNativePiConfigFile(filePath, {
    cwd,
    allowOverrides: true,
    adapterConfigHint: ".pi/fitch-mcp-adapter/mcp.json",
    existingServers,
    nativePolicies,
  });
}

/**
 * Translate servers registered by extensions via `pi.registerMcpServer()`.
 * Invalid entries warn and are skipped individually.
 */
export function translateRegisteredMcpServers(
  registered: readonly RegisteredMcpServer[],
  cwd: string,
): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  for (const item of registered) {
    const mapped = mapNativeServerEntry(
      item.config,
      { filePath: item.extensionPath, serverName: item.name },
      {
        cwd,
        allowOverrides: false,
        adapterConfigHint: ".pi/fitch-mcp-adapter/mcp.json",
      },
    );
    if (mapped !== null) {
      mcpServers[item.name] = { lifecycle: "eager", ...mapped.entry };
    }
  }
  return { mcpServers };
}
