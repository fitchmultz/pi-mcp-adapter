import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActivationFixture } from "./fixtures/strict-activation-boundaries.ts";

let host: Awaited<ReturnType<typeof createActivationFixture>>;
beforeEach(async () => {
  host = await createActivationFixture();
});
afterEach(async () => {
  await host.dispose();
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
