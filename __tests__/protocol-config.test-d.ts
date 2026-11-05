import { expect, it, onTestFinished } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { createManagerBoundaryHttp } from "./fixtures/strict-manager-boundaries-http.ts";

async function fixture() {
  const http = await createManagerBoundaryHttp();
  const manager = new McpServerManager();
  onTestFinished(async () => {
    await manager.closeAll();
    await http.close();
  });
  return { http, manager };
}

it.each([
  { protocolVersion: "future" },
  { retryOnTransportFailure: "true" },
  { oauth: { skipIssuerMetadataValidation: "true" } },
])("rejects invalid in-memory protocol options before connecting: %j", async (invalid) => {
  const { http, manager } = await fixture();
  await expect(
    // @ts-expect-error Invalid protocol and OAuth option values must fail the typed connection API.
    manager.connect("invalid", { ...http.definition, ...invalid }),
  ).rejects.toThrow(/must be/);
  expect(http.requests).toHaveLength(0);
});

it("accepts correctly typed protocol options through the same connection boundary", async () => {
  const { http, manager } = await fixture();
  const connection = await manager.connect("valid", {
    ...http.definition,
    protocolVersion: "legacy",
    retryOnTransportFailure: true,
    oauth: { skipIssuerMetadataValidation: true },
  });
  expect(connection.status).toBe("connected");
  expect(http.initializes()).toBe(1);
});
