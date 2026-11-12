import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivationFixture } from "./fixtures/strict-activation-boundaries.ts";
import { McpServerManager } from "../server-manager.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";

let host: Awaited<ReturnType<typeof createActivationFixture>>;
beforeEach(async () => {
  host = await createActivationFixture();
});
afterEach(async () => {
  await host.dispose();
  vi.useRealTimers();
});

describe("initializeMcp vs. a ctx invalidated mid-connect", () => {
  it.each([
    {
      name: "does not reject once the session is disposed mid-connect — it should abandon quietly",
      message: undefined,
    },
    {
      name: "does not read guarded ctx getters again after startup connects",
      message: "unexpected ui failure",
    },
  ])("$name", async ({ message }) => {
    const wire = await host.wire();
    wire.delay("tools/list");
    const pending = host.initialize({
      config: {
        mcpServers: { demo: { ...wire.definition, lifecycle: "eager" } },
        settings: {},
      },
    });
    // Invalidate the actual SDK context only after native discovery is in flight.
    // Both its standard stale diagnostic and a nonstandard UI failure must remain unread.
    await expect.poll(wire.started).toBe(true);
    host.runner.invalidate(message);
    expect(() => host.context.hasUI).toThrow(message ?? "stale");
    wire.release();

    await expect(pending).resolves.toMatchObject({
      toolMetadata: new Map([["demo", [expect.objectContaining({ originalName: "echo" })]]]),
    });
    expect(wire.methods).toContain("tools/list");
  });
});

async function cancelledStartup() {
  const ready = await host.wire();
  const delayed = await host.wire();
  delayed.delay("tools/list");
  const controller = new AbortController();
  vi.spyOn(host.context, "signal", "get").mockReturnValue(controller.signal);
  const connects = vi.spyOn(McpServerManager.prototype, "connect");
  // Only the session's interval uses a fake clock; HTTP, cancellation and discovery stay native.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const initialization = host.initialize({
      config: {
        mcpServers: {
          ready: { ...ready.definition, lifecycle: "eager" },
          delayed: { ...delayed.definition, lifecycle: "keep-alive" },
        },
        settings: {},
      },
    });
    await expect.poll(delayed.started).toBe(true);
    await requireValue(connects.mock.results[0]).value;
    controller.abort(new Error("agent turn cancelled"));
    delayed.release();
    const state = await initialization;
    return state;
  } finally {
    delayed.release();
  }
}

describe("startup cancelled by an agent turn", () => {
  it("preserves completed metadata", async () => {
    const state = await cancelledStartup();
    expect(state.owner.isActive()).toBe(true);
    expect(state.failureMessages.size).toBe(0);
    expect(state.toolMetadata.get("ready")).toEqual([
      expect.objectContaining({ originalName: "echo" }),
    ]);
  });

  it("preserves session health checks", async () => {
    const state = await cancelledStartup();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => state.manager.getConnection("delayed")?.status).toBe("connected");
    expect(state.toolMetadata.get("delayed")).toEqual([
      expect.objectContaining({ originalName: "echo" }),
    ]);
  });
});
