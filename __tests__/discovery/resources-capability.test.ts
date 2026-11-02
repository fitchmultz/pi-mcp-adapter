import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerManager } from "../../server-manager.ts";

const managers: McpServerManager[] = [];

function createManager(): McpServerManager {
  const manager = new McpServerManager();
  managers.push(manager);
  return manager;
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

describe("resources capability negotiation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
    vi.restoreAllMocks();
  });

  it("skips resources/list for a real server without the capability", async () => {
    const listResources = vi.spyOn(Client.prototype, "listResources");
    const manager = createManager();
    const connection = await manager.connect("tools-only", {
      command: process.execPath,
      args: [fixture("tools-only-server.mjs")],
    });
    expect(connection.tools.map((tool) => tool.name)).toEqual(["noop"]);
    expect(connection.resources).toEqual([]);
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists resources from a real server advertising the capability", async () => {
    const listResources = vi.spyOn(Client.prototype, "listResources");
    const manager = createManager();
    const connection = await manager.connect("resources", {
      command: process.execPath,
      args: [fixture("output-server.mjs")],
    });
    expect(connection.resources).toEqual([
      { name: "large", uri: "test://large", mimeType: "text/plain" },
    ]);
    expect(listResources).toHaveBeenCalledTimes(1);
  });
});
