import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { McpServerManager } from "../server-manager.ts";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };

describe("McpServerManager connection close ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const __dirname = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
  it("closes a connected stdio transport exactly once via client.close", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const connection = await manager.connect("demo", definition);
    const clientCloseSpy = vi.spyOn(connection.client, "close");
    const transportCloseSpy = vi.spyOn(connection.transport, "close");

    await manager.close("demo");

    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpy).toHaveBeenCalledTimes(1);
    const clientOrder = clientCloseSpy.mock.invocationCallOrder[0];
    const transportOrder = transportCloseSpy.mock.invocationCallOrder[0];
    assert(clientOrder !== undefined && transportOrder !== undefined);
    expect(clientOrder).toBeLessThan(transportOrder);
  });

  it("keeps in-flight accounting on the connection a call started on", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const first = await manager.connect("demo", definition);
    manager.incrementInFlight(first);
    await manager.close("demo");
    manager.decrementInFlight(first);

    const second = await manager.connect("demo", definition);
    expect(manager.inFlightCount(second)).toBe(0);

    manager.incrementInFlight(second);
    manager.decrementInFlight(first);
    expect(manager.inFlightCount(second)).toBe(1);

    await manager.close("demo");
  });
});
