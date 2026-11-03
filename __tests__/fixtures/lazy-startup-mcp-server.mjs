import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const eventsPath = process.env.MCP_STARTUP_FIXTURE_EVENTS;
const name = process.env.MCP_STARTUP_FIXTURE_NAME;
if (eventsPath === undefined || eventsPath === "" || name === undefined || name === "") {
  throw new Error("Missing lazy-startup fixture environment");
}
await appendFile(eventsPath, `${JSON.stringify({ event: "spawn", server: name })}\n`);
// If a timed-out harness is terminated, close this fixture on its stdio EOF too.
process.stdin.on("end", () => process.exit(0));

const server = new McpServer({ name: "lazy-startup-fixture", version: "1.0.0" });
server.server.registerCapabilities({ tools: {}, resources: {}, prompts: {} });
server.server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a local argument",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));
server.server.setRequestHandler("resources/list", async () => ({ resources: [] }));
server.server.setRequestHandler("prompts/list", async () => ({ prompts: [] }));
server.server.setRequestHandler("tools/call", async (request) => {
  const text = request.params.arguments?.text;
  if (request.params.name !== "echo" || typeof text !== "string") {
    throw new Error("Invalid echo call");
  }
  await appendFile(eventsPath, `${JSON.stringify({ event: "call", server: name, text })}\n`);
  return { content: [{ type: "text", text: `${name}: ${text}` }] };
});
await server.connect(new StdioServerTransport());
