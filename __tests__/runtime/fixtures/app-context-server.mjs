import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({ name: "app-context-fixture", version: "1.0.0" });
const uri = "ui://selection/context.html";

registerAppTool(
  server,
  "open_selector",
  { description: "Open the selection app", _meta: { ui: { resourceUri: uri } } },
  async () => ({ content: [{ type: "text", text: "Selection app ready" }] }),
);
registerAppResource(server, "Selection app", uri, {}, async () => ({
  contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: "<main>Selection app</main>" }],
}));

await server.connect(new StdioServerTransport());
