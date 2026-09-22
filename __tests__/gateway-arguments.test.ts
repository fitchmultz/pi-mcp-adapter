import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { gatewayParameters, prepareGatewayArguments } from "../gateway-arguments.ts";

it("advertises explicit actions and validates each action's required fields", () => {
  expect(Value.Check(gatewayParameters, { action: "status" })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "call" })).toBe(false);
  expect(Value.Check(gatewayParameters, { action: "call", tool: "demo", args: {} })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "read-resource", server: "demo" })).toBe(false);
  expect(Value.Check(gatewayParameters, { action: "read-result", ref: "saved", limit: 2000 })).toBe(true);
  expect(Value.Check(gatewayParameters, { action: "list", server: "demo", limit: 101 })).toBe(false);
  expect(Value.Check(gatewayParameters, { search: "old" })).toBe(false);
});

it("prepares stored v5 calls without advertising the old precedence schema", () => {
  expect(prepareGatewayArguments({})).toEqual({ action: "status" });
  expect(prepareGatewayArguments({ search: "issues", server: "demo" })).toEqual({ action: "search", query: "issues", server: "demo" });
  expect(prepareGatewayArguments({ describe: "demo_find" })).toEqual({ action: "describe", tool: "demo_find" });
  expect(prepareGatewayArguments({ tool: "demo_find", args: '{"query":"q"}' })).toEqual({ action: "call", tool: "demo_find", args: { query: "q" } });
  expect(prepareGatewayArguments({ connect: "demo" })).toEqual({ action: "connect", server: "demo" });
  expect(() => prepareGatewayArguments({ action: "read-resource", server: "demo" })).toThrow("uri");
  expect(() => prepareGatewayArguments({ tool: "demo", args: "[]" })).toThrow("JSON object");
});
