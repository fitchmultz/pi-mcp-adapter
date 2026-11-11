import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFailure, getFailureAgeSeconds, getFailureMessage, recordFailure } from "../init.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { McpStatusEventBus } from "../mcp-status.ts";
import { createTestState } from "./test-state.ts";

describe("MCP failure state", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds messages and removes diagnostics after the backoff TTL", () => {
    vi.useFakeTimers();
    const state = createTestState();

    recordFailure(state, "demo", "x".repeat(100_000));

    expect(state.failureMessages.get("demo")).toHaveLength(8 * 1024);
    expect(getFailureAgeSeconds(state, "demo")).toBe(0);
    expect(getFailureMessage(state, "demo")).toHaveLength(8 * 1024);

    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.has("demo")).toBe(false);
    expect(state.failureMessages.has("demo")).toBe(false);
    expect(getFailureAgeSeconds(state, "demo")).toBeNull();
  });

  it("clears a prior expiry timer when a failure recovers", () => {
    vi.useFakeTimers();
    const state = createTestState();

    recordFailure(state, "demo", "failed");
    clearFailure(state, "demo");
    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.size).toBe(0);
    expect(state.failureMessages.size).toBe(0);
  });

  it("does not publish failure expiry after the runtime owner stops", async () => {
    vi.useFakeTimers();
    const owner = createMcpRuntimeOwner();
    const emit = vi.fn<McpStatusEventBus["emit"]>();
    const state = createTestState({ owner, statusEvents: { emit } });

    recordFailure(state, "demo", "failed");
    await owner.stop("session shutdown");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);

    expect(emit).not.toHaveBeenCalled();
  });
});
