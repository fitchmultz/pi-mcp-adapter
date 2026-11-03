import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "caps", version: "1" });
server.registerTool("caps", {}, function reportClientCapabilities() {
  // oxlint-disable-next-line typescript/no-deprecated -- QX-007: legacy stdio capabilities belong to initialize, not a request envelope.
  const capabilities = server.server.getClientCapabilities();
  assert(capabilities !== undefined, "Expected the native client's initialized capabilities");
  return { content: [{ type: "text", text: JSON.stringify(capabilities) }] };
});
await server.connect(new StdioServerTransport());
