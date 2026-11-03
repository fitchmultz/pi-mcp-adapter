import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const eventsPath = process.env.MCP_STARTUP_FIXTURE_EVENTS;
const name = process.env.MCP_STARTUP_FIXTURE_NAME;
if (
  eventsPath === undefined ||
  eventsPath.length === 0 ||
  name === undefined ||
  name.length === 0
) {
  throw new Error("Missing lazy-startup fixture environment");
}
await appendFile(eventsPath, `${JSON.stringify({ event: "spawn", server: name })}\n`);
// If a timed-out harness is terminated, close this fixture on its stdio EOF too.
process.stdin.on("end", () => process.exit(0));

const server = new McpServer(
  { name: "lazy-startup-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);
server.registerTool(
  "echo",
  { description: "Echo a local argument", inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => {
    await appendFile(eventsPath, `${JSON.stringify({ event: "call", server: name, text })}\n`);
    return { content: [{ type: "text", text: `${name}: ${text}` }] };
  },
);
await server.connect(new StdioServerTransport());
