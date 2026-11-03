import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "cwd-observer", version: "1" });
server.registerTool("cwd", {}, () => ({
  content: [{ type: "text", text: process.cwd() }],
}));
await server.connect(new StdioServerTransport());
