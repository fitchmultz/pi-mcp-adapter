import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
});

describe("McpServerManager legacy handshake", () => {
  it.each([false, true])("keeps native auto stdio sibling probing and cleanup with trace=%s", async trace => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-legacy-trace-"));
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setTraceConfig({ enabled: trace, file: join(directory, "trace.jsonl") });
    try {
      const connection = await manager.connect("legacy", {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/legacy-no-discover-server.mjs", import.meta.url))],
        protocolVersion: "auto", requestTimeoutMs: 1000,
        env: { MCP_HANDSHAKE_PIDS: join(directory, "pids"), MCP_EXIT_ON_DISCOVER: "1" },
      });
      expect(connection.transport).toBeInstanceOf(StdioClientTransport);
      expect(connection.tools.map(tool => tool.name)).toEqual(["classic_initialize_reached"]);
      const pids = (await readFile(join(directory, "pids"), "utf8")).trim().split("\n").map(Number);
      expect(pids).toHaveLength(2);
      await manager.closeAll();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      if (trace) expect(await readFile(join(directory, "trace.jsonl"), "utf8")).toContain('"method":"initialize"');
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not advertise HTTP OAuth capabilities on a native stdio connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-capabilities-"));
    const manager = new McpServerManager(); managers.push(manager);
    try {
      const requestFile = join(directory, "initialize.json");
      const connection = await manager.connect("stdio-capabilities", {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/legacy-no-discover-server.mjs", import.meta.url))],
        oauth: { grantType: "client_credentials", clientId: "unused-http-client" },
        env: { MCP_HANDSHAKE_REQUEST: requestFile },
      });
      expect(connection.status).toBe("connected");
      expect(JSON.parse(await readFile(requestFile, "utf8")).params.capabilities.extensions).toBeUndefined();
    } finally {
      await manager.closeAll(); await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaches classic initialize when the server rejects server/discover", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    const connection = await manager.connect("legacy", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/legacy-no-discover-server.mjs", import.meta.url))],
    });

    expect(connection.status).toBe("connected");
    expect(connection.tools.map(tool => tool.name)).toEqual(["classic_initialize_reached"]);
  }, 5_000);
});
