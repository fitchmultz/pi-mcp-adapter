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
  const writeAndCrash = async (reason: string): Promise<never> => {
    await new Promise<void>((resolve) => {
      process.stderr.write(reason, () => resolve());
    });
    process.exit(1);
  };
  server.registerTool("echo", {}, () => ({ content: [{ type: "text", text: "ok" }] }));
  if (mode === "crash-mid-session") {
    server.registerTool("crash", {}, async () =>
      writeAndCrash("FATAL: database handle\x1b]52;c;secret\x07 corrupted\nstack frame 2\n"),
    );
    server.registerTool("warn", {}, async () => {
      await new Promise<void>((resolve) => {
        process.stderr.write("benign startup warning\n", () => resolve());
      });
      return { content: [{ type: "text", text: "warned" }] };
    });
    server.registerResource("rpc-error-doc", "docs://rpc-error", {}, () => {
      throw new Error("Database not connected");
    });
    server.registerResource("crash-doc", "docs://crash", {}, async () =>
      writeAndCrash("FATAL: resource reader crashed\n"),
    );
  }
  await server.connect(new StdioServerTransport());
}
