import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServerManager } from "../server-manager.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";
import { observeNativeConnections } from "./fixtures/strict-manager-boundaries-sdk.ts";

vi.mock("@modelcontextprotocol/client", async () =>
  (await import("./fixtures/strict-manager-boundaries-sdk.ts")).nativeClientModule(),
);
vi.mock("@modelcontextprotocol/client/stdio", async () =>
  (await import("./fixtures/strict-manager-boundaries-sdk.ts")).nativeStdioModule(),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  } finally {
    vi.restoreAllMocks();
  }
});
function manager(): McpServerManager {
  const instance = new McpServerManager();
  cleanups.push(() => instance.closeAll());
  return instance;
}
function stdio(mode: string) {
  return {
    command: process.execPath,
    args: [join(import.meta.dirname, "fixtures/strict-manager-boundaries-stdio.ts"), mode],
  };
}
async function connectionFailure(attempt: Promise<unknown>): Promise<Error> {
  const result = await Promise.allSettled([attempt]);
  const failure = requireValue(result[0]);
  assert.equal(failure.status, "rejected", "Connection must fail");
  const error: unknown = failure.reason;
  assert(error instanceof Error);
  return error;
}

describe("McpServerManager stderr capture", () => {
  it("pipes stderr for normal stdio servers and preserves inherit for debug", async () => {
    const observed = observeNativeConnections();
    const instance = manager();
    await instance.connect("demo", stdio("serve"));
    const normal = requireValue(observed.records[0]).transport;
    assert(normal instanceof StdioClientTransport);
    expect(normal.stderr).not.toBeNull();
    expect(requireValue(observed.stdio[0]).parameters.stderr).toBe("pipe");
    await instance.connect("debug", { ...stdio("serve"), debug: true });
    const debug = requireValue(observed.records[1]).transport;
    assert(debug instanceof StdioClientTransport);
    expect(debug.stderr).toBeNull();
    expect(requireValue(observed.stdio[1]).parameters.stderr).toBe("inherit");
  });

  it("appends captured stderr to the connection error", async () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    const error = await connectionFailure(manager().connect("loki", stdio("docker")));
    await expect(requireValue(connect.mock.results[0]).value).rejects.toBe(error.cause);
    assert(error.cause instanceof Error);
    expect(error.message).toBe(
      `${error.cause.message} (Cannot connect to the Docker daemon at unix:///var/run/docker.sock.)`,
    );
  });

  it("bounds oversized string stderr chunks before retaining their tail", async () => {
    const connectionError = new Error("connection failed");
    // A child pipe splits large writes into buffers. Inject one string event on
    // the native pre-start stream to cover the separate bounded-string branch.
    vi.spyOn(Client.prototype, "connect").mockImplementationOnce(async (transport) => {
      assert(transport instanceof StdioClientTransport);
      requireValue(transport.stderr).emit("data", "x".repeat(1_000_000));
      throw connectionError;
    });
    const error = await connectionFailure(manager().connect("demo", stdio("serve")));
    expect(error.cause).toBe(connectionError);
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(8192 + 100);
  });

  it("keeps connection errors unchanged without sending a redundant HTTP probe", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    vi.spyOn(Client.prototype, "connect").mockRejectedValue(
      new Error("MCP error -32000: Connection closed"),
    );
    const instance = manager();
    await expect(instance.connect("stdio", stdio("serve"))).rejects.toThrow(
      /^MCP error -32000: Connection closed$/,
    );
    await expect(instance.connect("http", { url: "https://example.com/mcp" })).rejects.toThrow(
      /^MCP error -32000: Connection closed$/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds captured stderr and keeps only its final three lines", async () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    const error = await connectionFailure(manager().connect("demo", stdio("tail")));
    await expect(requireValue(connect.mock.results[0]).value).rejects.toBe(error.cause);
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThan(8192 + 200);
    expect(error.message).toContain("line-2 — line-3 — line-4");
    expect(error.message).not.toContain("line-1");
    expect(error.cause).toBeInstanceOf(Error);
    assert(error.cause instanceof Error);
    expect(error.cause.message).toContain("Connection closed");
  });
});
