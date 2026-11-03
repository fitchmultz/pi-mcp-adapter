import type {
  CachedTool,
  CachedPrompt,
  MetadataCache,
  ServerCacheEntry,
  McpResource,
} from "./types.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

// Cache registration is synchronous and precedes loading MCP and Zod. Validate the
// descriptor shapes here; preserve their raw objects, unknown fields and metadata.
function isRecord(value: unknown): value is Record<string, unknown> {
  return asObjectRecord(value) !== undefined && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isNumber(value: unknown): value is number {
  return typeof value === "number";
}
function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}
function optionalField(
  record: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
): boolean {
  return !(key in record) || check(record[key]);
}
function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every(isString);
}
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (isUnknownArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.values(value).every(isJsonValue)
  );
}
function isInputSchema(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "object") {
    return false;
  }
  return (
    optional(value.required, isStringArray) &&
    optional(
      value.properties,
      (properties) => isRecord(properties) && Object.values(properties).every(isJsonValue),
    )
  );
}
function isOutputSchema(value: unknown): boolean {
  return isRecord(value) && optional(value.$schema, isString);
}
function isIcon(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.src) &&
    optional(value.mimeType, isString) &&
    optional(value.sizes, isStringArray) &&
    (value.theme === undefined || value.theme === "light" || value.theme === "dark")
  );
}
function isDescriptor(value: Record<string, unknown>): boolean {
  return (
    isString(value.name) &&
    optional(value.title, isString) &&
    optional(value.description, isString) &&
    optional(value._meta, isRecord) &&
    optional(value.icons, (icons) => isUnknownArray(icons) && icons.every(isIcon))
  );
}
function isToolAnnotations(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every((key) =>
      optional(value[key], isBoolean),
    ) &&
    optional(value.title, isString)
  );
}
function isExecution(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.taskSupport === undefined ||
      value.taskSupport === "required" ||
      value.taskSupport === "optional" ||
      value.taskSupport === "forbidden")
  );
}
function isLegacyUi(value: Record<string, unknown>): boolean {
  return (
    optionalField(value, "uiResourceUri", isString) &&
    (!("uiStreamMode" in value) ||
      value.uiStreamMode === "eager" ||
      value.uiStreamMode === "stream-first") &&
    optionalField(
      value,
      "uiVisibility",
      (visibility) =>
        isUnknownArray(visibility) &&
        visibility.every((item) => item === "model" || item === "app"),
    )
  );
}
function isCachedTool(value: unknown): value is CachedTool {
  return (
    isRecord(value) &&
    isDescriptor(value) &&
    isLegacyUi(value) &&
    optional(value.inputSchema, isInputSchema) &&
    optional(value.outputSchema, isOutputSchema) &&
    optional(value.annotations, isToolAnnotations) &&
    optional(value.execution, isExecution)
  );
}
function isResourceAnnotations(value: unknown): boolean {
  return (
    isRecord(value) &&
    optional(value.priority, isNumber) &&
    optional(value.lastModified, isString) &&
    optional(
      value.audience,
      (audience) =>
        isUnknownArray(audience) &&
        audience.every((item) => item === "user" || item === "assistant"),
    )
  );
}
function isResource(value: unknown): value is McpResource {
  return (
    isRecord(value) &&
    isDescriptor(value) &&
    isString(value.uri) &&
    optional(value.mimeType, isString) &&
    optional(value.size, isNumber) &&
    optional(value.annotations, isResourceAnnotations)
  );
}
function isPromptArgument(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.name) &&
    optionalField(value, "description", isString) &&
    optionalField(value, "required", isBoolean)
  );
}
function isCachedPrompt(value: unknown): value is CachedPrompt {
  return (
    isRecord(value) &&
    isString(value.name) &&
    optionalField(value, "title", isString) &&
    optionalField(value, "description", isString) &&
    optionalField(
      value,
      "arguments",
      (args) => isUnknownArray(args) && args.every(isPromptArgument),
    )
  );
}
function isDescriptorCollections(value: Record<string, unknown>): boolean {
  return (
    isUnknownArray(value.tools) &&
    value.tools.every(isCachedTool) &&
    isUnknownArray(value.resources) &&
    value.resources.every(isResource) &&
    optionalField(
      value,
      "prompts",
      (prompts) => isUnknownArray(prompts) && prompts.every(isCachedPrompt),
    )
  );
}
export function isCacheEntry(entry: unknown): entry is ServerCacheEntry {
  return (
    isRecord(entry) &&
    isString(entry.configHash) &&
    typeof entry.cachedAt === "number" &&
    Number.isFinite(entry.cachedAt) &&
    entry.cachedAt > 0 &&
    optionalField(entry, "instructions", isString) &&
    isDescriptorCollections(entry)
  );
}

export function readCacheEnvelope(
  raw: unknown,
): { version: number; servers: Record<string, unknown> } | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !isRecord(raw.servers)) {
    return null;
  }
  return { version: raw.version, servers: raw.servers };
}

export function projectMetadataCache(raw: unknown): MetadataCache | null {
  const envelope = readCacheEnvelope(raw);
  if (!envelope) {
    return null;
  }
  const servers: Array<[string, ServerCacheEntry]> = [];
  for (const [name, entry] of Object.entries(envelope.servers)) {
    if (isCacheEntry(entry)) {
      servers.push([name, entry]);
    }
  }
  return { version: envelope.version, servers: Object.fromEntries(servers) };
}
