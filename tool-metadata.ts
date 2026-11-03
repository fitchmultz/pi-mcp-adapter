import type { McpExtensionState } from "./state.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import {
  type ToolMetadata,
  type McpTool,
  type McpResource,
  type ServerEntry,
  type ToolPrefix,
  formatToolName,
  isServerDisabled,
  isToolAllowed,
  resolveToolPrefix,
} from "./types.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.ts";

export function buildToolMetadata({
  tools,
  resources,
  definition,
  serverName,
  prefix,
}: {
  tools: McpTool[];
  resources: McpResource[];
  definition: ServerEntry;
  serverName: string;
  prefix: ToolPrefix;
}): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];
  if (isServerDisabled(definition)) {
    return { metadata, failedTools };
  }
  const context: MetadataContext = {
    definition,
    serverName,
    prefix: resolveToolPrefix(definition, prefix),
  };
  for (const tool of tools) {
    if (tool.name === "") {
      failedTools.push("(unnamed)");
      continue;
    }
    if (!allowsTool(context, tool.name)) {
      continue;
    }
    const uiVisibility = extractUiToolVisibility(tool._meta);
    if (!isUiToolVisibleToModel(uiVisibility)) {
      continue;
    }
    metadata.push(describeTool(tool, context, failedTools, uiVisibility));
  }
  if (definition.exposeResources !== false) {
    metadata.push(...resourceMetadata(resources, context));
  }
  return { metadata, failedTools };
}

interface MetadataContext {
  definition: ServerEntry;
  serverName: string;
  prefix: ToolPrefix;
}

function describeTool(
  tool: McpTool,
  context: MetadataContext,
  failedTools: string[],
  uiVisibility: ReturnType<typeof extractUiToolVisibility>,
): ToolMetadata {
  const uiResourceUri = readUiResourceUri(tool, failedTools);
  const uiStreamMode = extractToolUiStreamMode(tool._meta);
  return {
    ...tool,
    name: formatToolName(tool.name, context.serverName, context.prefix),
    originalName: tool.name,
    description: tool.description ?? "",
    ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
    ...(uiVisibility !== undefined ? { uiVisibility } : {}),
    ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
  };
}

function allowsTool(context: MetadataContext, name: string): boolean {
  return isToolAllowed(
    name,
    context.serverName,
    context.prefix,
    context.definition.includeTools,
    context.definition.excludeTools,
  );
}

function readUiResourceUri(tool: McpTool, failedTools: string[]): string | undefined {
  try {
    // Read cached MCP Apps metadata without loading the SDK client.
    const uri = asObjectRecord(tool._meta?.ui)?.resourceUri;
    const resourceUri = uri === undefined ? tool._meta?.["ui/resourceUri"] : uri;
    if (typeof resourceUri === "string" && resourceUri.startsWith("ui://")) {
      return resourceUri;
    }
    if (resourceUri !== undefined) {
      failedTools.push(tool.name);
    }
  } catch {
    failedTools.push(tool.name);
  }
  return undefined;
}

function resourceMetadata(resources: McpResource[], context: MetadataContext): ToolMetadata[] {
  const metadata: ToolMetadata[] = [];
  for (const resource of resources) {
    if (resource.name === "" || resource.uri === "") {
      continue;
    }
    const baseName = `read_${resourceNameToToolName(resource.name)}`;
    if (!allowsTool(context, baseName)) {
      continue;
    }
    metadata.push({
      name: formatToolName(baseName, context.serverName, context.prefix),
      originalName: baseName,
      description: resource.description ?? `Read resource: ${resource.uri}`,
      resourceUri: resource.uri,
      resourceDescriptor: resource,
    });
  }
  return metadata;
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.filter((tool) => tool.resourceUri === undefined).length;
  }
  return count;
}

export function toToolDescriptor(
  server: string,
  tool: ToolMetadata,
): Omit<
  ToolMetadata,
  | "name"
  | "originalName"
  | "resourceUri"
  | "resourceDescriptor"
  | "uiResourceUri"
  | "uiVisibility"
  | "uiStreamMode"
> & { server: string; path: string; name: string } {
  const {
    name: path,
    originalName: name,
    resourceUri: _resourceUri,
    resourceDescriptor: _resourceDescriptor,
    uiResourceUri: _uiResourceUri,
    uiVisibility: _uiVisibility,
    uiStreamMode: _uiStreamMode,
    ...descriptor
  } = tool;
  return { ...descriptor, server, path, name };
}

export function catalogCoverage(
  state: McpExtensionState,
  server?: string,
): {
  complete: boolean;
  knownServers: string[];
  unknownServers: string[];
} {
  const servers = Object.keys(state.config.mcpServers).filter(
    (name) =>
      (server === undefined || server === "" || name === server) &&
      !isServerDisabled(state.config.mcpServers[name]),
  );
  const knownServers = servers.filter((name) => state.toolMetadata.has(name));
  const unknownServers = servers.filter((name) => !state.toolMetadata.has(name));
  return { complete: unknownServers.length === 0, knownServers, unknownServers };
}

export function findToolByName(
  metadata: ToolMetadata[] | undefined,
  toolName: string,
): ToolMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const exact = metadata.filter((m) => m.name === toolName);
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : undefined;
  }
  const normalized = toolName.replace(/-/g, "_");
  const matches = metadata.filter((m) => m.name.replace(/-/g, "_") === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

export function formatSchema(schema: unknown, indent = "  "): string {
  const s = asObjectRecord(schema);
  if (!s || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const props = asObjectRecord(s.properties);
  if (s.type === "object" && props && !Array.isArray(s.properties)) {
    return formatObjectParameters(props, s.required, indent);
  }

  const lines = formatNestedSchema(s, indent);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const typeStr = formatType(s);
  if (typeStr !== "") {
    return `${indent}(${typeStr})`;
  }

  return `${indent}(complex schema)`;
}

function formatObjectParameters(
  props: Record<string, unknown>,
  requiredValue: unknown,
  indent: string,
): string {
  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((name): name is string => typeof name === "string")
    : [];
  if (Object.keys(props).length === 0) {
    return `${indent}(no parameters)`;
  }
  const lines: string[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
  }
  return lines.join("\n");
}

function formatProperty(
  name: string,
  schema: unknown,
  required: boolean,
  indent: string,
): string[] {
  const s = asObjectRecord(schema);
  if (!s || Array.isArray(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const parts = [`${indent}${name}`];
  const typeStr = formatType(s);
  if (typeStr !== "") {
    parts.push(`(${typeStr})`);
  }
  if (required) {
    parts.push("*required*");
  }
  appendSchemaAnnotations(parts, s);

  return [parts.join(" "), ...formatNestedSchema(s, `${indent}  `)];
}

function formatNestedSchema(schema: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent));
  }
  if (schema.items !== undefined) {
    lines.push(...formatProperty("items", schema.items, false, indent));
  }
  const properties = asObjectRecord(schema.properties);
  if (properties && !Array.isArray(schema.properties)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [];
    for (const [name, propSchema] of Object.entries(properties)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
  }

  return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: unknown[], indent: string): string[] {
  const lines = [`${indent}${keyword}:`];

  for (const variant of variants) {
    const s = asObjectRecord(variant);
    if (!s || Array.isArray(variant)) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }

    const formatted = formatType(s);
    const typeStr = formatted === "" ? "schema" : formatted;
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, s);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(s, `${indent}    `));
  }

  return lines;
}

function formatType(schema: Record<string, unknown>): string {
  if (Object.hasOwn(schema, "const")) {
    return `const ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => String(type)).join(" | ");
  }

  const type: unknown = schema.type;
  const hasType = Boolean(type);
  if (hasType) {
    return String(type);
  }

  const properties = asObjectRecord(schema.properties);
  if (properties && !Array.isArray(schema.properties)) {
    return "object";
  }

  if (schema.items !== undefined) {
    return "array";
  }

  return "";
}

function appendSchemaAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (typeof schema.description === "string" && schema.description !== "") {
    parts.push(`- ${schema.description}`);
  }

  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "format",
    "pattern",
  ] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }
}

function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "") // Remove leading underscores
    .replace(/_+$/, "") // Remove trailing underscores
    .toLowerCase();

  // Ensure we have a valid name
  if (result === "" || /^\d/.test(result)) {
    result = "resource" + (result !== "" ? "_" + result : "");
  }

  return result;
}
