import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const mode = process.argv[2];
if (mode === "docker" || mode === "tail") {
  const stderr =
    mode === "docker"
      ? "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n"
      : `${"x".repeat(8192)}\nline-1\nline-2\nline-3\nline-4\n`;
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(stderr, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
} else {
  const server = new McpServer({ name: "manager-stderr", version: "1" });
  server.registerTool("echo", {}, () => ({ content: [{ type: "text", text: "ok" }] }));
  await server.connect(new StdioServerTransport());
}
