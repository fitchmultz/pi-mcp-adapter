import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const instructions = process.env.MCP_TEST_INSTRUCTIONS;
const server = new McpServer(
  { name: "mcp-code-server", version: "1.0.0" },
  instructions !== undefined && instructions !== "" ? { instructions } : {},
);
server.server.registerCapabilities({ tools: {} });

server.server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: {} },
      },
    },
    {
      name: "fail",
      description: "Return an MCP tool error",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hang",
      description: "Never resolves",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.server.setRequestHandler("tools/call", async function callTool(request) {
  if (request.params.name === "fail") {
    return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  }
  if (request.params.name === "hang") {
    return new Promise(() => {
      // Remain pending until the native client cancels or closes its transport.
    });
  }
  // oxlint-disable-next-line typescript/no-base-to-string -- QX-031: preserve native coercion of arbitrary echo values.
  const echoText = String(request.params.arguments?.value ?? "");
  return {
    content: [{ type: "text", text: echoText }],
    structuredContent: { echoed: request.params.arguments?.value },
  };
});

await server.connect(new StdioServerTransport());
