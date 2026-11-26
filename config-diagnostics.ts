import type {
  ImportKind,
  McpConfig,
  McpConfigValidationError,
  McpSettings,
  ServerEntry,
} from "./config-types.ts";
import { validateUnknownServerProtocolConfig } from "./config-protocol.ts";
import {
  isBoolean,
  isConfigObject,
  isImportKind,
  isMcpSettings,
  isPositiveNumber,
  isServerEntry,
  isUnknownArray,
  oauthFields,
  outputGuardFields,
  serverFields,
  settingsFields,
  traceFields,
} from "./config-validation.ts";
import {
  CONFIG_FINITE_NUMERIC_FIELDS,
  CONFIG_NON_NEGATIVE_NUMERIC_FIELDS,
  CONFIG_POSITIVE_NUMERIC_FIELDS,
  CONFIG_TYPO_HINTS,
  type ValidationScope,
} from "./config-validation-hints.ts";

const TOP_LEVEL_KEYS = new Set([
  "mcpServers",
  "mcp-servers",
  "imports",
  "settings",
  "$schema",
  "extension",
]);
const SERVER_KEY_SET = new Set([...Object.keys(serverFields), "extension"]);
const OAUTH_KEY_SET = new Set([...Object.keys(oauthFields), "extension"]);
const SETTINGS_KEY_SET = new Set([...Object.keys(settingsFields), "extension"]);
const OUTPUT_GUARD_KEY_SET = new Set(Object.keys(outputGuardFields));
const TRACE_KEY_SET = new Set(Object.keys(traceFields));
const FINITE_NUMERIC_FIELDS = CONFIG_FINITE_NUMERIC_FIELDS;
const POSITIVE_NUMERIC_FIELDS = CONFIG_POSITIVE_NUMERIC_FIELDS;
const NON_NEGATIVE_NUMERIC_FIELDS = CONFIG_NON_NEGATIVE_NUMERIC_FIELDS;
const TYPO_HINTS = CONFIG_TYPO_HINTS;

interface FieldDiagnosticTarget {
  filePath: string;
  scope: "server" | "setting";
  field: string;
  serverName?: string;
}

function resolveFieldErrorKind(
  isNumBound: boolean,
  scope: "server" | "setting",
): "invalid_numeric_bound" | "invalid_server" | "invalid_setting" {
  if (isNumBound) {
    return "invalid_numeric_bound";
  }
  return scope === "server" ? "invalid_server" : "invalid_setting";
}

function numericFieldRequirement(leaf: string): string | undefined {
  if (POSITIVE_NUMERIC_FIELDS.has(leaf)) {
    return "a positive finite number";
  }
  if (FINITE_NUMERIC_FIELDS.has(leaf)) {
    return "a finite number";
  }
  if (NON_NEGATIVE_NUMERIC_FIELDS.has(leaf)) {
    return "a non-negative finite number";
  }
  return undefined;
}

function pushNumericOrFieldError(
  errors: McpConfigValidationError[],
  target: FieldDiagnosticTarget,
  value: unknown,
): void {
  const { filePath, scope, field, serverName } = target;
  const leaf = field.includes(".") ? (field.split(".").at(-1) ?? field) : field;
  const requirement = typeof value === "number" ? numericFieldRequirement(leaf) : undefined;
  const isNumBound = requirement !== undefined;
  const prefix = serverName !== undefined ? `Server "${serverName}" ` : "";
  errors.push({
    severity: "error",
    kind: resolveFieldErrorKind(isNumBound, scope),
    filePath,
    ...(serverName !== undefined ? { serverName } : {}),
    field,
    message: isNumBound
      ? `${prefix}field "${field}" must be ${requirement} (got ${String(value)})`
      : `${prefix}invalid value for "${field}"`,
  });
}

function formatTargetLabel(scope: ValidationScope, serverName?: string): string {
  if (serverName !== undefined) {
    return scope === "oauth" ? `server "${serverName}" oauth` : `server "${serverName}"`;
  }
  return scope === "top" ? "config" : scope;
}

function maybePushTimeoutBoundError(
  errors: McpConfigValidationError[],
  input: {
    key: string;
    value: unknown;
    scope: ValidationScope;
    filePath: string;
    qualifiedField: string;
    serverName?: string;
  },
): void {
  const { key, value, scope, filePath, qualifiedField, serverName } = input;
  if (key === "timeout" && typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
    pushNumericOrFieldError(
      errors,
      {
        filePath,
        scope: scope === "server" ? "server" : "setting",
        field: qualifiedField,
        ...(serverName !== undefined ? { serverName } : {}),
      },
      value,
    );
  }
}

function collectUnknownKeys(input: {
  raw: Record<string, unknown>;
  allowed: ReadonlySet<string>;
  scope: ValidationScope;
  filePath: string;
  errors: McpConfigValidationError[];
  serverName?: string;
}): void {
  const { raw, allowed, scope, filePath, errors, serverName } = input;
  const hints = TYPO_HINTS[scope];
  const targetLabel = formatTargetLabel(scope, serverName);
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key)) {
      continue;
    }
    const qualifiedField = scope === "oauth" ? `oauth.${key}` : key;
    maybePushTimeoutBoundError(errors, {
      key,
      value,
      scope,
      filePath,
      qualifiedField,
      ...(serverName !== undefined ? { serverName } : {}),
    });
    const hint = hints[key];
    errors.push({
      severity: "warning",
      kind: "unknown_key",
      filePath,
      ...(serverName !== undefined ? { serverName } : {}),
      field: qualifiedField,
      message:
        hint !== undefined && hint.length > 0
          ? `Unknown key "${key}" in ${targetLabel}: ${hint}`
          : `Unknown key "${key}" in ${targetLabel}`,
    });
  }
}

function resolveOAuthFailureTarget(
  oauth: Record<string, unknown>,
  field: string,
): { field: string; value: unknown } {
  if (
    field === "privateKeyJwt" &&
    isConfigObject(oauth.privateKeyJwt) &&
    "lifetimeSeconds" in oauth.privateKeyJwt &&
    !isPositiveNumber(oauth.privateKeyJwt.lifetimeSeconds)
  ) {
    return {
      field: "oauth.privateKeyJwt.lifetimeSeconds",
      value: oauth.privateKeyJwt.lifetimeSeconds,
    };
  }
  return { field: `oauth.${field}`, value: oauth[field] };
}

function diagnoseNestedOAuthFailure(
  oauth: Record<string, unknown>,
  filePath: string,
  serverName: string,
  errors: McpConfigValidationError[],
): void {
  let reported = false;
  for (const [field, check] of Object.entries(oauthFields)) {
    if (!(field in oauth) || check(oauth[field])) {
      continue;
    }
    reported = true;
    const target = resolveOAuthFailureTarget(oauth, field);
    pushNumericOrFieldError(
      errors,
      { filePath, scope: "server", field: target.field, serverName },
      target.value,
    );
  }
  if (!reported) {
    errors.push({
      severity: "error",
      kind: "invalid_server",
      filePath,
      serverName,
      field: "oauth",
      message: `Server "${serverName}" has invalid "oauth" configuration`,
    });
  }
}

function diagnoseServerFailure(
  entry: Record<string, unknown>,
  filePath: string,
  serverName: string,
  errors: McpConfigValidationError[],
): void {
  let reported = false;
  for (const [field, check] of Object.entries(serverFields)) {
    if (!(field in entry) || check(entry[field])) {
      continue;
    }
    reported = true;
    if (field === "oauth" && isConfigObject(entry.oauth)) {
      diagnoseNestedOAuthFailure(entry.oauth, filePath, serverName, errors);
      continue;
    }
    pushNumericOrFieldError(errors, { filePath, scope: "server", field, serverName }, entry[field]);
  }
  if (!reported) {
    errors.push({
      severity: "error",
      kind: "invalid_server",
      filePath,
      serverName,
      message: `Invalid MCP server configuration: ${serverName}`,
    });
  }
}

function validateNestedSettingsSection(input: {
  rawSection: unknown;
  fields: Record<string, (entry: unknown) => boolean>;
  allowedKeys: ReadonlySet<string>;
  sectionName: "outputGuard" | "trace";
  filePath: string;
  errors: McpConfigValidationError[];
}): Record<string, unknown> | undefined {
  const { rawSection, fields, allowedKeys, sectionName, filePath, errors } = input;
  if (!isConfigObject(rawSection)) {
    pushNumericOrFieldError(errors, { filePath, scope: "setting", field: sectionName }, rawSection);
    return undefined;
  }
  collectUnknownKeys({
    raw: rawSection,
    allowed: allowedKeys,
    scope: sectionName,
    filePath,
    errors,
  });
  const valid: Record<string, unknown> = {};
  let retainedAny = false;
  for (const [key, value] of Object.entries(rawSection)) {
    const validator = fields[key];
    if (!validator || validator(value)) {
      valid[key] = value;
      retainedAny = true;
    } else {
      pushNumericOrFieldError(
        errors,
        { filePath, scope: "setting", field: `${sectionName}.${key}` },
        value,
      );
    }
  }
  return retainedAny || Object.keys(rawSection).length === 0 ? valid : undefined;
}

function validateSettingEntry(input: {
  key: string;
  value: unknown;
  validated: Record<string, unknown>;
  filePath: string;
  errors: McpConfigValidationError[];
}): void {
  const { key, value, validated, filePath, errors } = input;
  if (key === "outputGuard" && !isBoolean(value)) {
    const section = validateNestedSettingsSection({
      rawSection: value,
      fields: outputGuardFields,
      allowedKeys: OUTPUT_GUARD_KEY_SET,
      sectionName: "outputGuard",
      filePath,
      errors,
    });
    if (section !== undefined) {
      validated.outputGuard = section;
    }
    return;
  }
  if (key === "trace") {
    const section = validateNestedSettingsSection({
      rawSection: value,
      fields: traceFields,
      allowedKeys: TRACE_KEY_SET,
      sectionName: "trace",
      filePath,
      errors,
    });
    if (section !== undefined) {
      validated.trace = section;
    }
    return;
  }
  const validator = (settingsFields as Record<string, (entry: unknown) => boolean>)[key];
  if (!validator || validator(value)) {
    validated[key] = value;
  } else {
    pushNumericOrFieldError(errors, { filePath, scope: "setting", field: key }, value);
  }
}

function validateSettingsObject(
  rawSettings: unknown,
  filePath: string,
  errors: McpConfigValidationError[],
): McpSettings | undefined {
  if (rawSettings === undefined) {
    return undefined;
  }
  const normalized =
    isConfigObject(rawSettings) && rawSettings.hostConfigDiscovery === "prompt"
      ? { ...rawSettings, hostConfigDiscovery: "off" }
      : rawSettings;
  if (!isConfigObject(normalized)) {
    pushNumericOrFieldError(errors, { filePath, scope: "setting", field: "settings" }, rawSettings);
    return undefined;
  }
  collectUnknownKeys({
    raw: normalized,
    allowed: SETTINGS_KEY_SET,
    scope: "settings",
    filePath,
    errors,
  });
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    validateSettingEntry({ key, value, validated, filePath, errors });
  }
  return isMcpSettings(validated) ? validated : undefined;
}

function validateImportsField(
  rawImports: unknown,
  filePath: string,
  errors: McpConfigValidationError[],
): ImportKind[] | undefined {
  if (rawImports === undefined) {
    return undefined;
  }
  if (!isUnknownArray(rawImports)) {
    errors.push({
      severity: "error",
      kind: "invalid_import",
      filePath,
      field: "imports",
      message: '"imports" must be an array of supported client names',
    });
    return undefined;
  }
  const valid: ImportKind[] = [];
  for (const item of rawImports) {
    if (isImportKind(item)) {
      valid.push(item);
    } else {
      errors.push({
        severity: "error",
        kind: "invalid_import",
        filePath,
        field: "imports",
        message: `Unsupported import source "${String(item)}"`,
      });
    }
  }
  return valid;
}

export function validateServerEntryWithDiagnostics(input: {
  name: string;
  entry: unknown;
  filePath: string;
  errors: McpConfigValidationError[];
}): ServerEntry | undefined {
  const { name, entry, filePath, errors } = input;
  try {
    validateUnknownServerProtocolConfig(entry);
  } catch (error) {
    errors.push({
      severity: "error",
      kind: "invalid_server",
      filePath,
      serverName: name,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (!isConfigObject(entry)) {
    errors.push({
      severity: "error",
      kind: "invalid_server",
      filePath,
      serverName: name,
      message: `Invalid MCP server configuration: ${name} (must be an object)`,
    });
    return undefined;
  }
  if (!isServerEntry(entry)) {
    diagnoseServerFailure(entry, filePath, name, errors);
    return undefined;
  }
  collectUnknownKeys({
    raw: entry,
    allowed: SERVER_KEY_SET,
    scope: "server",
    filePath,
    errors,
    serverName: name,
  });
  if (isConfigObject(entry.oauth)) {
    collectUnknownKeys({
      raw: entry.oauth,
      allowed: OAUTH_KEY_SET,
      scope: "oauth",
      filePath,
      errors,
      serverName: name,
    });
  }
  return entry;
}

function extractValidatedServers(
  rawServers: unknown,
  filePath: string,
  errors: McpConfigValidationError[],
): Record<string, ServerEntry> {
  const mcpServers: Record<string, ServerEntry> = {};
  if (rawServers === undefined) {
    return mcpServers;
  }
  if (!isConfigObject(rawServers)) {
    errors.push({
      severity: "error",
      kind: "invalid_config_shape",
      filePath,
      field: "mcpServers",
      message: '"mcpServers" must be an object mapping server names to configurations',
    });
    return mcpServers;
  }
  for (const [name, entry] of Object.entries(rawServers)) {
    const validated = validateServerEntryWithDiagnostics({ name, entry, filePath, errors });
    if (validated !== undefined) {
      mcpServers[name] = validated;
    }
  }
  return mcpServers;
}

export function validateConfigWithDiagnostics(
  raw: unknown,
  filePath: string,
): { config: McpConfig; errors: McpConfigValidationError[] } {
  const errors: McpConfigValidationError[] = [];
  if (!isConfigObject(raw)) {
    errors.push({
      severity: "error",
      kind: "invalid_config_shape",
      filePath,
      message: "MCP config root must be a JSON object",
    });
    return { config: { mcpServers: {}, configErrors: errors }, errors };
  }
  collectUnknownKeys({ raw, allowed: TOP_LEVEL_KEYS, scope: "top", filePath, errors });
  const mcpServers = extractValidatedServers(
    raw.mcpServers ?? raw["mcp-servers"],
    filePath,
    errors,
  );
  const imports = validateImportsField(raw.imports, filePath, errors);
  const settings = validateSettingsObject(raw.settings, filePath, errors);
  return {
    config: {
      mcpServers,
      ...(imports !== undefined ? { imports } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(errors.length > 0 ? { configErrors: errors } : {}),
    },
    errors,
  };
}
