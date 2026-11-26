import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFailure,
  getFailureAgeSeconds,
  getFailureMessage,
  getFailureRemainingSeconds,
  recordFailure,
} from "../init.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { createMcpStatusSnapshot, type McpStatusEventBus } from "../mcp-status.ts";
import { createTestState } from "./test-state.ts";

describe("MCP failure state", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds messages, expires backoff exponentially, and retains diagnostics until clearFailure", () => {
    vi.useFakeTimers();
    const emit = vi.fn<McpStatusEventBus["emit"]>();
    const state = createTestState({
      config: { mcpServers: { demo: { command: "node" } } },
      statusEvents: { emit },
    });

    // 1st failure: 2s backoff
    recordFailure(state, "demo", "x".repeat(100_000));
    expect(state.failureMessages.get("demo")).toHaveLength(8 * 1024);
    expect(getFailureAgeSeconds(state, "demo")).toBe(0);
    expect(getFailureRemainingSeconds(state, "demo")).toBe(2);
    expect(getFailureMessage(state, "demo")).toHaveLength(8 * 1024);
    expect(createMcpStatusSnapshot(state).servers[0]?.status).toBe("failed");

    vi.advanceTimersByTime(1_999);
    expect(state.failureTracker.has("demo")).toBe(true);
    expect(getFailureRemainingSeconds(state, "demo")).toBe(1);

    vi.advanceTimersByTime(1);
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(getFailureAgeSeconds(state, "demo")).toBeNull();
    expect(getFailureRemainingSeconds(state, "demo")).toBeNull();
    // Diagnostic message survives backoff expiry until connect/reset.
    expect(state.failureMessages.get("demo")).toHaveLength(8 * 1024);
    expect(getFailureMessage(state, "demo")).toHaveLength(8 * 1024);
    expect(createMcpStatusSnapshot(state).servers[0]?.status).toBe("not-connected");
    expect(emit).toHaveBeenCalledTimes(1);

    // 2nd failure: 10s backoff
    recordFailure(state, "demo", "second failure");
    expect(getFailureRemainingSeconds(state, "demo")).toBe(10);
    vi.advanceTimersByTime(9_999);
    expect(state.failureTracker.has("demo")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(getFailureMessage(state, "demo")).toBe("second failure");

    // 3rd failure: 30s backoff
    recordFailure(state, "demo", "third failure");
    expect(getFailureRemainingSeconds(state, "demo")).toBe(30);
    vi.advanceTimersByTime(30_000);
    expect(state.failureTracker.has("demo")).toBe(false);

    // 4th and 5th failures: capped at 60s
    recordFailure(state, "demo", "fourth failure");
    expect(getFailureRemainingSeconds(state, "demo")).toBe(60);
    vi.advanceTimersByTime(60_000);
    expect(state.failureTracker.has("demo")).toBe(false);

    recordFailure(state, "demo", "fifth failure");
    expect(getFailureRemainingSeconds(state, "demo")).toBe(60);

    // Reset clears both backoff and retained message, restarting at 2s.
    clearFailure(state, "demo");
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(state.failureMessages.has("demo")).toBe(false);
    expect(getFailureMessage(state, "demo")).toBeNull();

    recordFailure(state, "demo", "fresh failure");
    expect(getFailureRemainingSeconds(state, "demo")).toBe(2);
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
