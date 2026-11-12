import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ChildProcess, ExecFileOptions, execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyRuntimeState } from "./fixtures/proxy-runtime.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import type { McpExtensionState } from "../state.ts";
import type * as Glimpse from "../glimpse-ui.ts";
import type * as Child from "node:child_process";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeUiMessages } from "../proxy-modes.ts";
import { maybeStartUiSession, summarizeUiSessionResult } from "../ui-session.ts";

const glimpseMocks = vi.hoisted(() => ({
  isGlimpseAvailable: vi.fn<typeof Glimpse.isGlimpseAvailable>(() => true),
  openGlimpseWindow: vi.fn<typeof Glimpse.openGlimpseWindow>(),
}));

vi.mock("../glimpse-ui.ts", () => glimpseMocks);
const shell = vi.hoisted(() => ({ who: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const native = await importOriginal<typeof Child>();
  return {
    ...native,
    execFile: vi.fn<
      (
        command: string,
        options: ExecFileOptions,
        callback: NonNullable<Parameters<typeof execFile>[3]>,
      ) => ChildProcess
    >((_command, _options, callback) => {
      callback(null, shell.who, "");
      return new native.ChildProcess();
    }),
  };
});
let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

function textOf(result: Pick<AgentToolResult<unknown>, "content">): string {
  return result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n");
}

async function makeState() {
  const { state: native, connection } = await proxyRuntimeState({
    name: "app",
    description: "App",
    uiResourceUri: "ui://app",
    result: { isError: false, content: [{ type: "text", text: "tool output" }] },
    readResource: () => ({
      contents: [{ uri: "ui://app", text: "<main>App</main>", mimeType: "text/html" }],
    }),
  });
  native.consentManager.registerDecision("demo", true);
  const state = Object.assign(native, {
    openBrowser: vi.fn<NonNullable<McpExtensionState["openBrowser"]>>(async () => {
      /* No external window in the isolated fixture. */
    }),
    sendMessage: vi.fn<NonNullable<McpExtensionState["sendMessage"]>>(),
    ui: {
      ...host.context.ui,
      notify: vi.fn<typeof host.context.ui.notify>(),
      setStatus: vi.fn<typeof host.context.ui.setStatus>(),
    },
  });
  onTestFinished(() => {
    state.uiServer?.close("test-cleanup");
  });
  return { state, callTool: vi.spyOn(connection.client, "callTool") };
}

afterEach(() => {
  delete process.env.MCP_UI_VIEWER;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  shell.who = "";
  glimpseMocks.isGlimpseAvailable.mockClear();
  glimpseMocks.openGlimpseWindow.mockClear();
});

describe("remote MCP UI viewers", () => {
  it("does not return a superseded UI while its browser launch is pending", async () => {
    process.env.MCP_UI_VIEWER = "browser";
    const { state } = await makeState();
    const launched = Promise.withResolvers<null>();
    state.openBrowser.mockImplementationOnce(async () => {
      await launched.promise;
    });
    const request = {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    };
    const opening = maybeStartUiSession(state, request);
    await expect.poll(() => state.openBrowser.mock.calls.length).toBe(1);
    const current = await maybeStartUiSession(state, { ...request, toolName: "other" });
    assert.ok(current);
    try {
      launched.resolve(null);
      expect(await opening).toBeNull();
      expect(summarizeUiSessionResult(await opening)).toEqual({
        message: "Interactive UI was unavailable; returning the tool result inline.",
        uiOpen: false,
      });
      expect(current.isActive()).toBe(true);
    } finally {
      launched.resolve(null);
      await opening;
      current.close("test-cleanup");
    }
  });

  it.each(["browser", "none"])(
    "does not advertise a replaced %s UI after a runtime has already returned",
    async (viewer) => {
      process.env.MCP_UI_VIEWER = viewer;
      const { state, callTool } = await makeState();
      const request = {
        serverName: "demo",
        toolName: "app",
        toolArgs: {},
        uiResourceUri: "ui://app",
      };
      const first = await maybeStartUiSession(state, request);
      assert.ok(first);
      const accepted = Promise.withResolvers<null>();
      const deliver = Promise.withResolvers<null>();
      state.onToolCall = async (event) => {
        if (event.phase === "after") {
          accepted.resolve(null);
          await deliver.promise;
        }
      };
      const calling = executeCall(state, { toolName: "demo_app", args: {} });
      await accepted.promise;
      const current = await maybeStartUiSession(state, { ...request, toolName: "other" });
      assert.ok(current);
      try {
        deliver.resolve(null);
        const result = await calling;
        expect(result.details.uiOpen).toBe(false);
        expect(result.details.uiUrl).toBeUndefined();
        expect(textOf(result)).toContain("tool output");
        expect(textOf(result)).toContain("ended or was replaced");
        expect(callTool).toHaveBeenCalledOnce();
        expect(first.isActive()).toBe(false);
        expect(summarizeUiSessionResult(first)).toEqual({
          message: "Interactive UI ended or was replaced; returning the tool result inline.",
          uiOpen: false,
        });
        expect(summarizeUiSessionResult(current).uiUrl).toBe(current.url);
      } finally {
        deliver.resolve(null);
        await calling;
        current.close("test-cleanup");
      }
    },
  );

  it("closes a late Glimpse window without replacing the current session's viewer", async () => {
    process.env.MCP_UI_VIEWER = "glimpse";
    const { state } = await makeState();
    const firstWindow = { close: vi.fn<() => void>() };
    const currentWindow = { close: vi.fn<() => void>() };
    const lateWindow = Promise.withResolvers<typeof firstWindow>();
    glimpseMocks.openGlimpseWindow
      .mockImplementationOnce(async () => lateWindow.promise)
      .mockResolvedValueOnce(currentWindow);
    const request = {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    };
    const opening = maybeStartUiSession(state, request);
    await expect.poll(() => glimpseMocks.openGlimpseWindow.mock.calls.length).toBe(1);
    const current = await maybeStartUiSession(state, { ...request, toolName: "other" });
    assert.ok(current);
    try {
      lateWindow.resolve(firstWindow);
      expect(await opening).toBeNull();
      expect(firstWindow.close).toHaveBeenCalledOnce();
      expect(currentWindow.close).not.toHaveBeenCalled();
      expect(state.openBrowser).not.toHaveBeenCalled();
      current.close("test-cleanup");
      expect(currentWindow.close).toHaveBeenCalledOnce();
    } finally {
      lateWindow.resolve(firstWindow);
      await opening;
      current.close("test-cleanup");
    }
  });

  it("settles an aborted call while browser opening is pending", async () => {
    process.env.MCP_UI_VIEWER = "browser";
    const { state, callTool } = await makeState();
    const controller = new AbortController();
    const open = Promise.withResolvers<null>();
    state.openBrowser.mockImplementation(async () => {
      await open.promise;
    });
    let output: Awaited<ReturnType<typeof executeCall>> | undefined;
    const pending = executeCall(state, {
      toolName: "demo_app",
      args: {},
      signal: controller.signal,
    }).then((result) => {
      output = result;
      return result;
    });
    try {
      await expect.poll(() => state.openBrowser.mock.calls.length).toBe(1);
      controller.abort(new Error("caller cancelled"));
      await expect.poll(() => output, { timeout: 1000 }).toBeDefined();
      assert.ok(output);
      expect(output.details).toMatchObject({ error: "aborted" });
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      open.resolve(null);
      await pending;
      state.uiServer?.close("test-cleanup");
    }
    expect(callTool).not.toHaveBeenCalled();
  });

  it("skips Glimpse and prints a remote access hint for SSH sessions", async () => {
    process.env.SSH_CONNECTION = "192.0.2.10 55555 127.0.0.1 22";
    const { state } = await makeState();

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
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("This looks like a remote session"),
      "info",
    );
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("SSH: run `ssh -L"),
      "info",
    );

    runtime?.close("test-cleanup");
  });

  it("uses local-window wording when a remote login is active but Glimpse opened", async () => {
    shell.who = "user ttys001 2026-08-02 08:00 (192.0.2.10)\n";
    const { state } = await makeState();
    glimpseMocks.openGlimpseWindow.mockResolvedValueOnce({ close: vi.fn<() => void>() });

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "glimpse", windowOpen: true });
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP UI opened on this host"),
      "info",
    );
    expect(state.ui.notify).toHaveBeenCalledWith(
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
    const { state } = await makeState();
    state.outputDirectory = root;
    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });
    assert.ok(runtime);
    const handle = state.uiServer;
    assert.ok(handle);
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
      const admitted = Promise.withResolvers<null>();
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
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
            });
            res.on("end", () => {
              const responseBody: unknown = JSON.parse(text);
              assert.ok(res.statusCode !== undefined);
              resolve({ status: res.statusCode, body: responseBody });
            });
          },
        );
        upload.on("error", reject);
        upload.once("continue", () => {
          admitted.resolve(null);
        });
        upload.write(lateBody.slice(0, -1));
      });
      await admitted.promise;
      runtime.close("user-closed");
      assert.ok(upload);
      upload.end(lateBody.slice(-1));
      expect(await receipt).toMatchObject({ status: 409, body: { ok: false } });
      expect(state.ui.notify).not.toHaveBeenCalledWith(
        "[demo] not accepted after completion",
        "info",
      );
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
    assert.ok(runtime);

    assert.ok(state.uiServer);
    await fetch(`${runtime.url.replace(/\/?\?.*$/, "")}/proxy/ui/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.uiServer.sessionToken,
        params: { content: [{ type: "text", text: "Use this selection" }] },
      }),
    });

    const selection: unknown = expect.stringContaining("Use this selection");
    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "mcp-ui-context",
        content: [{ type: "text", text: selection }],
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
    const { state } = await makeState();

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
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("MCP UI window suppressed"),
      "info",
    );
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.not.stringContaining("Tool still ran"),
      "info",
    );

    runtime?.close("test-cleanup");
  });

  it("reports suppressed UI state in proxy tool results", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = await makeState();

    const result = await executeCall(state, {
      toolName: "demo_app",
      args: {},
      serverOverride: "demo",
    });

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
    const { state } = await makeState();
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

    const result = await execute(
      "call-1",
      {},
      undefined,
      undefined,
      host.runner.createToolContext("call-1", state.owner.signal),
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
