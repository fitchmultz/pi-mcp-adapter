import { Type } from "typebox";
import { MAX_PAGE_SIZE, MAX_TOOL_NAME_LENGTH } from "./search-ranking.ts";

const actions = ["status", "search", "list", "describe", "call", "connect", "instructions", "resources", "read-resource", "read-result", "auth-start", "auth-complete", "ui-messages"] as const;
export type GatewayArguments = {
  action: typeof actions[number];
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
  search: ["query"], list: ["server"], describe: ["tool"], call: ["tool"],
  connect: ["server"], instructions: ["server"], resources: ["server"],
  "read-resource": ["server", "uri"], "read-result": ["ref"], "auth-start": ["server"], "auth-complete": ["server"],
};

export const gatewayParameters = Type.Object({
  action: Type.Unsafe<GatewayArguments["action"]>({ type: "string", enum: [...actions] }),
  server: Type.Optional(Type.String({ description: "MCP server; required for server and resource actions." })),
  tool: Type.Optional(Type.String({ maxLength: MAX_TOOL_NAME_LENGTH, description: "Exact tool name for call or describe. Use server to disambiguate." })),
  args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Tool arguments, or {redirectUrl} for auth-complete." })),
  query: Type.Optional(Type.String({ description: "Search terms. Prefer mcp_search to discover and load tools." })),
  includeSchemas: Type.Optional(Type.Boolean({ description: "Include complete schemas in search results (default true)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Page size (default 12, max 100); for read-result, characters of selected JSON." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based item offset; for read-result, character offset in selected JSON." })),
  uri: Type.Optional(Type.String({ description: "Exact MCP resource URI for read-resource." })),
  ref: Type.Optional(Type.String({ description: "Saved result reference returned by an earlier MCP call; read-result never calls the server again." })),
  path: Type.Optional(Type.String({ description: "JSON Pointer into a saved result, e.g. /structuredContent/rows." })),
  fields: Type.Optional(Type.Array(Type.String(), { description: "Immediate object fields to retain when reading a saved result." })),
}, {
  additionalProperties: false,
  allOf: [
    ...Object.entries(requirements).map(([action, required]) => ({ if: { properties: { action: { const: action } } }, then: { required } })),
    { if: { properties: { action: { enum: ["search", "list", "connect", "resources"] } } }, then: { properties: { limit: { maximum: MAX_PAGE_SIZE } } } },
  ],
});

/** Migrate stored v5 calls before host validation; the advertised schema stays explicit. */
export function prepareGatewayArguments(input: unknown): GatewayArguments {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP arguments must be an object");
  const value = input as Record<string, unknown>;
  let action = value.action;
  const result = { ...value };
  if (action === undefined) {
    action = value.tool ? "call" : value.connect ? "connect" : value.describe ? "describe" : value.instructions ? "instructions" : value.search !== undefined ? "search" : value.server ? "list" : "status";
    if (action === "connect") result.server = value.connect;
    if (action === "describe") result.tool = value.describe;
    if (action === "instructions") result.server = value.instructions;
    if (action === "search") result.query = value.search;
  }
  for (const key of ["connect", "describe", "instructions", "search"]) delete result[key];
  if (!actions.includes(action as GatewayArguments["action"])) throw new Error(`Unknown MCP action: ${String(action)}`);
  result.action = action;
  if (typeof result.args === "string") {
    result.args = result.args === "" ? undefined : JSON.parse(result.args);
  }
  if (result.args !== undefined && (!result.args || typeof result.args !== "object" || Array.isArray(result.args))) {
    throw new Error("Invalid args: expected a JSON object");
  }
  for (const field of requirements[action as GatewayArguments["action"]] ?? []) {
    if (typeof result[field] !== "string" || (field !== "query" && result[field] === "")) throw new Error(`${action} requires ${field}`);
  }
  return result as GatewayArguments;
}
