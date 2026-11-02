import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  { name: "output-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));
server.setRequestHandler("tools/call", async ({ params }) => {
  const text = params.arguments?.text;
  return {
    content: [{ type: "text", text: String(text) }],
    structuredContent: { echo: text },
  };
});
server.setRequestHandler("resources/list", async () => ({
  resources: [{ name: "large", uri: "test://large", mimeType: "text/plain" }],
}));
server.setRequestHandler("resources/read", async () => ({
  contents: [{ uri: "test://large", text: "resource\n".repeat(10_000) }],
}));
await server.connect(new StdioServerTransport());
