import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const [mode, port] = process.argv.slice(2);
if (mode === "hold-pipes" || mode === "no-read") {
  const socket = connect(Number(port), "127.0.0.1");
  socket.once("data", () => {
    socket.end();
    process.exit(0);
  });
  socket.on("error", (error) => {
    throw error;
  });
  if (mode === "no-read") {
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => {
      const message: unknown = JSON.parse(line);
      if (typeof message !== "object" || message === null || !("id" in message)) {
        return;
      }
      let result: unknown;
      if ("method" in message && message.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "backpressure", version: "1" },
        };
      } else if ("method" in message && message.method === "tools/list") {
        result = { tools: [] };
      } else {
        reader.pause();
        process.stdin.pause();
        result = { content: [{ type: "text", text: "stdin paused" }] };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    });
  }
} else {
  const keeper = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "hold-pipes", port ?? ""],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  keeper.once("spawn", () => process.exit(1));
  keeper.on("error", (error) => {
    throw error;
  });
}
