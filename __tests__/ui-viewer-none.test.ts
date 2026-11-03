import { afterEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ServerConnection } from "../server-manager.ts";
import type { McpTool } from "../types.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentManager } from "../consent-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeUiMessages } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { maybeStartUiSession } from "../ui-session.ts";
import type { isGlimpseAvailable, openGlimpseWindow } from "../glimpse-ui.ts";

const glimpseMocks = vi.hoisted(() => ({
  isGlimpseAvailable: vi.fn<typeof isGlimpseAvailable>(() => true),
  openGlimpseWindow: vi.fn<typeof openGlimpseWindow>(),
}));

vi.mock("../glimpse-ui.ts", () => glimpseMocks);
const processMocks = vi.hoisted(() => ({ whoOutput: "" }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn<
    (_command: string, _options: unknown, callback: (error: null, output: string) => void) => void
  >((_command, _options, callback) => {
    callback(null, processMocks.whoOutput);
  }),
}));

function textOf(result: { content: unknown }): string {
  assert(Array.isArray(result.content));
  const content: unknown[] = result.content;
  return content
    .map((entry) =>
      entry !== null &&
      typeof entry === "object" &&
      "text" in entry &&
      typeof entry.text === "string"
        ? entry.text
        : "",
    )
    .join("\n");
}

const fixtures: Array<{
  state: ReturnType<typeof createTestState>;
  host: Awaited<ReturnType<typeof createTestExtensionContext>>;
}> = [];

async function makeState() {
  const host = await createTestExtensionContext("builtin");
  const ui = host.context.ui;
  const notify = vi.spyOn(ui, "notify");
  const consentManager = new ConsentManager();
  consentManager.registerDecision("demo", true);
  const tool: McpTool = {
    name: "app",
    description: "App",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://app" } },
  };
  const connection: ServerConnection = {
    status: "connected",
    client: new Client({ name: "ui-viewer-test", version: "1" }),
    transport: new InMemoryTransport(),
    definition: { command: "demo" },
    tools: [tool],
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
  };
  const callTool = vi.spyOn(connection.client, "callTool").mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "tool output" }],
  });
  const state = createTestState({
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: connection.definition } },
    toolMetadata: new Map([
      [
        "demo",
        [{ name: "demo_app", originalName: "app", description: "App", uiResourceUri: "ui://app" }],
      ],
    ]),
    consentManager,
    ui,
  });
  vi.spyOn(state.manager, "getConnection").mockReturnValue(connection);
  vi.spyOn(state.manager, "getAllConnections").mockReturnValue(new Map([["demo", connection]]));
  vi.spyOn(state.uiResourceHandler, "readUiResource").mockResolvedValue({
    uri: "ui://app",
    html: "<main>App</main>",
    mimeType: "text/html",
    meta: {},
  });
  const openBrowser = vi.spyOn(state, "openBrowser");
  const sendMessage = vi.fn<NonNullable<typeof state.sendMessage>>();
  const testState = Object.assign(state, { ui, openBrowser, sendMessage });
  fixtures.push({ state, host });
  return { state: testState, callTool, host, notify };
}

afterEach(async () => {
  for (const { state, host } of fixtures.splice(0)) {
    state.uiServer?.close("test-cleanup");
    await state.manager.closeAll();
    await host.dispose();
  }

  delete process.env.MCP_UI_VIEWER;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  processMocks.whoOutput = "";
  glimpseMocks.isGlimpseAvailable.mockClear();
  glimpseMocks.openGlimpseWindow.mockClear();
});

describe("remote MCP UI viewers", () => {
  it.each(["timeout", "abort"])(
    "settles a script on %s while browser opening is pending",
    async (ending) => {
      process.env.MCP_UI_VIEWER = "browser";
      const { state, callTool } = await makeState();
      const controller = new AbortController();
      const opening: PromiseWithResolvers<void> = Promise.withResolvers();
      state.openBrowser.mockImplementation(() => opening.promise);
      let output: Awaited<ReturnType<typeof runMcpScript>> | undefined;
      const pending = runMcpScript(
        state,
        "await tools.demo_app({});",
        ending === "timeout" ? 500 : 5000,
        undefined,
        controller.signal,
      ).then((result) => {
        output = result;
        return result;
      });
      try {
        await expect.poll(() => state.openBrowser.mock.calls.length).toBe(1);
        if (ending === "abort") {
          controller.abort(new Error("caller cancelled"));
        }
        await expect.poll(() => output, { timeout: 1000 }).toBeDefined();
        assert(output);
        expect(output.details).toMatchObject({
          error: ending === "timeout" ? "timeout" : "aborted",
          calls: [{ path: "demo_app", error: "aborted" }],
        });
        expect(callTool).not.toHaveBeenCalled();
      } finally {
        opening.resolve();
        await pending;
        state.uiServer?.close("test-cleanup");
      }
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it("skips Glimpse and prints a remote access hint for SSH sessions", async () => {
    process.env.SSH_CONNECTION = "192.0.2.10 55555 127.0.0.1 22";
    const { state, notify } = await makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "browser", windowOpen: true });
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("http://localhost:"));
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("This looks like a remote session"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("SSH: run `ssh -L"), "info");

    runtime?.close("test-cleanup");
  });

  it("uses local-window wording when a remote login is active but Glimpse opened", async () => {
    processMocks.whoOutput = "user ttys001 2026-08-02 08:00 (192.0.2.10)\n";
    const { state, notify } = await makeState();
    glimpseMocks.openGlimpseWindow.mockResolvedValueOnce({ close: vi.fn<() => void>() });

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "glimpse", windowOpen: true });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP UI opened on this host"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("If you're controlling this session remotely"),
      "info",
    );

    runtime?.close("test-cleanup");
  });
});

describe("MCP UI context submissions", () => {
  it("rejects an authenticated message whose upload finishes after UI completion", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const root = await mkdtemp(join(tmpdir(), "mcp-ui-late-message-"));
    const { state, notify } = await makeState();
    state.outputDirectory = root;
    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });
    if (!runtime) {
      throw new Error("expected UI runtime");
    }
    const handle = state.uiServer;
    assert(handle);
    let upload: http.ClientRequest | undefined;
    try {
      const body = (message: string) =>
        JSON.stringify({
          token: handle.sessionToken,
          params: { type: "notify", message },
        });
      const first = await fetch(`http://127.0.0.1:${handle.port}/proxy/ui/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body("accepted before completion"),
      });
      expect(first.status).toBe(200);
      const lateBody = body("not accepted after completion");
      const admittedUpload: PromiseWithResolvers<void> = Promise.withResolvers();
      const receipt = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        upload = http.request(
          {
            hostname: "127.0.0.1",
            port: handle.port,
            path: "/proxy/ui/message",
            method: "POST",
            agent: false,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(lateBody),
              Expect: "100-continue",
            },
          },
          (res) => {
            res.setEncoding("utf8");
            let text = "";
            res.on("data", (chunk: unknown) => {
              if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
                text += chunk.toString();
              }
            });
            res.on("end", () => {
              try {
                const responseBody: unknown = JSON.parse(text);
                assert(res.statusCode !== undefined);
                resolve({ status: res.statusCode, body: responseBody });
              } catch (error) {
                reject(error);
              }
            });
            res.on("error", reject);
          },
        );
        upload.on("error", reject);
        upload.once("continue", () => admittedUpload.resolve());
        upload.write(lateBody.slice(0, -1));
      });
      await admittedUpload.promise;
      runtime.close("user-closed");
      assert(upload);
      upload.end(lateBody.slice(-1));
      expect(await receipt).toMatchObject({ status: 409, body: { ok: false } });
      expect(notify).not.toHaveBeenCalledWith("[demo] not accepted after completion", "info");
      const delivered = await executeUiMessages(state);
      expect(textOf(delivered)).toContain("accepted before completion");
      expect(textOf(delivered)).not.toContain("not accepted after completion");
      expect(delivered.details.cleared).toBe(true);
      expect(state.completedUiSessions).toEqual([]);
    } finally {
      upload?.destroy();
      runtime.close("test-cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("triggers an agent turn when the UI updates model context", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = await makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });
    if (!runtime) {
      throw new Error("expected UI runtime");
    }

    await fetch(`${runtime.url.replace(/\/?\?.*$/, "")}/proxy/ui/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: new URL(runtime.url).searchParams.get("session"),
        params: { content: [{ type: "text", text: "Use this selection" }] },
      }),
    });

    const selectionMatcher: unknown = expect.stringContaining("Use this selection");
    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "mcp-ui-context",
        content: [{ type: "text", text: selectionMatcher }],
        display: "UI Context submitted",
      }),
      { triggerTurn: true },
    );

    runtime.close("test-cleanup");
  });
});

describe("MCP_UI_VIEWER=none", () => {
  it.each(["none", "off", "disabled"])("suppresses window opening for %s", async (value) => {
    process.env.MCP_UI_VIEWER = value;
    const { state, notify } = await makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "suppressed", windowOpen: false });
    expect(runtime?.url).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP UI window suppressed"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.not.stringContaining("Tool still ran"), "info");

    runtime?.close("test-cleanup");
  });

  it("reports suppressed UI state in proxy tool results", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = await makeState();

    const result = await executeCall(state, "demo_app", {}, "demo");

    expect(textOf(result)).toContain("tool output");
    expect(textOf(result)).toContain("MCP UI window was suppressed");
    expect(textOf(result)).not.toContain("open in your browser");
    expect(result.details).toMatchObject({ uiOpen: false, uiViewer: "suppressed" });
    expect(result.details.uiUrl).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();

    state.uiServer?.close("test-cleanup");
  });

  it("reports suppressed UI state in direct tool results", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state, host } = await makeState();
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "app",
        prefixedName: "demo_app",
        description: "App",
        uiResourceUri: "ui://app",
      },
    );

    const signal = new AbortController().signal;
    const result = await execute(
      "call-1",
      {},
      signal,
      undefined,
      host.runner.createToolContext("call-1", signal),
    );

    expect(textOf(result)).toContain("tool output");
    expect(textOf(result)).toContain("MCP UI window was suppressed");
    expect(textOf(result)).not.toContain("open in your browser");
    expect(result.details).toMatchObject({ uiOpen: false, uiViewer: "suppressed" });
    expect(result.details.uiUrl).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();

    state.uiServer?.close("test-cleanup");
  });
});
