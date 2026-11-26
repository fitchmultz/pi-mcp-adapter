import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { parseToolCallArguments, validateToolArguments } from "@earendil-works/pi-ai";
import {
  gatewayParameters,
  prepareGatewayArguments,
  parseGatewayArguments,
} from "../gateway-arguments.ts";

it("advertises a flat action schema without redundant allOf and enforces cross-field rules clearly", () => {
  expect(gatewayParameters).not.toHaveProperty("allOf");
  expect(Value.Check(gatewayParameters, { action: "status" })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "call", tool: "demo", args: {} })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "read-resource", server: "demo" })).toBe(false);
  expect(Value.Check(gatewayParameters, { action: "prompts" })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "prompts", server: "demo", limit: 10 })).toBe(
    true,
  );
  expect(Value.Check(gatewayParameters, { action: "prompts", limit: 101 })).toBe(false);
  expect(Value.Check(gatewayParameters, { action: "get-prompt", server: "demo" })).toBe(false);
  expect(
    Value.Check(gatewayParameters, {
      action: "get-prompt",
      server: "demo",
      prompt: "brief",
      args: { topic: "mcp" },
    }),
  ).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "read-result", ref: "saved", limit: 2000 })).toBe(
    true,
  );
  expect(Value.Check(gatewayParameters, { search: "old" })).toBe(false);
  expect(Value.Check(gatewayParameters, { action: "status", unknownField: true })).toBe(false);

  expect(parseGatewayArguments({ action: "call", tool: "demo", format: "structured" }).format).toBe(
    "structured",
  );
  expect(
    parseGatewayArguments({ action: "read-result", ref: "saved", format: "structured" }).format,
  ).toBe("structured");
  expect(
    parseGatewayArguments({
      action: "read-result",
      ref: "saved",
      format: "structured",
      readAll: true,
    }).readAll,
  ).toBe(true);
  expect(
    parseGatewayArguments({
      action: "read-result",
      ref: "saved",
      readAll: false,
      offset: 0,
      limit: 100,
    }).readAll,
  ).toBe(false);
  expect(parseGatewayArguments({ action: "read-result", ref: "saved", limit: 2000 }).limit).toBe(
    2000,
  );

  const invalidCases: Array<[Record<string, unknown>, string]> = [
    [{ action: "call" }, "call requires tool"],
    [{ action: "read-resource", server: "demo" }, "read-resource requires uri"],
    [{ action: "list" }, "list requires server"],
    [{ action: "search" }, "search requires query"],
    [{ action: "describe" }, "describe requires tool"],
    [{ action: "connect" }, "connect requires server"],
    [{ action: "instructions" }, "instructions requires server"],
    [{ action: "resources" }, "resources requires server"],
    [{ action: "read-result" }, "read-result requires ref"],
    [{ action: "auth-start" }, "auth-start requires server"],
    [{ action: "auth-complete" }, "auth-complete requires server"],
    [{ action: "list", server: "demo", limit: 101 }, "list limit must be at most 100"],
    [{ action: "search", query: "q", limit: 101 }, "search limit must be at most 100"],
    [{ action: "connect", server: "demo", limit: 101 }, "connect limit must be at most 100"],
    [{ action: "resources", server: "demo", limit: 101 }, "resources limit must be at most 100"],
    [
      { action: "status", format: "structured" },
      'format is only supported for "call" and "read-result" actions',
    ],
    [
      { action: "read-result", ref: "saved", readAll: true },
      'readAll requires format: "structured"',
    ],
    [
      { action: "call", tool: "demo", format: "structured", readAll: true },
      'readAll is only supported for the "read-result" action',
    ],
    [
      { action: "read-result", ref: "saved", format: "structured", readAll: true, offset: 0 },
      "readAll cannot be combined with offset or limit",
    ],
    [
      { action: "read-result", ref: "saved", format: "structured", readAll: true, limit: 100 },
      "readAll cannot be combined with offset or limit",
    ],
  ];

  for (const [input, message] of invalidCases) {
    expect(() => prepareGatewayArguments(input), JSON.stringify(input)).toThrow(message);
    expect(() => parseGatewayArguments(input), JSON.stringify(input)).toThrow(message);
  }
});

it("prepares stored v5 calls without advertising the old precedence schema", () => {
  expect(prepareGatewayArguments({})).toEqual({ action: "status" });
  expect(prepareGatewayArguments({ search: "issues", server: "demo" })).toEqual({
    action: "search",
    query: "issues",
    server: "demo",
  });
  expect(prepareGatewayArguments({ describe: "demo_find" })).toEqual({
    action: "describe",
    tool: "demo_find",
  });
  expect(prepareGatewayArguments({ tool: "demo_find", args: '{"query":"q"}' })).toEqual({
    action: "call",
    tool: "demo_find",
    args: { query: "q" },
  });
  expect(prepareGatewayArguments({ connect: "demo" })).toEqual({
    action: "connect",
    server: "demo",
  });
  expect(() => prepareGatewayArguments({ action: "read-resource", server: "demo" })).toThrow("uri");
  expect(() => prepareGatewayArguments({ action: "get-prompt", server: "demo" })).toThrow("prompt");
  expect(() => prepareGatewayArguments({ action: "get-prompt", prompt: "brief" })).toThrow(
    "server",
  );
  expect(
    prepareGatewayArguments({
      action: "get-prompt",
      server: "demo",
      prompt: "brief",
      args: '{"topic":"mcp"}',
    }),
  ).toEqual({
    action: "get-prompt",
    server: "demo",
    prompt: "brief",
    args: { topic: "mcp" },
  });
  expect(() => prepareGatewayArguments({ tool: "demo", args: "[]" })).toThrow("JSON object");
  expect(() => prepareGatewayArguments({ action: 5 })).toThrow("Unknown MCP action: 5");
  expect(() => prepareGatewayArguments({ action: "missing" })).toThrow(
    "Unknown MCP action: missing",
  );
});

it("preserves native schema coercion after gateway preparation", () => {
  const tool = { name: "mcp", description: "MCP gateway", parameters: gatewayParameters };
  const prepared = prepareGatewayArguments({
    action: "status",
    limit: "5",
    offset: "0",
    includeSchemas: "true",
    fields: "id",
    path: null,
  });
  const validated: unknown = validateToolArguments(tool, {
    type: "toolCall",
    id: "coercion",
    name: "mcp",
    ...parseToolCallArguments(JSON.stringify(prepared)),
  });
  expect(parseGatewayArguments(validated)).toEqual({
    action: "status",
    limit: 5,
    offset: 0,
    includeSchemas: true,
    fields: ["id"],
  });
  // Coerced strings that violate action-level constraints are still caught by parseGatewayArguments.
  const coercedLimit: unknown = validateToolArguments(tool, {
    type: "toolCall",
    id: "coercion-limit",
    name: "mcp",
    ...parseToolCallArguments(
      JSON.stringify(prepareGatewayArguments({ action: "list", server: "demo", limit: "101" })),
    ),
  });
  expect(() => parseGatewayArguments(coercedLimit)).toThrow("list limit must be at most 100");
  expect(() => {
    validateToolArguments(tool, {
      type: "toolCall",
      id: "invalid",
      name: "mcp",
      ...parseToolCallArguments(
        JSON.stringify(prepareGatewayArguments({ action: "status", limit: "invalid" })),
      ),
    });
  }).toThrow('Validation failed for tool "mcp"');
});
