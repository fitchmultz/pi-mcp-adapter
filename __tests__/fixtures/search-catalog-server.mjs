import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const [phasePath, callsPath] = process.argv.slice(2);
if (phasePath === undefined || callsPath === undefined) {
  throw new Error("search-catalog-server requires <phasePath> <callsPath>");
}
let phase = existsSync(phasePath) ? 1 : 0;
const server = new McpServer({ name: "search-catalog-server", version: "1.0.0" });
server.server.registerCapabilities({
  tools: { listChanged: true },
  resources: { listChanged: true },
});

server.server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "probe",
      description: "Read the current catalog phase",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", description: phase === 1 ? "quartz" : "saffron" } },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "advance",
      description: "Update the catalog",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hidden",
      description: "indigo discovery",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: phase === 1 ? ["model", "app"] : ["app"] } },
    },
  ],
}));

server.server.setRequestHandler("resources/list", async () => ({
  resources: [
    {
      name: "reference",
      uri: phase === 1 ? "fixture://new" : "fixture://old",
      description: `Resource ${phase}`,
    },
  ],
}));

server.server.setRequestHandler("resources/read", async (request) => {
  const uri = phase === 1 ? "fixture://new" : "fixture://old";
  if (request.params.uri !== uri) {
    throw new Error("Resource not found");
  }
  return { contents: [{ uri, mimeType: "text/plain", text: `resource ${phase}` }] };
});

server.server.setRequestHandler("tools/call", async (request) => {
  const { name } = request.params;
  appendFileSync(callsPath, `${name}\n`);
  if (name === "advance") {
    phase = 1;
    writeFileSync(phasePath, "1");
    await server.server.sendToolListChanged();
    await server.server.sendResourceListChanged();
    return { content: [{ type: "text", text: "catalog updated" }] };
  }
  if (name !== "probe" && !(name === "hidden" && phase === 1)) {
    throw new Error("Tool not found");
  }
  return { content: [{ type: "text", text: `${name} ${phase}` }] };
});

process.stdin.on("end", () => process.exit(0));
await server.connect(new StdioServerTransport());
