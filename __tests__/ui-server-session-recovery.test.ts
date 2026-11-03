import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startUiServer, type UiServerHandle, type UiServerOptions } from "../ui-server.ts";
import { createOAuthRecoveryFixture } from "./fixtures/oauth-recovery.ts";
import { request } from "./fixtures/strict-ui-boundaries-http.ts";
import { createMockConsentManager } from "./fixtures/strict-ui-boundaries-manager.ts";
import { UiBoundaryWire, connectUiBoundaryWire } from "./fixtures/strict-ui-boundaries-wire.ts";

const cleanups: Array<() => Promise<void>> = [];
let handle: UiServerHandle | undefined;
afterEach(async () => {
  handle?.close("test-cleanup");
  handle = undefined;
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
});

async function setup() {
  const wire = new UiBoundaryWire();
  const manager = await connectUiBoundaryWire(wire);
  cleanups.push(
    () => wire.close(),
    () => manager.closeAll(),
  );
  const stale = manager.getConnection("test-server");
  assert(stale);
  const callTool = vi.spyOn(stale.client, "callTool");
  const reconnect = vi.spyOn(manager, "reconnect");
  const config = { mcpServers: { "test-server": wire.definition() } };
  const options: UiServerOptions = {
    serverName: "test-server",
    toolName: "test_tool",
    toolArgs: {},
    resource: {
      uri: "ui://test/widget",
      html: "<h1>Test App</h1>",
      mimeType: "text/html",
      meta: { permissions: {} },
    },
    manager,
    config,
    consentManager: createMockConsentManager(),
  };
  wire.expired = true;
  return { wire, manager, stale, callTool, reconnect, config, options };
}

async function requestTool(server: UiServerHandle) {
  return request(`http://localhost:${server.port}/proxy/tools/call`, {
    method: "POST",
    body: { token: server.sessionToken, params: { name: "some_tool", arguments: {} } },
  });
}

describe("UiServer /proxy/tools/call session recovery", () => {
  it("recovers a terminated Streamable HTTP session transparently, when config is supplied", async () => {
    const fixture = await setup();
    handle = await startUiServer(fixture.options);
    const res = await requestTool(handle);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      result: { content: [{ type: "text", text: "tool result" }] },
    });
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.wire.calls.filter((call) => call.method === "tools/call")).toEqual([
      { method: "tools/call", session: "session-1" },
      { method: "tools/call", session: "session-2" },
    ]);
    expect(fixture.reconnect).toHaveBeenCalledWith(
      "test-server",
      fixture.config.mcpServers["test-server"],
      fixture.stale,
    );
  });

  it("returns auth guidance when recovery reconnect needs auth and no callback can refresh it", async () => {
    const fixture = await setup();
    const auth = await createOAuthRecoveryFixture("legacy", "test-server");
    cleanups.push(auth.dispose);
    auth.controls.protectedMethod = "initialize";
    fixture.manager.setOAuthRuntime(auth.runtime);
    fixture.config.mcpServers["test-server"] = auth.definition;

    handle = await startUiServer(fixture.options);
    const res = await requestTool(handle);
    expect(res.status).toBe(401);
    const guidance: unknown = expect.stringContaining(
      'mcp({ action: "auth-start", server: "test-server" })',
    );
    expect(res.body).toEqual({ ok: false, error: guidance });
  });

  it("uses the supplied auth callback when recovery reconnect returns needs-auth", async () => {
    const fixture = await setup();
    const auth = await createOAuthRecoveryFixture("legacy", "test-server");
    cleanups.push(auth.dispose);
    auth.controls.protectedMethod = "initialize";
    fixture.manager.setOAuthRuntime(auth.runtime);
    fixture.config.mcpServers["test-server"] = auth.definition;

    const onNeedsAuth = vi.fn<NonNullable<UiServerOptions["onNeedsAuth"]>>(async () => {
      fixture.config.mcpServers["test-server"] = fixture.wire.definition();
      fixture.wire.resultText = "after auth";
      const needsAuth = fixture.manager.getConnection("test-server");
      assert(needsAuth);
      return fixture.manager.reconnect("test-server", fixture.wire.definition(), needsAuth);
    });
    handle = await startUiServer({ ...fixture.options, onNeedsAuth });
    const res = await requestTool(handle);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      result: { content: [{ type: "text", text: "after auth" }] },
    });
    expect(onNeedsAuth).toHaveBeenCalledWith("test-server", undefined);
    expect(
      fixture.wire.calls.filter(
        (call) => call.method === "tools/call" && call.session === "session-2",
      ),
    ).toHaveLength(1);
  });

  it("runs without recovery (unchanged pre-existing behavior) when config is not supplied", async () => {
    const fixture = await setup();
    const { config: _config, ...options } = fixture.options;
    handle = await startUiServer(options);
    const res = await requestTool(handle);
    expect(res.status).toBe(500);
    expect(fixture.reconnect).not.toHaveBeenCalled();
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
  });
});
