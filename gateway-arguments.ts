import { Type } from "typebox";
import { Value } from "typebox/value";
import { asObjectRecord } from "./mcp-output-values.ts";
import { MAX_PAGE_SIZE, MAX_TOOL_NAME_LENGTH } from "./search-ranking.ts";

const actions = [
  "status",
  "search",
  "list",
  "describe",
  "call",
  "connect",
  "instructions",
  "resources",
  "read-resource",
  "read-result",
  "auth-start",
  "auth-complete",
  "ui-messages",
] as const;
export type GatewayArguments = {
  action: (typeof actions)[number];
  server?: string;
  tool?: string;
  args?: Record<string, unknown>;
  query?: string;
  includeSchemas?: boolean;
  limit?: number;
  offset?: number;
  uri?: string;
  ref?: string;
  path?: string;
  fields?: string[];
};

const requirements: Partial<Record<GatewayArguments["action"], string[]>> = {
  search: ["query"],
  list: ["server"],
  describe: ["tool"],
  call: ["tool"],
  connect: ["server"],
  instructions: ["server"],
  resources: ["server"],
  "read-resource": ["server", "uri"],
  "read-result": ["ref"],
  "auth-start": ["server"],
  "auth-complete": ["server"],
};

export const gatewayParameters = Type.Object(
  {
    action: Type.Unsafe<GatewayArguments["action"]>({ type: "string", enum: [...actions] }),
    server: Type.Optional(
      Type.String({ description: "MCP server; required for server and resource actions." }),
    ),
    tool: Type.Optional(
      Type.String({
        maxLength: MAX_TOOL_NAME_LENGTH,
        description: "Exact tool name for call or describe. Use server to disambiguate.",
      }),
    ),
    args: Type.Optional(
      Type.Unsafe<Record<string, unknown>>(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description: "Tool arguments, or {redirectUrl} for auth-complete.",
          },
        ),
      ),
    ),
    query: Type.Optional(
      Type.String({ description: "Search terms. Prefer tool_search to load typed tools." }),
    ),
    includeSchemas: Type.Optional(
      Type.Boolean({ description: "Include complete schemas in search results (default true)." }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Page size (default 12, max 100); for read-result, characters of selected JSON.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Zero-based item offset; for read-result, character offset in selected JSON.",
      }),
    ),
    uri: Type.Optional(Type.String({ description: "Exact MCP resource URI for read-resource." })),
    ref: Type.Optional(
      Type.String({
        description:
          "Saved result reference returned by an earlier MCP call; read-result never calls the server again.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description: "JSON Pointer into a saved result, e.g. /structuredContent/rows.",
      }),
    ),
    fields: Type.Optional(
      Type.Array(Type.String(), {
        description: "Immediate object fields to retain when reading a saved result.",
      }),
    ),
  },
  {
    additionalProperties: false,
    allOf: [
      ...Object.entries(requirements).map(([action, required]) =>
        Type.Dependent(
          Type.Unsafe({ properties: { action: { const: action } } }),
          Type.Unsafe({ required }),
          Type.Unknown(),
        ),
      ),
      Type.Dependent(
        Type.Unsafe({
          properties: { action: { enum: ["search", "list", "connect", "resources"] } },
        }),
        Type.Unsafe({ properties: { limit: { maximum: MAX_PAGE_SIZE } } }),
        Type.Unknown(),
      ),
    ],
  },
);

function legacyAction(value: Record<string, unknown>): GatewayArguments["action"] {
  const aliases = [
    { field: "tool", action: "call" },
    { field: "connect", action: "connect" },
    { field: "describe", action: "describe" },
    { field: "instructions", action: "instructions" },
  ] satisfies Array<{ field: string; action: GatewayArguments["action"] }>;
  const match = aliases.find(({ field }) => Boolean(value[field]));
  if (match) {
    return match.action;
  }
  if (value.search !== undefined) {
    return "search";
  }
  const hasServer = Boolean(value.server);
  return hasServer ? "list" : "status";
}

function isAction(value: unknown): value is GatewayArguments["action"] {
  return actions.some((action) => action === value);
}

function migrateLegacy(
  value: Record<string, unknown>,
  action: GatewayArguments["action"],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  if (value.action === undefined) {
    const mappings: Partial<Record<GatewayArguments["action"], "server" | "tool" | "query">> = {
      connect: "server",
      describe: "tool",
      instructions: "server",
      search: "query",
    };
    const destination = mappings[action];
    if (destination !== undefined) {
      result[destination] = value[action];
    }
  }
  for (const key of ["connect", "describe", "instructions", "search"]) {
    delete result[key];
  }
  result.action = action;
  return result;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    parsed = value === "" ? undefined : JSON.parse(value);
  }
  if (parsed === undefined) {
    return;
  }
  const record = asObjectRecord(parsed);
  if (record === undefined || Array.isArray(parsed)) {
    throw new Error("Invalid args: expected a JSON object");
  }
  return record;
}

/** Migrate stored v5 calls before host validation; the advertised schema stays explicit. */
export function prepareGatewayArguments(input: unknown): Record<string, unknown> {
  const value = asObjectRecord(input);
  if (value === undefined || Array.isArray(input)) {
    throw new Error("MCP arguments must be an object");
  }
  const action: unknown = value.action === undefined ? legacyAction(value) : value.action;
  if (!isAction(action)) {
    throw new Error(`Unknown MCP action: ${String(action)}`);
  }
  const result = migrateLegacy(value, action);
  if (result.args !== undefined) {
    result.args = parseArgs(result.args);
  }
  validateRequirements(result, action);
  return result;
}

/** Narrow native-validated execution input without preempting the host's coercion step. */
export function parseGatewayArguments(input: unknown): GatewayArguments {
  if (!Value.Check(gatewayParameters, input)) {
    throw new Error("Invalid MCP arguments");
  }
  return input;
}

function validateRequirements(
  result: Record<string, unknown>,
  action: GatewayArguments["action"],
): void {
  for (const field of requirements[action] ?? []) {
    if (typeof result[field] !== "string" || (field !== "query" && result[field] === "")) {
      throw new Error(`${action} requires ${field}`);
    }
  }
}
