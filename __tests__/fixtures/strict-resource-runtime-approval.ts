import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "resource-runtime-approval", version: "1" });
server.registerTool(
  "search-records",
  {
    description: "Search records",
    inputSchema: z.object({ query: z.string().optional() }),
  },
  () => ({ content: [{ type: "text", text: "called" }] }),
);
await server.connect(new StdioServerTransport());
