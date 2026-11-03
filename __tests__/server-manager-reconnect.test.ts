import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";
import { createManagerBoundaryHttp } from "./fixtures/strict-manager-boundaries-http.ts";
import { observeNativeConnections } from "./fixtures/strict-manager-boundaries-sdk.ts";

vi.mock("@modelcontextprotocol/client", async () =>
  (await import("./fixtures/strict-manager-boundaries-sdk.ts")).nativeClientModule(),
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

async function setup(holdInitialize = false) {
  const fixture = await createManagerBoundaryHttp({ holdInitialize });
  cleanups.push(fixture.close);
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  return { fixture, manager, def: fixture.definition };
}

describe("McpServerManager connections", () => {
  it("rejects a connection closed during optional discovery and allows a fresh attempt", async () => {
    const observed = observeNativeConnections();
    vi.spyOn(Client.prototype, "listResources").mockImplementationOnce(async function (
      this: Client,
    ) {
      // Finish required discovery before closing during the optional catalog.
      await this.listTools();
      await this.close();
      throw new Error("Connection closed");
    });
    const { manager, def } = await setup();
    await expect(manager.connect("remote", def)).rejects.toThrow("closed while connecting");
    expect(manager.getConnection("remote")).toBeUndefined();
    expect((await manager.connect("remote", def)).status).toBe("connected");
    expect(observed.records).toHaveLength(2);
  });

  it("keeps a shared initial connection alive when its first caller cancels", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager, def } = await setup(true);
    const controller = new AbortController();
    const reason = new Error("stop waiting");
    const first = manager.connect("remote", def, controller.signal);
    const second = manager.connect("remote", def);
    try {
      await fixture.initializeStarted;
      controller.abort(reason);
      await expect(first).rejects.toBe(reason);
      const third = manager.connect("remote", def);
      expect(observed.records).toHaveLength(1);
      fixture.release();
      const connection = await second;
      expect(connection).toBe(await third);
      expect(connection).toBe(manager.getConnection("remote"));
      expect(connection.status).toBe("connected");
      expect(fixture.initializes()).toBe(1);
    } finally {
      fixture.release();
    }
  });

  it("lets a new caller connect after the sole waiter cancels", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager, def } = await setup(true);
    const controller = new AbortController();
    const first = manager.connect("remote", def, controller.signal);
    try {
      await fixture.initializeStarted;
      controller.abort(new Error("stop waiting"));
      await expect(first).rejects.toThrow("stop waiting");
      const next = manager.connect("remote", def);
      fixture.release();
      expect((await next).status).toBe("connected");
      expect(observed.records).toHaveLength(2);
      expect(fixture.initializes()).toBe(2);
    } finally {
      fixture.release();
    }
  });

  it("is single-flight: concurrent reconnects for the same server share one underlying reconnect", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager, def } = await setup();
    const stale = await manager.connect("remote", def);
    const [c1, c2] = await Promise.all([
      manager.reconnect("remote", def, stale),
      manager.reconnect("remote", def, stale),
    ]);
    expect(c1).toBe(c2);
    expect(observed.records).toHaveLength(2);
    expect(fixture.initializes()).toBe(2);
    expect(manager.getConnection("remote")).toBe(c1);
  });

  it("identity guard: never tears down a connection it did not prove stale", async () => {
    const observed = observeNativeConnections();
    const { manager, def } = await setup();
    const stale = await manager.connect("remote", def);
    await manager.close("remote");
    const fresh = await manager.connect("remote", def);
    const close = vi.spyOn(fresh.client, "close");
    const result = await manager.reconnect("remote", def, stale);
    expect(result).toBe(fresh);
    expect(close).not.toHaveBeenCalled();
    expect(observed.records).toHaveLength(2);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("keeps a shared reconnect alive when one caller aborts waiting", async () => {
    const { fixture, manager, def } = await setup();
    const stale = await manager.connect("remote", def);
    const reason = new Error("stop waiting");
    const controller = new AbortController();
    const gate = Promise.withResolvers<null>();
    observeNativeConnections(gate.promise);
    try {
      const first = manager.reconnect("remote", def, stale, controller.signal);
      controller.abort(reason);
      await expect(first).rejects.toBe(reason);
      const second = manager.reconnect("remote", def, stale);
      gate.resolve(null);
      const fresh = await second;
      expect(fresh).not.toBe(stale);
      expect(manager.getConnection("remote")).toBe(fresh);
      expect(fixture.initializes()).toBe(2);
    } finally {
      gate.resolve(null);
    }
  });

  it("carries in-flight work from the stale connection to the fresh connection", async () => {
    const { manager, def } = await setup();
    const stale = await manager.connect("remote", def);
    stale.inFlight = 2;
    const fresh = await manager.reconnect("remote", def, stale);
    expect(fresh).not.toBe(stale);
    expect(fresh.inFlight).toBe(2);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("identity guard: a stale connection's late onclose does not clobber the fresh connection's status", async () => {
    const { manager, def } = await setup();
    const stale = await manager.connect("remote", def);
    const staleClose = requireValue(stale.client.onclose);
    const fresh = await manager.reconnect("remote", def, stale);
    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);
    staleClose();
    expect(fresh.status).toBe("connected");
    expect(manager.getConnection("remote")).toBe(fresh);
    await fresh.transport.close();
    expect(fresh.status).toBe("closed");
  });
});
