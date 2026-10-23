import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const eventsPath = process.env.MCP_STARTUP_FIXTURE_EVENTS;
const name = process.env.MCP_STARTUP_FIXTURE_NAME;
if (!eventsPath || !name) throw new Error("Missing lazy-startup fixture environment");
await appendFile(eventsPath, `${JSON.stringify({ event: "spawn", server: name })}\n`);
// If a timed-out harness is terminated, close this fixture on its stdio EOF too.
process.stdin.on("end", () => process.exit(0));

const server = new Server(
  { name: "lazy-startup-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);
server.setRequestHandler("tools/list", async () => ({
  tools: [{
    name: "echo", description: "Echo a local argument",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }],
}));
server.setRequestHandler("resources/list", async () => ({ resources: [] }));
server.setRequestHandler("prompts/list", async () => ({ prompts: [] }));
server.setRequestHandler("tools/call", async request => {
  const text = request.params.arguments?.text;
  if (request.params.name !== "echo" || typeof text !== "string") throw new Error("Invalid echo call");
  await appendFile(eventsPath, `${JSON.stringify({ event: "call", server: name, text })}\n`);
  return { content: [{ type: "text", text: `${name}: ${text}` }] };
});
await server.connect(new StdioServerTransport());
