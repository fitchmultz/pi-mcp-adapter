import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requireValue, type createLifecycleHost } from "../fixtures/extension-lifecycle.ts";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeWorkspace(prefix: string): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  return { home, project };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function createSampleServer(): McpServer {
  const server = new McpServer({ name: "alpha-server", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "Ping health check", inputSchema: z.object({}) },
    () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  server.registerResource("guide", "docs://guide", { mimeType: "text/plain" }, () => ({
    contents: [{ uri: "docs://guide", text: "Guide body", mimeType: "text/plain" }],
  }));
  server.registerPrompt("brief", { description: "Short brief" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: "Brief prompt" } }],
  }));
  return server;
}

async function readNodeRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    }
  }
  const url = `http://127.0.0.1${req.url ?? "/mcp"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function sendWebResponse(nodeRes: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  nodeRes.writeHead(webRes.status, headers);
  const body = await webRes.arrayBuffer();
  nodeRes.end(Buffer.from(body));
}

async function startStatefulHttpMcpServer(): Promise<string> {
  const sessions = new Map<
    string,
    { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const httpServer = createServer((req, res) => {
    (async () => {
      const webReq = await readNodeRequest(req);
      const sessionId = webReq.headers.get("mcp-session-id");
      let active = sessionId !== null ? sessions.get(sessionId) : undefined;
      if (!active) {
        const server = createSampleServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });
        await server.connect(transport);
        active = { server, transport };
      }
      const webRes = await active.transport.handleRequest(webReq);
      await sendWebResponse(res, webRes);
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  cleanups.push(async () => {
    for (const { server } of sessions.values()) {
      await server.close();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
    });
  });
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Expected TCP address");
  }
  return `http://127.0.0.1:${addr.port}/mcp`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

async function bootWorkspaceHost(prefix: string) {
  const { home, project } = makeWorkspace(prefix);
  vi.resetModules();
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();
  const { createMcpAdapter } = await import("../../index.ts");
  const { createLifecycleHost } = await import("../fixtures/extension-lifecycle.ts");
  const host = await createLifecycleHost();
  cleanups.push(() => host.dispose());
  createMcpAdapter()(host.api);
  const ui = createUiSpies(host);
  return { home, project, host, ui };
}

type LifecycleHostInstance = Awaited<ReturnType<typeof createLifecycleHost>>;

function createUiSpies(host: LifecycleHostInstance) {
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
  const reload = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const nativeUi = host.runner.getUIContext();
  let customCalls = 0;
  const custom: ExtensionUIContext["custom"] = (factory, options) => {
    customCalls++;
    return nativeUi.custom(factory, options);
  };
  return {
    notify,
    setStatus,
    reload,
    custom,
    getCustomCalls: () => customCalls,
  };
}

describe("MCP-214 commands routing, live enable/disable, and doctor observability", () => {
  it("routes /mcp status, unknown subcommands, reload, tools, and completions cleanly", async () => {
    const { project, host, ui } = await bootWorkspaceHost("pi-mcp-214-route-");
    const serverUrl = await startStatefulHttpMcpServer();
    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        alpha: { url: serverUrl, auth: false },
        disabledSrv: { url: "https://disabled.invalid/mcp", disabled: true },
      },
    });

    const cmdContext = {
      cwd: project,
      hasUI: true,
      mode: "tui" as const,
      isProjectTrusted: () => true,
      reload: ui.reload,
      ui: { notify: ui.notify, custom: ui.custom, setStatus: ui.setStatus },
    };
    await host.handlers.get("session_start")({}, cmdContext);

    const mcpCmd = host.command("mcp");
    await mcpCmd.handler("status", cmdContext);
    expect(ui.getCustomCalls()).toBe(0);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("MCP Server Status:");

    const topCompletions = requireValue(await mcpCmd.getArgumentCompletions(""));
    expect(topCompletions.map((item) => item.value)).toEqual(
      expect.arrayContaining(["status", "tools", "reload", "doctor", "disable", "enable"]),
    );
    const toolsCompletions = requireValue(await mcpCmd.getArgumentCompletions("tools "));
    expect(toolsCompletions.map((item) => item.label)).toEqual(["alpha"]);

    await mcpCmd.handler("foo", cmdContext);
    expect(ui.getCustomCalls()).toBe(0);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain('Unknown /mcp subcommand "foo"');
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("Usage: /mcp");

    await mcpCmd.handler("reload", cmdContext);
    expect(ui.reload).toHaveBeenCalledTimes(1);

    ui.notify.mockClear();
    await mcpCmd.handler("reconnect", cmdContext);
    const reconnectWarnings = ui.notify.mock.calls.filter(
      ([msg]) => msg.includes("disabledSrv") && msg.includes("disabled"),
    );
    expect(reconnectWarnings).toHaveLength(0);

    await mcpCmd.handler("tools", cmdContext);
    const allToolsOutput = ui.notify.mock.calls.at(-1)?.[0] ?? "";
    expect(allToolsOutput).toMatch(/alpha \(1 tool, ~\d+ tokens\)/);
    expect(allToolsOutput).toMatch(/mcp__alpha__ping \(~\d+ tokens\)/);

    await mcpCmd.handler("tools disabledSrv", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("is disabled");

    await mcpCmd.handler("", cmdContext);
    expect(ui.getCustomCalls()).toBe(1);
  });

  it("applies /mcp disable and /mcp enable live in-session without /reload and syncs resources", async () => {
    const { project, host, ui } = await bootWorkspaceHost("pi-mcp-214-live-");
    const serverUrl = await startStatefulHttpMcpServer();
    const sharedPath = join(project, ".mcp.json");
    writeJson(sharedPath, {
      mcpServers: {
        alpha: { url: serverUrl, auth: false, directTools: true },
      },
    });
    const sharedBefore = readFileSync(sharedPath, "utf8");

    const cmdContext = {
      cwd: project,
      hasUI: true,
      mode: "tui" as const,
      isProjectTrusted: () => true,
      ui: { notify: ui.notify, custom: ui.custom, setStatus: ui.setStatus },
    };
    await host.handlers.get("session_start")({}, cmdContext);

    const mcpCmd = host.command("mcp");
    await mcpCmd.handler("reconnect alpha", cmdContext);

    const resourcesBefore = await host
      .tool("mcp")
      .execute("res-1", { action: "resources", server: "alpha" });
    expect(resourcesBefore.details).toMatchObject({ server: "alpha", total: 1 });
    expect(host.api.getActiveTools()).toContain("mcp__alpha__ping");
    expect(host.runner.getCommand("mcp__alpha__brief")).toBeDefined();

    await mcpCmd.handler("disable alpha", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("disconnected and tools unloaded");
    expect(readFileSync(sharedPath, "utf8")).toBe(sharedBefore);
    expect(host.api.getActiveTools()).not.toContain("mcp__alpha__ping");
    await mcpCmd.handler("prompts", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("No MCP prompts available");
    await host.command("mcp__alpha__brief").handler("", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[1]).toBe("error");
    const disabledList = await host
      .tool("mcp")
      .execute("list-disabled", { action: "list", server: "alpha" });
    expect(disabledList.details).toMatchObject({ error: "server_disabled" });

    await mcpCmd.handler("disable alpha", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toBe('Server "alpha" is already disabled');

    await mcpCmd.handler("enable alpha", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain(
      'Enabled server "alpha" (1 tool registered)',
    );
    expect(host.api.getActiveTools()).toContain("mcp__alpha__ping");
    await mcpCmd.handler("prompts", cmdContext);
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("/mcp__alpha__brief");

    const resourcesAfter = await host
      .tool("mcp")
      .execute("res-2", { action: "resources", server: "alpha" });
    expect(resourcesAfter.details).toMatchObject({ server: "alpha", total: 1 });
  });

  it("surfaces config validation notices at startup and reports full /mcp doctor diagnostics including stderr", async () => {
    const { project, host, ui } = await bootWorkspaceHost("pi-mcp-214-doctor-");
    writeJson(join(project, ".mcp.json"), {
      directTool: true,
      mcpServers: {
        failing_stdio: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('boom-stderr-line\\n'); process.exit(1);"],
        },
        broken: { command: 99 },
      },
    });

    const trustedCtx = {
      cwd: project,
      hasUI: true,
      mode: "tui" as const,
      isProjectTrusted: () => true,
      ui: { notify: ui.notify, custom: ui.custom, setStatus: ui.setStatus },
    };
    await host.handlers.get("session_start")({}, trustedCtx);

    const startupMessages = ui.notify.mock.calls.map(([msg]) => msg).join("\n");
    expect(startupMessages).toContain("MCP configuration validation");
    expect(startupMessages).toContain("directTool");
    expect(startupMessages).toContain("broken");

    const mcpCmd = host.command("mcp");
    await mcpCmd.handler("reconnect failing_stdio", trustedCtx);
    await mcpCmd.handler("doctor", trustedCtx);

    const doctorCall = ui.notify.mock.calls.at(-1);
    const doctorText = doctorCall?.[0] ?? "";
    expect(doctorCall?.[1]).toBe("warning");
    expect(doctorText).toContain("MCP Doctor:");
    expect(doctorText).toContain("Config Sources:");
    expect(doctorText).toContain("Server Provenance:");
    expect(doctorText).toContain("Config Validation");
    expect(doctorText).toContain("OAuth / Keyring Health");
    expect(doctorText).toContain("Servers:");
    expect(doctorText).toContain("Server Log:");
    expect(doctorText).toContain("Recent Stderr:");
    expect(doctorText).toContain("boom-stderr-line");

    await mcpCmd.handler("status", {
      ...trustedCtx,
      isProjectTrusted: () => false,
    });
    expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("blocked (Project is not trusted)");
  });

  it("checks doctor OAuth Unix-second expiry, excludes native Pi configs when disabled, and sanitizes untrusted blocked names", async () => {
    const prevAuthStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    try {
      const { home, project, host, ui } = await bootWorkspaceHost("pi-mcp-214-doctor-sec-");
      const { saveAuthEntry } = await import("../../mcp-auth.ts");
      const { showDoctor } = await import("../../mcp-doctor.ts");
      const { createTestExtensionContext } = await import("../test-extension-context.ts");
      const { createTestState } = await import("../test-state.ts");

      const agentDir = join(home, ".pi", "agent");
      writeJson(join(agentDir, "mcp.json"), {
        mcpServers: { nativeSrv: { command: "echo" } },
      });
      writeJson(join(agentDir, "fitch-mcp-adapter", "mcp.json"), {
        mcpServers: {
          valid_sec: { url: "https://valid.example.test/mcp", auth: "oauth" },
          zero_sentinel: { url: "https://zero.example.test/mcp", auth: "oauth" },
          expired_sec: { url: "https://exp.example.test/mcp", auth: "oauth" },
        },
      });
      writeJson(join(project, ".mcp.json"), {
        mcpServers: {
          "bad\x1b]52;c;ZGF0YQ==\x07evil\nforged": { url: "https://evil.example.test/mcp" },
        },
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      await saveAuthEntry(
        { serverName: "valid_sec", serverUrl: "https://valid.example.test/mcp" },
        { tokens: { accessToken: "valid-tok", expiresAt: nowSeconds + 3600 } },
      );
      await saveAuthEntry(
        { serverName: "zero_sentinel", serverUrl: "https://zero.example.test/mcp" },
        { tokens: { accessToken: "zero-tok", expiresAt: 0 } },
      );
      await saveAuthEntry(
        { serverName: "expired_sec", serverUrl: "https://exp.example.test/mcp" },
        { tokens: { accessToken: "exp-tok", expiresAt: nowSeconds - 60 } },
      );

      const untrustedCtx = {
        cwd: project,
        hasUI: true,
        mode: "tui" as const,
        isProjectTrusted: () => false,
        ui: { notify: ui.notify, custom: ui.custom, setStatus: ui.setStatus },
      };

      await host.handlers.get("session_start")({}, untrustedCtx);

      const mcpCmd = host.command("mcp");
      await mcpCmd.handler("doctor", untrustedCtx);
      const doctorOut = ui.notify.mock.calls.at(-1)?.[0] ?? "";
      expect(doctorOut).toContain("valid_sec: authenticated");
      expect(doctorOut).toContain("zero_sentinel: authenticated");
      expect(doctorOut).toContain(
        "expired_sec: stored OAuth token expired (refresh/re-auth may be required)",
      );
      expect(doctorOut).not.toContain("\x1b");
      expect(doctorOut).not.toContain("\x07");
      expect(doctorOut).not.toContain("\nforged");

      await mcpCmd.handler("status", untrustedCtx);
      const statusOut = ui.notify.mock.calls.at(-1)?.[0] ?? "";
      expect(statusOut).toContain("blocked (Project is not trusted)");
      expect(statusOut).not.toContain("\x1b");
      expect(statusOut).not.toContain("\x07");
      expect(statusOut).not.toContain("\nforged");

      const doctorNotify = vi.fn<ExtensionUIContext["notify"]>();
      const state = createTestState({ config: { mcpServers: {} } });
      const doctorHostCtx = await createTestExtensionContext();
      try {
        await showDoctor(
          state,
          {
            ...doctorHostCtx.context,
            cwd: project,
            hasUI: true,
            mode: "tui",
            isProjectTrusted: () => false,
            ui: { ...doctorHostCtx.context.ui, notify: doctorNotify },
          },
          { discoveryOptions: { includeNativePi: false } },
        );
      } finally {
        await state.owner.stop();
        await doctorHostCtx.dispose();
      }
      const excludedDoctorOut = doctorNotify.mock.calls.at(-1)?.[0] ?? "";
      expect(excludedDoctorOut).toContain("excluded (Native Pi user config disabled)");
      expect(excludedDoctorOut).not.toContain("mcp.json — error");
    } finally {
      if (prevAuthStore === undefined) {
        delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      } else {
        process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = prevAuthStore;
      }
    }
  });
});
