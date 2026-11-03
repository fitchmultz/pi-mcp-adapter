import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { combineAbortSignals, createMcpRuntimeOwner, createOwnedUi } from "../runtime-owner.ts";

afterEach(() => vi.restoreAllMocks());

describe("MCP runtime ownership", () => {
  it("contains synchronous and asynchronous cleanup failures and is idempotent", async () => {
    const owner = createMcpRuntimeOwner();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // Expected cleanup failure is asserted below.
    });
    const cleanup = vi.fn<() => never>(() => {
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
  });

  it("refuses clean shutdown while a host callback's real promise is pending", async () => {
    const owner = createMcpRuntimeOwner();
    const gate = Promise.withResolvers<boolean>();
    const callback = owner.runCallback("onToolCall", async () => {
      await gate.promise;
    });
    const cleanup = vi.fn<() => void>();
    owner.addCleanup(cleanup);
    vi.spyOn(console, "error").mockImplementation(() => {
      // Expected pending callback failure.
    });
    try {
      await expect(owner.stop()).rejects.toThrow(AggregateError);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      gate.resolve(true);
      await callback;
    }
  });

  it("does not invoke nested UI methods after the owner stops", async () => {
    initTheme();
    const host = await createTestExtensionContext();
    const owner = createMcpRuntimeOwner();
    const ui = host.context.ui;
    const notify = vi.spyOn(ui, "notify");
    const fg = vi.spyOn(Theme.prototype, "fg");
    const owned = createOwnedUi(ui, owner);
    const theme = owned.theme;
    try {
      theme.fg("accent", "before");
      await owner.stop("reload");
      expect(Reflect.get(owned, "notify")).toBeUndefined();
      expect(Reflect.get(owned, "theme")).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(fg).toHaveBeenCalledTimes(1);
    } finally {
      await owner.stop();
      await host.dispose();
    }
  });

  it("does not read stale UI getters after the owner stops", async () => {
    const host = await createTestExtensionContext();
    const owner = createMcpRuntimeOwner();
    const ui = new Proxy(host.context.ui, {
      get(target, property): unknown {
        if (property === "notify") {
          throw new Error("stale getter");
        }
        return Reflect.get(target, property, target);
      },
    });
    const owned = createOwnedUi(ui, owner);
    try {
      await owner.stop("reload");
      expect(() => Reflect.get(owned, "notify")).not.toThrow();
      expect(Reflect.get(owned, "notify")).toBeUndefined();
    } finally {
      await owner.stop();
      await host.dispose();
    }
  });

  it("combines owner and context cancellation", async () => {
    const owner = createMcpRuntimeOwner();
    const context = new AbortController();
    const signal = combineAbortSignals(owner.signal, context.signal);
    expect(signal?.aborted).toBe(false);
    context.abort(new Error("context ended"));
    expect(signal?.aborted).toBe(true);
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
