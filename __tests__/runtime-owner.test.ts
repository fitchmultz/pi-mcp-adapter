import assert from "node:assert/strict";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { combineAbortSignals, createMcpRuntimeOwner, createOwnedUi } from "../runtime-owner.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP runtime ownership", () => {
  it("contains synchronous and asynchronous cleanup failures and is idempotent", async () => {
    const owner = createMcpRuntimeOwner();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Capture diagnostics without writing control sequences to the test terminal.
    });
    const cleanup = vi.fn<() => void>(() => {
      throw new Error("cleanup failed \u001b]52;c;secret\u0007");
    });
    owner.addCleanup(cleanup);
    const first = owner.stop("reload");
    const second = owner.stop("shutdown");

    await expect(first).rejects.toThrow(AggregateError);
    await expect(second).rejects.toThrow(AggregateError);
    expect(first).toBe(second);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("MCP: runtime cleanup failed: cleanup failed");
    consoleError.mockRestore();
  });

  it("refuses clean shutdown while a host callback's real promise is pending", async () => {
    const owner = createMcpRuntimeOwner();
    const { promise: gate, resolve: finish } = Promise.withResolvers<null>();
    const callback = owner.runCallback("onToolCall", async () => {
      await gate;
    });
    const cleanup = vi.fn<() => void>();
    owner.addCleanup(cleanup);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // The rejection and cleanup assertions own this expected diagnostic.
    });
    try {
      await expect(owner.stop()).rejects.toThrow(AggregateError);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      finish(null);
      await callback;
      consoleError.mockRestore();
    }
  });

  it("does not invoke nested UI methods after the owner stops", async () => {
    initTheme("dark");
    const owner = createMcpRuntimeOwner();
    const host = await createTestExtensionContext();
    try {
      const ui = host.context.ui;
      const notify = vi.spyOn(ui, "notify");
      const fg = vi.spyOn(Theme.prototype, "fg");
      const owned = createOwnedUi(ui, owner);
      const theme = owned.theme;
      const paint = theme.fg.bind(theme);

      paint("accent", "before");
      await owner.stop("reload");
      expect(typeof owned.notify).toBe("undefined");
      expect(owned.theme).toBeUndefined();
      expect(paint("accent", "after")).toBeUndefined();

      expect(notify).not.toHaveBeenCalled();
      expect(fg).toHaveBeenCalledTimes(1);
    } finally {
      await host.dispose();
    }
  });

  it("does not read stale UI getters after the owner stops", async () => {
    const owner = createMcpRuntimeOwner();
    const host = await createTestExtensionContext();
    try {
      const ui = { ...host.context.ui };
      Object.defineProperty(ui, "notify", {
        get: () => {
          throw new Error("stale getter");
        },
      });
      const owned = createOwnedUi(ui, owner);
      await owner.stop("reload");
      expect(() => typeof owned.notify).not.toThrow();
      expect(typeof owned.notify).toBe("undefined");
    } finally {
      await host.dispose();
    }
  });

  it("combines owner and context cancellation", async () => {
    const owner = createMcpRuntimeOwner();
    const context = new AbortController();
    const signal = combineAbortSignals(owner.signal, context.signal);
    assert(signal);
    expect(signal.aborted).toBe(false);
    context.abort(new Error("context ended"));
    expect(signal.aborted).toBe(true);
    await owner.stop("reload");
  });

  it("runs cleanup only after a late registration has been fenced", async () => {
    const owner = createMcpRuntimeOwner();
    await owner.stop("reload");
    const cleanup = vi.fn<() => void>();
    owner.addCleanup(cleanup);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
