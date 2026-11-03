import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/client";
/** @import { CallToolResult } from "@modelcontextprotocol/server" */

const mcp = new McpServer(
  { name: "elicitation-integration-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);
const server = mcp.server;

/** @returns {CallToolResult} */
function reportClientCapabilities() {
  // oxlint-disable-next-line typescript/no-deprecated -- QX-007: legacy stdio capabilities belong to initialize, not a request envelope.
  const capabilities = server.getClientCapabilities();
  assert(capabilities !== undefined, "Expected the native client's initialized capabilities");
  return {
    content: [{ type: "text", text: JSON.stringify(capabilities.elicitation ?? null) }],
  };
}

function urlRequiredError() {
  return new UrlElicitationRequiredError([
    {
      mode: "url",
      message: "Connect your account",
      elicitationId: "required-1",
      url: "https://example.com/connect",
    },
  ]);
}

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "capabilities", inputSchema: { type: "object", properties: {} } },
    { name: "form", inputSchema: { type: "object", properties: {} } },
    { name: "url", inputSchema: { type: "object", properties: {} } },
    { name: "url-required", inputSchema: { type: "object", properties: {} } },
    {
      name: "app",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { resourceUri: "ui://url-required" } },
    },
  ],
}));

server.setRequestHandler("resources/list", async () => ({
  resources: [
    { name: "URL-required resource", uri: "test://url-required" },
    { name: "URL-required UI resource", uri: "ui://url-required" },
  ],
}));

server.setRequestHandler("resources/read", async (request) => {
  if (request.params.uri === "test://url-required" || request.params.uri === "ui://url-required") {
    throw urlRequiredError();
  }
  return { contents: [] };
});

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "capabilities") {
    return reportClientCapabilities();
  }

  if (request.params.name === "url-required") {
    throw urlRequiredError();
  }

  if (request.params.name === "form") {
    const result = await server.request({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Provide a name",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", minLength: 1 } },
          required: ["name"],
        },
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (request.params.name === "url") {
    const result = await server.request({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Connect your account",
        elicitationId: "requested-1",
        url: "https://example.com/authorize",
      },
    });
    if (result.action === "accept") {
      for (const elicitationId of ["unknown", "requested-1", "requested-1"]) {
        await server.notification({
          method: "notifications/elicitation/complete",
          params: { elicitationId },
        });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
