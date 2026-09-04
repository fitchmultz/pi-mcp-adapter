import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  { name: "mcp-code-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list", async () => ({
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

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "fail") {
    return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  }
  if (request.params.name === "hang") {
    return new Promise(() => {});
  }
  return {
    content: [{ type: "text", text: String(request.params.arguments?.value ?? "") }],
    structuredContent: { echoed: request.params.arguments?.value },
  };
});

await server.connect(new StdioServerTransport());
