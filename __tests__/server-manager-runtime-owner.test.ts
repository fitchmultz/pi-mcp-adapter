import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Client, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";
import { createManagerBoundaryHttp } from "./fixtures/strict-manager-boundaries-http.ts";
import { observeNativeConnections } from "./fixtures/strict-manager-boundaries-sdk.ts";
import type { resolveNpxBinary } from "../npx-resolver.ts";

vi.mock("@modelcontextprotocol/client", async () =>
  (await import("./fixtures/strict-manager-boundaries-sdk.ts")).nativeClientModule(),
);
vi.mock("@modelcontextprotocol/client/stdio", async () =>
  (await import("./fixtures/strict-manager-boundaries-sdk.ts")).nativeStdioModule(),
);

const resolution = vi.hoisted(() => ({
  gate: Promise.withResolvers<null>(),
  started: Promise.withResolvers<null>(),
}));
vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn<typeof resolveNpxBinary>(async () => {
    resolution.started.resolve(null);
    await resolution.gate.promise;
    return null;
  }),
}));

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  resolution.gate = Promise.withResolvers<null>();
  resolution.started = Promise.withResolvers<null>();
});
afterEach(async () => {
  resolution.gate.resolve(null);
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  } finally {
    vi.restoreAllMocks();
  }
});

async function setup(options: Parameters<typeof createManagerBoundaryHttp>[0] = {}) {
  const fixture = await createManagerBoundaryHttp(options);
  cleanups.push(fixture.close);
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  return { fixture, manager };
}

describe("MCP manager owner races", () => {
  it("closes a connection that finishes after owner shutdown before insertion", async () => {
    const gate = Promise.withResolvers<null>();
    const observed = observeNativeConnections(gate.promise);
    const { fixture, manager } = await setup();
    const owner = createMcpRuntimeOwner();
    manager.setRuntimeSignal(owner.signal);
    const connecting = manager.connect("demo", fixture.definition);
    await observed.entered.promise;
    const { client, transport, connected } = requireValue(observed.records[0]);
    const clientClose = vi.spyOn(client, "close");
    const transportClose = vi.spyOn(transport, "close");
    try {
      await connected.promise;
      await owner.stop("reload");
      gate.resolve(null);
      await expect(connecting).rejects.toThrow("reload");
      expect(manager.getAllConnections().size).toBe(0);
      expect(clientClose).not.toHaveBeenCalled();
      expect(transportClose).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(null);
    }
  });

  it("close aborts an in-flight connect and prevents late insertion", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager } = await setup({ holdInitialize: true });
    const connecting = manager.connect("demo", fixture.definition);
    await fixture.initializeStarted;
    await expect(manager.close("demo")).resolves.toBeUndefined();
    fixture.release();
    await expect(connecting).rejects.toThrow("connection demo was closed");
    expect(manager.getConnection("demo")).toBeUndefined();
    expect(observed.records).toHaveLength(1);
  });

  it("closeAll aborts pending connects and settles without late insertion", async () => {
    const { fixture, manager } = await setup({ holdInitialize: true });
    const connecting = manager.connect("demo", fixture.definition);
    await fixture.initializeStarted;
    await expect(manager.closeAll()).resolves.toBeUndefined();
    fixture.release();
    await expect(connecting).rejects.toThrow("MCP connection demo was closed");
    expect(manager.getAllConnections().size).toBe(0);
  });

  it("surfaces transport cleanup failures from an aborted pending connect", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager } = await setup({ holdInitialize: true });
    const connecting = manager.connect("demo", fixture.definition);
    await fixture.initializeStarted;
    const transport = requireValue(observed.records[0]).transport;
    const close = transport.close.bind(transport);
    const cleanupError = new Error("transport close failed");
    vi.spyOn(transport, "close").mockImplementationOnce(async () => {
      await close();
      throw cleanupError;
    });
    const settled = Promise.allSettled([connecting]);
    const closeAll = manager.closeAll();
    fixture.release();
    await expect(closeAll).rejects.toThrow("MCP manager cleanup failed");
    await expect(connecting).rejects.toThrow("MCP connection abort cleanup failed");
    const [outcome] = await settled;
    assert(outcome.status === "rejected" && outcome.reason instanceof AggregateError);
    const errors: unknown[] = outcome.reason.errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]).toHaveProperty("message", "MCP connection demo was closed");
    expect(errors[1]).toBe(cleanupError);
    expect(outcome.reason.cause).toBe(cleanupError);
    // Native close ran before the injected failure; terminal cleanup is already observed.
    cleanups.pop();
  });

  it("surfaces client cleanup failures after a non-abort setup error", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager } = await setup({ holdInitialize: true });
    vi.spyOn(Client.prototype, "listTools").mockRejectedValueOnce(new Error("connect failed"));
    const connecting = manager.connect("demo", fixture.definition);
    await fixture.initializeStarted;
    const client = requireValue(observed.records[0]).client;
    const close = client.close.bind(client);
    const clientClose = vi.spyOn(client, "close").mockImplementationOnce(async () => {
      await close();
      throw new Error("client close failed");
    });
    fixture.release();
    await expect(connecting).rejects.toThrow("MCP connection setup failed");
    expect(clientClose).toHaveBeenCalledTimes(1);
  });

  it("rejects connections after terminal manager shutdown", async () => {
    const observed = observeNativeConnections();
    const { fixture, manager } = await setup();
    await manager.closeAll();
    await expect(manager.connect("demo", fixture.definition)).rejects.toThrow(
      "MCP server manager is closed",
    );
    expect(observed.clients).toHaveLength(0);
    expect(observed.stdio).toHaveLength(0);
    expect(observed.records).toHaveLength(0);
    expect(fixture.initializes()).toBe(0);
  });

  it("does not create a stdio transport when npx resolution is cancelled", async () => {
    const observed = observeNativeConnections();
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    manager.setRuntimeSignal(owner.signal);
    const connecting = manager.connect("demo", { command: "npx", args: ["-y", "demo"] });
    await resolution.started.promise;
    expect(observed.clients).toHaveLength(1);
    expect(observed.stdio).toHaveLength(0);
    expect(observed.records).toHaveLength(0);
    await owner.stop("shutdown");
    resolution.gate.resolve(null);
    await expect(connecting).rejects.toThrow("shutdown");
    expect(observed.stdio).toHaveLength(0);
    expect(observed.records).toHaveLength(0);
  });

  it.each(["abort", "clear-config"])(
    "cancels URL elicitation when %s happens during the handler import",
    async (change) => {
      const native = await createTestExtensionContext();
      cleanups.push(native.dispose);
      const controller = new AbortController();
      const ui = {
        ...native.context.ui,
        select: vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Decline"),
        input: vi.fn<ExtensionUIContext["input"]>(),
        notify: vi.fn<ExtensionUIContext["notify"]>(),
      };
      const manager = new McpServerManager();
      cleanups.push(() => manager.closeAll());
      manager.setRuntimeSignal(controller.signal);
      manager.setElicitationConfig({ allowUrl: true, ui });
      const pending = manager.handleUrlElicitationRequired(
        "demo",
        new UrlElicitationRequiredError([
          {
            mode: "url",
            message: "Connect your account",
            elicitationId: "cancel-during-import",
            url: "https://example.test/connect",
          },
        ]),
      );
      // Even a cached dynamic import yields; ownership changes before it resumes.
      if (change === "abort") {
        controller.abort(new Error("owner stopped during import"));
      } else {
        manager.setElicitationConfig(undefined);
      }
      await expect(pending).resolves.toBe("cancel");
      expect(ui.select).not.toHaveBeenCalled();
      expect(ui.input).not.toHaveBeenCalled();
      expect(ui.notify).not.toHaveBeenCalled();
    },
  );
});
