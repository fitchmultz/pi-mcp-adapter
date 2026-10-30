import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const [phasePath, callsPath] = process.argv.slice(2);
let phase = existsSync(phasePath) ? 1 : 0;
const server = new Server(
  { name: "search-catalog-server", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "probe",
      description: "Read the current catalog phase",
      inputSchema: { type: "object", properties: { value: { type: "string", description: phase ? "quartz" : "saffron" } } },
      annotations: { readOnlyHint: true },
    },
    { name: "advance", description: "Update the catalog", inputSchema: { type: "object", properties: {} } },
    {
      name: "hidden",
      description: "indigo discovery",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: phase ? ["model", "app"] : ["app"] } },
    },
  ],
}));

server.setRequestHandler("resources/list", async () => ({
  resources: [{ name: "reference", uri: phase ? "fixture://new" : "fixture://old", description: `Resource ${phase}` }],
}));

server.setRequestHandler("resources/read", async request => {
  const uri = phase ? "fixture://new" : "fixture://old";
  if (request.params.uri !== uri) throw new Error("Resource not found");
  return { contents: [{ uri, mimeType: "text/plain", text: `resource ${phase}` }] };
});

server.setRequestHandler("tools/call", async request => {
  const { name } = request.params;
  appendFileSync(callsPath, `${name}\n`);
  if (name === "advance") {
    phase = 1;
    writeFileSync(phasePath, "1");
    await server.sendToolListChanged();
    await server.sendResourceListChanged();
    return { content: [{ type: "text", text: "catalog updated" }] };
  }
  if (name !== "probe" && !(name === "hidden" && phase)) throw new Error("Tool not found");
  return { content: [{ type: "text", text: `${name} ${phase}` }] };
});

process.stdin.on("end", () => process.exit(0));
await server.connect(new StdioServerTransport());
