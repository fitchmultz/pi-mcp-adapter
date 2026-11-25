import type { OAuthConfig } from "./config-types.ts";
import { isConfigObject } from "./config-validation.ts";

export interface NativeEntryContext {
  readonly filePath: string;
  readonly serverName: string;
}

type ClientRegistration = "auto" | "dcr" | "cimd";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function warnNativeEntry(ctx: NativeEntryContext, reason: string): null {
  console.warn(`Ignoring native Pi MCP entry "${ctx.serverName}" in ${ctx.filePath}: ${reason}`);
  return null;
}

export function warnNativeEntryFalse(ctx: NativeEntryContext, reason: string): false {
  console.warn(`Ignoring native Pi MCP entry "${ctx.serverName}" in ${ctx.filePath}: ${reason}`);
  return false;
}

export function warnNativeField(ctx: NativeEntryContext, detail: string): void {
  console.warn(`Native Pi MCP entry "${ctx.serverName}" in ${ctx.filePath}: ${detail}`);
}

function isValidAuthMetadataUrl(value: unknown): boolean {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

function parseLoopbackUrl(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.search === "" &&
    url.hash === ""
    ? url
    : null;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function combineCallbackUrlAndPort(
  callbackUrl: string,
  callbackPort: number | undefined,
  ctx: NativeEntryContext,
): string | null | undefined {
  const parsed = parseLoopbackUrl(callbackUrl);
  if (!parsed) {
    return warnNativeEntry(
      ctx,
      "oauth.callbackUrl must be a loopback http URI without query or fragment",
    );
  }
  if (parsed.port !== "" && callbackPort !== undefined && Number(parsed.port) !== callbackPort) {
    return warnNativeEntry(ctx, "oauth.callbackUrl and oauth.callbackPort name different ports");
  }
  if (parsed.port === "" && callbackPort !== undefined) {
    parsed.port = String(callbackPort);
    return parsed.toString();
  }
  if (parsed.port !== "") {
    return callbackUrl;
  }
  warnNativeField(
    ctx,
    "oauth.callbackUrl without a port is not supported by Fitch MCP Adapter and was ignored",
  );
  return undefined;
}

function resolveNativeRedirectUri(
  oauth: Record<string, unknown>,
  ctx: NativeEntryContext,
): string | null | undefined {
  const { callbackUrl, callbackPort } = oauth;
  if (callbackPort !== undefined && !isValidPort(callbackPort)) {
    return warnNativeEntry(ctx, "oauth.callbackPort must be an integer port");
  }
  if (callbackUrl === undefined) {
    return callbackPort !== undefined ? `http://127.0.0.1:${callbackPort}/callback` : undefined;
  }
  return typeof callbackUrl === "string"
    ? combineCallbackUrlAndPort(callbackUrl, callbackPort, ctx)
    : warnNativeEntry(
        ctx,
        "oauth.callbackUrl must be a loopback http URI without query or fragment",
      );
}

function validateNativeOAuthFields(
  oauth: Record<string, unknown>,
  ctx: NativeEntryContext,
): boolean {
  for (const field of ["clientId", "clientSecret", "scope"] as const) {
    if (oauth[field] !== undefined && typeof oauth[field] !== "string") {
      return warnNativeEntryFalse(ctx, `oauth.${field} must be a string`);
    }
  }
  if (
    oauth.clientName !== undefined &&
    (typeof oauth.clientName !== "string" || oauth.clientName.trim() === "")
  ) {
    return warnNativeEntryFalse(ctx, "oauth.clientName must be a non-empty string");
  }
  if (oauth.authServerMetadataUrl === undefined) {
    return true;
  }
  if (!isValidAuthMetadataUrl(oauth.authServerMetadataUrl)) {
    return warnNativeEntryFalse(
      ctx,
      "oauth.authServerMetadataUrl must be an https or loopback http URL",
    );
  }
  warnNativeField(
    ctx,
    "oauth.authServerMetadataUrl is not supported by Fitch MCP Adapter and was ignored",
  );
  return true;
}

function validateClientRegistration(
  oauth: Record<string, unknown>,
  ctx: NativeEntryContext,
): ClientRegistration | null | undefined {
  const registration = oauth.clientRegistration;
  if (registration === undefined) {
    return undefined;
  }
  if (registration !== "auto" && registration !== "dcr" && registration !== "cimd") {
    return warnNativeEntry(ctx, 'oauth.clientRegistration must be "auto", "dcr", or "cimd"');
  }
  if (registration === "cimd" && (oauth.clientId !== undefined || oauth.clientName !== undefined)) {
    return warnNativeEntry(
      ctx,
      'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName',
    );
  }
  return registration;
}

function buildMappedOAuth(
  raw: Record<string, unknown>,
  registration: ClientRegistration | undefined,
  redirectUri: string | undefined,
): OAuthConfig {
  const oauth: OAuthConfig = {};
  if (typeof raw.clientId === "string") {
    oauth.clientId = raw.clientId;
  }
  if (typeof raw.clientSecret === "string") {
    oauth.clientSecret = raw.clientSecret;
  }
  if (typeof raw.scope === "string") {
    oauth.scope = raw.scope;
  }
  if (typeof raw.clientName === "string") {
    oauth.clientName = raw.clientName;
  }
  if (redirectUri !== undefined) {
    oauth.redirectUri = redirectUri;
  }
  if (registration === "dcr") {
    oauth.clientMetadataUrl = false;
  }
  return oauth;
}

const ADAPTER_ONLY_TOP_LEVEL_KEYS = ["settings", "imports"] as const;
const ADAPTER_ONLY_SERVER_KEYS = [
  "disabled",
  "directTools",
  "socket",
  "includeTools",
  "excludeTools",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "debug",
  "bearerToken",
  "bearerTokenEnv",
] as const;
const ADAPTER_ONLY_OAUTH_KEYS = ["redirectUri", "clientMetadataUrl"] as const;

export function findAdapterOnlyTopLevelKeys(raw: Record<string, unknown>): string[] {
  return ADAPTER_ONLY_TOP_LEVEL_KEYS.filter((key) => Object.hasOwn(raw, key));
}

export function findAdapterOnlyServerKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of ADAPTER_ONLY_SERVER_KEYS) {
    if (Object.hasOwn(raw, key)) {
      found.push(key);
    }
  }
  if (typeof raw.auth === "string") {
    found.push("auth");
  }
  if (isConfigObject(raw.oauth)) {
    for (const key of ADAPTER_ONLY_OAUTH_KEYS) {
      if (Object.hasOwn(raw.oauth, key)) {
        found.push(`oauth.${key}`);
      }
    }
  }
  return found;
}

function matchesNativeToolPattern(pattern: string, toolName: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

export function hasUnrepresentableToolExposure(
  entries: ReadonlyArray<[string, "direct" | "codemode" | "deferred" | "hidden"]>,
): boolean {
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

export function mapNativeOAuth(
  raw: unknown,
  ctx: NativeEntryContext,
): OAuthConfig | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isConfigObject(raw)) {
    return warnNativeEntry(ctx, "oauth must be an object");
  }
  const registration = validateClientRegistration(raw, ctx);
  if (registration === null || !validateNativeOAuthFields(raw, ctx)) {
    return null;
  }
  const redirectUri = resolveNativeRedirectUri(raw, ctx);
  if (redirectUri === null) {
    return null;
  }
  return buildMappedOAuth(raw, registration, redirectUri);
}
