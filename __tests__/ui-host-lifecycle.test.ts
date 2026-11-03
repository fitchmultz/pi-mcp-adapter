import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { closeHosts, openHost } from "./fixtures/host-runtime.ts";

afterEach(closeHosts);

async function expectCompletionFallback(host: Awaited<ReturnType<typeof openHost>>) {
  await vi.waitFor(() => expect(host.closeAttempts()).toBe(1));
  host.clock.advance(1_000);
  expect(host.element("completion-overlay").classList.contains("visible")).toBe(true);
  expect(host.element("status").textContent).toBe("Complete");
}

it("stops heartbeats immediately when the server replaces the session", async () => {
  const host = await openHost();
  host.clock.advance(10_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200]);

  host.handle.close("replaced");
  expect(await host.eventSource.completed.promise).toEqual({ reason: "replaced" });
  await host.teardownStarted;
  expect(host.completions).toEqual(["replaced"]);

  host.clock.advance(30_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(1);
  expect(host.eventSource.closed).toBe(true);

  host.element("done-btn").click();
  host.element("cancel-btn").click();
  expect(host.teardowns).toHaveLength(1);
  expect(host.requests("/proxy/ui/complete")).toHaveLength(0);

  host.respondToTeardowns();
  await vi.waitFor(() => expect(host.closeAttempts()).toBe(1));
  host.document.dispatchEvent(new host.window.Event("visibilitychange"));
  expect(host.element("completion-overlay").classList.contains("visible")).toBe(true);
  await expectCompletionFallback(host);
});

it.each(["done", "cancel"] as const)(
  "finishes %s from the server event without waiting for the POST response",
  async (reason) => {
    const host = await openHost({ holdCompletion: "response" });
    host.clock.advance(10_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200]);

    host.element(`${reason}-btn`).click();
    expect(await host.eventSource.completed.promise).toEqual({ reason });
    await host.teardownStarted;
    await host.settleRequests();
    expect(host.completions).toEqual([reason]);
    expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([200]);
    expect(host.teardowns).toHaveLength(1);
    expect(host.eventSource.closed).toBe(true);

    host.clock.advance(30_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(1);
    host.respondToTeardowns();
    await expectCompletionFallback(host);

    host.releaseCompletion();
    expect(host.teardowns).toHaveLength(1);
    expect(host.closeAttempts()).toBe(1);
  },
);

it.each(["done", "cancel"] as const)(
  "finishes %s through its POST after the SSE connection is interrupted",
  async (reason) => {
    const host = await openHost();
    await host.eventSource.disconnect();
    expect(host.eventSource.request.destroyed).toBe(true);
    expect(host.eventSource.closed).toBe(false);
    expect(host.element("status").textContent).toBe("Connection lost");

    host.clock.advance(10_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200]);

    host.element(`${reason}-btn`).click();
    await host.teardownStarted;
    await host.settleRequests();
    expect(host.completions).toEqual([reason]);
    expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([200]);
    expect(host.eventSource.terminalEvents).toBe(0);
    expect(host.eventSource.closed).toBe(true);
    expect(host.teardowns).toHaveLength(1);

    host.clock.advance(30_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(1);
    host.respondToTeardowns();
    host.element(`${reason}-btn`).click();
    expect(host.requests("/proxy/ui/complete")).toHaveLength(1);
    expect(host.teardowns).toHaveLength(1);
    await expectCompletionFallback(host);
  },
);

it("keeps heartbeats while a local completion request is unconfirmed", async () => {
  const host = await openHost({ holdCompletion: "request" });
  host.element("done-btn").click();
  host.element("done-btn").click();
  host.element("cancel-btn").click();
  expect(host.eventSource.closed).toBe(false);

  host.clock.advance(30_000);
  await host.settleRequests("/proxy/ui/heartbeat");
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([
    200, 200, 200,
  ]);
  expect(host.completions).toEqual([]);
  expect(host.teardowns).toHaveLength(0);

  host.releaseCompletion();
  await host.teardownStarted;
  await host.settleRequests();
  expect(host.completions).toEqual(["done"]);
  expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([200]);
  expect(host.teardowns).toHaveLength(1);

  host.respondToTeardowns();
  await expectCompletionFallback(host);
});

it("reports a failed completion response without replaying an accepted operation", async () => {
  const host = await openHost({ failCompletion: true, holdCompletion: "response" });
  host.element("done-btn").click();
  expect(await host.eventSource.completed.promise).toEqual({ reason: "done" });
  await host.teardownStarted;
  await host.settleRequests();
  expect(host.completions).toEqual(["done"]);
  expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([500]);

  host.respondToTeardowns();
  await expectCompletionFallback(host);
  host.releaseCompletion();
  host.element("done-btn").click();
  expect(host.teardowns).toHaveLength(1);
  expect(host.requests("/proxy/ui/complete")).toHaveLength(1);
  await vi.waitFor(() =>
    expect(
      host.consoleErrors.some((args) =>
        args.some((arg) => String(arg).includes("Completion callback failed")),
      ),
    ).toBe(true),
  );
  expect(host.element("error-overlay").classList.contains("visible")).toBe(false);
  expect(host.element("completion-overlay").classList.contains("visible")).toBe(true);
  expect(host.closeAttempts()).toBe(1);
});

it("keeps active heartbeats and the watchdog after the SSE connection is interrupted", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const host = await openHost();
  await host.eventSource.disconnect();
  expect(host.eventSource.request.destroyed).toBe(true);
  expect(host.element("status").textContent).toBe("Connection lost");

  for (let i = 0; i < 7; i += 1) {
    host.clock.advance(10_000);
    await host.settleRequests();
    vi.advanceTimersByTime(10_000);
  }
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual(
    Array(7).fill(200),
  );
  expect(host.completions).toEqual([]);

  vi.advanceTimersByTime(65_000);
  expect(host.completions).toEqual(["stale"]);
});

it("finishes without logging when teardown is not implemented", async () => {
  const host = await openHost();
  host.handle.close("replaced");
  await host.eventSource.completed.promise;
  await host.teardownStarted;
  host.respondToTeardowns({ code: -32601, message: "Method not found" });
  await expectCompletionFallback(host);
  expect(host.consoleErrors).toEqual([]);
  host.clock.advance(20_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(0);
});

it("logs a rejected teardown and still finishes", async () => {
  const host = await openHost();
  host.handle.close("replaced");
  await host.eventSource.completed.promise;
  await host.teardownStarted;
  host.respondToTeardowns({ code: -32603, message: "Teardown rejected" });
  await expectCompletionFallback(host);
  expect(host.consoleErrors).toHaveLength(1);
  const logged = host.consoleErrors[0];
  assert(logged);
  expect(logged[0]).toBe("[host] Resource teardown failed:");
  expect(logged[1]).toEqual(expect.objectContaining({ code: -32603 }));
  expect(String(logged[1])).toContain("Teardown rejected");
  host.clock.advance(20_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(0);
});
