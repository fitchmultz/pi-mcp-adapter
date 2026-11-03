import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import {
  ensureCallbackServer,
  stopCallbackServer,
  waitForCallback,
} from "../../mcp-callback-server.ts";
import { getOAuthCallbackPath, getOAuthCallbackPort } from "../../mcp-oauth-provider.ts";

afterEach(async () => {
  await stopCallbackServer();
});

it("serves a success page whose browser script closes the window after two seconds", async () => {
  await ensureCallbackServer();
  const callback = waitForCallback("success-page-state");
  const response = await fetch(
    `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}?code=page-code&state=success-page-state`,
  );
  expect(response.status).toBe(200);
  await expect(callback).resolves.toEqual({ code: "page-code" });
  const html = await response.text();

  // Execute the served bytes in jsdom's separate window realm, which has no Node globals.
  const scriptErrors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => scriptErrors.push(error));
  let close: MockInstance<() => void> | undefined;
  const started = performance.now();
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      close = vi.spyOn(window, "close");
    },
  });
  try {
    expect(dom.window.document.title).toBe("Pi - Authorization Successful");
    expect(close?.mock.calls).toEqual([]);
    // Settle on the first close or uncaught script error so each failure reports its own cause.
    await expect
      .poll(() => (close?.mock.calls.length ?? 0) + scriptErrors.length, {
        timeout: 4000,
        interval: 25,
        message: "the success page script neither closed the window nor failed",
      })
      .toBeGreaterThan(0);
    expect(scriptErrors).toEqual([]);
    expect(close?.mock.calls).toEqual([[]]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1950);
  } finally {
    dom.window.close();
  }
}, 10_000);
