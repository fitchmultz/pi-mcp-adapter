import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const pidDirectory = process.env.MCP_RELOAD_PID_DIR;
const pidPath =
  pidDirectory !== undefined && pidDirectory !== ""
    ? join(pidDirectory, `${process.pid}.json`)
    : undefined;
const identity = { pid: process.pid, toolName: "reload_identity" };
if (pidPath !== undefined) {
  const pendingPath = `${pidPath}.tmp`;
  await writeFile(pendingPath, JSON.stringify(identity));
  await rename(pendingPath, pidPath);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}

const server = new McpServer({ name: "delayed-reload-fixture", version: "1.0.0" });
server.server.registerCapabilities({ tools: {}, resources: {} });
server.server.setRequestHandler("tools/list", async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  return {
    tools: [
      {
        name: identity.toolName,
        description: "reload identity",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});
server.server.setRequestHandler("resources/list", async () => ({ resources: [] }));
await server.connect(new StdioServerTransport());
