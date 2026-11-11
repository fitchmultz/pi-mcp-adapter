import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";
import { ConsentManager } from "../../consent-manager.ts";
import { McpServerManager, type ServerConnection } from "../../server-manager.ts";

export function createConnection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    client: new Client({ name: "ui-boundary-test", version: "1" }),
    transport: new InMemoryTransport(),
    definition: { command: "ui-boundary-test" },
    status: "connected",
    tools: [{ name: "some_tool", inputSchema: { type: "object" } }],
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

export function createClient(overrides: Partial<Client> = {}): Client {
  return Object.assign(new Client({ name: "ui-boundary-test", version: "1" }), overrides);
}

export function createMockManager(overrides: Partial<McpServerManager> = {}): McpServerManager {
  const manager = new McpServerManager();
  const connection = createConnection();
  vi.spyOn(connection.client, "callTool").mockResolvedValue({
    content: [{ type: "text", text: "result" }],
  });
  vi.spyOn(manager, "getConnection").mockReturnValue(connection);
  vi.spyOn(manager, "touch");
  vi.spyOn(manager, "incrementInFlight");
  vi.spyOn(manager, "decrementInFlight");
  vi.spyOn(manager, "readResource");
  vi.spyOn(manager, "getRequestOptions");
  return Object.assign(manager, overrides);
}

export function createMockConsentManager(overrides: Partial<ConsentManager> = {}): ConsentManager {
  const consent = new ConsentManager();
  consent.registerDecision("test-server", true);
  vi.spyOn(consent, "registerDecision");
  vi.spyOn(consent, "ensureApproved");
  return Object.assign(consent, overrides);
}
