import type {
  ServerEntry,
  McpSettings,
  OAuthConfig,
  OAuthPrivateKeyJwtConfig,
  OAuthCrossAppAccessConfig,
  McpTraceSettings,
  McpOutputGuardSettings,
  ImportKind,
  ToolPrefix,
} from "./config-types.ts";

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number";
export const isStringArray = (value: unknown): value is string[] =>
  isUnknownArray(value) && value.every(isString);
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isConfigObject(value) && Object.values(value).every(isString);
const isToolSelection = (value: unknown): value is boolean | string[] =>
  isBoolean(value) || isStringArray(value);
const isFalseOrString = (value: unknown): value is false | string =>
  value === false || isString(value);
const isToolPrefix = (value: unknown): value is ToolPrefix =>
  value === "none" || value === "server" || value === "mcp" || value === "short";

// Check each declared field without stripping extension properties or rebuilding the input.
// The mapped type requires a validator for every optional property in the public contract.
type OptionalFields<T> = {
  [K in keyof T]-?: (value: unknown) => value is Exclude<T[K], undefined>;
};
function matchesOptionalFields(
  value: Record<string, unknown>,
  fields: Record<string, (entry: unknown) => boolean>,
): boolean {
  return Object.entries(fields).every(([key, check]) => !(key in value) || check(value[key]));
}

function isPrivateKeyJwt(value: unknown): value is OAuthPrivateKeyJwtConfig {
  if (!isConfigObject(value)) {
    return false;
  }
  return (
    (isString(value.privateKey) || isConfigObject(value.privateKey)) &&
    isString(value.algorithm) &&
    matchesOptionalFields(value, {
      audience: isString,
      lifetimeSeconds: isNumber,
      claims: isConfigObject,
    } satisfies OptionalFields<Omit<OAuthPrivateKeyJwtConfig, "privateKey" | "algorithm">>)
  );
}
function isCrossAppAccess(value: unknown): value is OAuthCrossAppAccessConfig {
  if (!isConfigObject(value)) {
    return false;
  }
  return (
    isString(value.idpUrl) &&
    isString(value.clientId) &&
    isString(value.idToken) &&
    matchesOptionalFields(value, { clientSecret: isString } satisfies OptionalFields<
      Pick<OAuthCrossAppAccessConfig, "clientSecret">
    >)
  );
}
const oauthFields = {
  skipIssuerMetadataValidation: isBoolean,
  grantType: (value: unknown): value is OAuthConfig["grantType"] & string =>
    value === "authorization_code" || value === "client_credentials",
  clientId: isString,
  clientSecret: isString,
  privateKeyJwt: isPrivateKeyJwt,
  crossAppAccess: isCrossAppAccess,
  scope: isString,
  authorizationParams: isStringRecord,
  redirectUri: isString,
  clientName: isString,
  clientUri: isString,
  clientMetadataUrl: isFalseOrString,
} satisfies OptionalFields<OAuthConfig>;
function isOAuth(value: unknown): value is OAuthConfig | false | null {
  return (
    value === false ||
    value === null ||
    (isConfigObject(value) && matchesOptionalFields(value, oauthFields))
  );
}
const serverFields = {
  command: isNullableString,
  args: isStringArray,
  socket: isNullableString,
  env: isStringRecord,
  cwd: isString,
  protocolVersion: (value: unknown): value is "auto" | "legacy" =>
    value === "auto" || value === "legacy",
  retryOnTransportFailure: isBoolean,
  url: isString,
  headers: isStringRecord,
  auth: (value: unknown): value is "oauth" | "bearer" | false =>
    value === "oauth" || value === "bearer" || value === false,
  bearerToken: isString,
  bearerTokenEnv: isString,
  oauth: isOAuth,
  lifecycle: (value: unknown): value is Exclude<ServerEntry["lifecycle"], undefined> =>
    value === "keep-alive" || value === "lazy" || value === "lazy-keep-alive" || value === "eager",
  idleTimeout: isNumber,
  requestTimeoutMs: isNumber,
  exposeResources: isBoolean,
  directTools: isToolSelection,
  toolPrefix: isToolPrefix,
  includeTools: isStringArray,
  excludeTools: isStringArray,
  approveTools: isToolSelection,
  debug: isBoolean,
  trace: isBoolean,
  disabled: (value: unknown): value is boolean | string => isBoolean(value) || isString(value),
} satisfies OptionalFields<ServerEntry>;
export function isServerEntry(value: unknown): value is ServerEntry {
  return isConfigObject(value) && matchesOptionalFields(value, serverFields);
}
function isOutputGuard(value: unknown): value is McpOutputGuardSettings | boolean {
  return (
    isBoolean(value) ||
    (isConfigObject(value) &&
      matchesOptionalFields(value, {
        maxBytes: isNumber,
        maxLines: isNumber,
        detailsMaxBytes: isNumber,
      } satisfies OptionalFields<McpOutputGuardSettings>))
  );
}
function isTrace(value: unknown): value is McpTraceSettings {
  return (
    isConfigObject(value) &&
    matchesOptionalFields(value, {
      enabled: isBoolean,
      file: isNullableString,
      maxBytes: isNumber,
      maxEvents: isNumber,
    } satisfies OptionalFields<McpTraceSettings>)
  );
}
const settingsFields = {
  toolPrefix: isToolPrefix,
  showStatusIcon: isBoolean,
  mcpFooterStatus: (value: unknown): value is "full" | "compact" | "off" =>
    value === "full" || value === "compact" || value === "off",
  hostConfigDiscovery: (value: unknown): value is "off" | "on" => value === "off" || value === "on",
  idleTimeout: isNumber,
  requestTimeoutMs: isNumber,
  directTools: isBoolean,
  approveTools: isToolSelection,
  disableProxyTool: isBoolean,
  freezeDirectTools: isBoolean,
  autoAuth: isBoolean,
  sampling: isBoolean,
  samplingAutoApprove: isBoolean,
  elicitation: isBoolean,
  outputGuard: isOutputGuard,
  trace: isTrace,
  authRequiredMessage: isString,
  oauthDir: isString,
} satisfies OptionalFields<McpSettings>;
export function isMcpSettings(value: unknown): value is McpSettings {
  return isConfigObject(value) && matchesOptionalFields(value, settingsFields);
}
export function isImportKind(value: unknown): value is ImportKind {
  return (
    value === "cursor" ||
    value === "claude-code" ||
    value === "claude-desktop" ||
    value === "codex" ||
    value === "opencode" ||
    value === "windsurf" ||
    value === "vscode"
  );
}
