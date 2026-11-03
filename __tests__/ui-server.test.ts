import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { materializeUiMessages } from "../ui-message-history.ts";
import { startUiServer, type UiServerOptions, type UiServerHandle } from "../ui-server.ts";
import type { McpServerManager } from "../server-manager.ts";
import type { Client } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { request, connectSSE } from "./fixtures/strict-ui-boundaries-http.ts";
import {
  createClient,
  createConnection,
  createMockManager,
  createMockConsentManager,
} from "./fixtures/strict-ui-boundaries-manager.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import type { McpConfig, UiResourceContent } from "../types.ts";

function createMockResource(overrides: Partial<UiResourceContent> = {}): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test App</h1>",
    mimeType: "text/html",
    meta: {
      permissions: {},
    },
    ...overrides,
  };
}

function createServerOptions(overrides: Partial<UiServerOptions> = {}): UiServerOptions {
  return {
    serverName: "test-server",
    toolName: "test_tool",
    toolArgs: { key: "value" },
    resource: createMockResource(),
    manager: createMockManager(),
    consentManager: createMockConsentManager(),
    ...overrides,
  };
}

async function getUiAppUrl(handle: UiServerHandle): Promise<string> {
  const host = await request(handle.url);
  const match =
    typeof host.body === "string" ? host.body.match(/const UI_RESOURCE_TOKEN = "([^"]+)";/) : null;
  if (match?.[1] === undefined || match[1] === "") {
    throw new Error("UI resource token missing from host page");
  }
  return `http://localhost:${handle.port}/ui-app?resource=${encodeURIComponent(match[1])}`;
}

const cleanups: Array<() => Promise<void>> = [];

describe("UiServer", () => {
  let handle: UiServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      const ref = handle.getSessionMessages().historyRef;
      handle.close("test-cleanup");
      if (ref !== undefined && ref !== "") {
        await rm(dirname(ref), { recursive: true, force: true });
      }
      handle = null;
    }
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  describe("startUiServer", () => {
    it("starts server on a Moshi-discoverable low port by default", async () => {
      handle = await startUiServer(createServerOptions());

      expect(handle.port).toBeGreaterThanOrEqual(8377);
      expect(handle.port).toBeLessThanOrEqual(8396);
      expect(handle.url).toContain(`http://localhost:${handle.port}`);
      expect(handle.sessionToken).toBeTruthy();
    });

    it("uses provided session token", async () => {
      handle = await startUiServer(createServerOptions({ sessionToken: "custom-token-123" }));

      expect(handle.sessionToken).toBe("custom-token-123");
      expect(handle.url).toContain("session=custom-token-123");
    });

    it("uses provided port", async () => {
      // Find a free port first
      const tempServer = http.createServer();
      await new Promise<void>((resolve) => {
        tempServer.listen(0, "127.0.0.1", resolve);
      });
      const address = tempServer.address();
      assert(address !== null && typeof address !== "string");
      const freePort = address.port;
      await new Promise<void>((resolve, reject) => {
        tempServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      handle = await startUiServer(createServerOptions({ port: freePort }));

      expect(handle.port).toBe(freePort);
    });

    it("includes server and tool name in handle", async () => {
      handle = await startUiServer(
        createServerOptions({
          serverName: "my-server",
          toolName: "my_tool",
        }),
      );

      expect(handle.serverName).toBe("my-server");
      expect(handle.toolName).toBe("my_tool");
    });

    it("does not complete a rejected occupied-port startup when its watchdog would expire", async () => {
      const occupied = http.createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(0, "127.0.0.1", resolve);
      });
      const address = occupied.address();
      assert(address !== null && typeof address !== "string");
      const onComplete = vi.fn<NonNullable<UiServerOptions["onComplete"]>>();
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      try {
        await expect(
          startUiServer(createServerOptions({ port: address.port, onComplete })),
        ).rejects.toThrow(/EADDRINUSE/);
        vi.advanceTimersByTime(65_000);
        expect(onComplete).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        await new Promise<void>((resolve, reject) => {
          occupied.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });
  });

  describe("GET /", () => {
    it("returns HTML host page with valid token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/?session=${handle.sessionToken}`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      assert(typeof res.body === "string");
      expect(res.body.toLowerCase()).toContain("<!doctype html>");
      expect(res.body).toContain("test-server");
      expect(res.body).toContain("test_tool");
    });

    it("rejects invalid session token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/?session=wrong-token`;

      const res = await request(url);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: "Invalid session" });
    });

    it("serves a tokenless Moshi landing page without disclosing the session", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Open the authenticated MCP UI URL shown by Pi");
      expect(res.body).not.toContain("location.replace");
      expect(res.body).not.toContain(handle.sessionToken);
      expect(res.body).not.toContain(encodeURIComponent(handle.sessionToken));
    });

    it("answers HEAD discovery probes without a session token", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe("");
    });

    it("rejects non-loopback Host headers before serving tokenless landing", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { headers: { Host: "attacker.example" } });

      expect(res.status).toBe(403);
      expect(res.body).toBe("Invalid host");
    });

    it("accepts bracketed IPv6 loopback Host headers", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/`;

      const res = await request(url, { headers: { Host: `[::1]:${handle.port}` } });

      expect(res.status).toBe(200);
      expect(res.body).toContain("Open the authenticated MCP UI URL shown by Pi");
      expect(res.body).not.toContain(handle.sessionToken);
    });
  });

  describe("GET /ui-app", () => {
    it("does not accept the app resource token on privileged proxy routes", async () => {
      const manager = createMockManager();
      handle = await startUiServer(createServerOptions({ manager }));
      const appUrl = new URL(await getUiAppUrl(handle));
      const resourceToken = appUrl.searchParams.get("resource");

      expect(resourceToken).toBeTruthy();
      expect(resourceToken).not.toBe(handle.sessionToken);
      expect(
        (await request(`http://localhost:${handle.port}/ui-app?session=${handle.sessionToken}`))
          .status,
      ).toBe(403);

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: resourceToken, params: { name: "some_tool", arguments: {} } },
      });

      expect(res.status).toBe(403);
      expect(vi.spyOn(manager, "getConnection")).not.toHaveBeenCalled();
    });

    it("enforces metadata CSP and response-level sandboxing while preserving app HTML", async () => {
      const appHtml = `<!-- decoy <head><meta http-equiv="Content-Security-Policy" content="default-src *"></head> -->
<!doctype html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="img-src https://images.example.com">
  <style>body { margin: 0; }</style>
</head>
<body>
  <script type="module">import "https://esm.sh/example";</script>
</body>
</html>`;
      handle = await startUiServer(
        createServerOptions({
          resource: createMockResource({
            html: appHtml,
            meta: {
              permissions: {},
              csp: {
                resourceDomains: ["https://esm.sh"],
                connectDomains: ["https://api.excalidraw.com"],
              },
            },
          }),
        }),
      );
      const url = await getUiAppUrl(handle);

      const res = await request(url);
      const cspHeader = res.headers["content-security-policy"];

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(cspHeader).toContain("default-src 'none'");
      expect(cspHeader).toContain(
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
      );
      expect(cspHeader).not.toContain("allow-popups-to-escape-sandbox");
      expect(cspHeader).not.toContain("allow-same-origin");
      expect(cspHeader).toContain("script-src 'self' 'unsafe-inline' https://esm.sh");
      expect(cspHeader).toContain("style-src 'self' 'unsafe-inline' https://esm.sh");
      expect(cspHeader).toContain("connect-src https://api.excalidraw.com");
      expect(res.body).toBe(appHtml);
    });

    it("rejects malformed CSP metadata before writing the response header", async () => {
      const appHtml = "<h1>Original App</h1>";
      handle = await startUiServer(
        createServerOptions({
          resource: createMockResource({
            html: appHtml,
            meta: {
              permissions: {},
              csp: {
                resourceDomains: [
                  "https://safe.example.com",
                  "https://c1.example.com\x80img-src",
                  "https://emoji.example.com/😀",
                ],
              },
            },
          }),
        }),
      );

      const res = await request(await getUiAppUrl(handle));

      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("https://safe.example.com");
      expect(res.headers["content-security-policy"]).not.toContain(
        "https://c1.example.com\x80img-src",
      );
      expect(res.headers["content-security-policy"]).not.toContain("https://emoji.example.com/😀");
      expect(res.body).toBe(appHtml);
    });

    it("emits trusted default CSP headers for an empty normalized CSP", async () => {
      const appHtml = "<h1>Original App</h1>";
      handle = await startUiServer(
        createServerOptions({
          resource: createMockResource({
            html: appHtml,
            meta: { permissions: {}, csp: {} },
          }),
        }),
      );

      const res = await request(await getUiAppUrl(handle));

      expect(res.status).toBe(200);
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
      expect(res.body).toBe(appHtml);
    });

    it("emits restrictive default CSP when metadata is undefined", async () => {
      handle = await startUiServer(createServerOptions());
      const url = await getUiAppUrl(handle);

      const res = await request(url);

      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(res.body).toBe("<h1>Test App</h1>");
    });
  });

  describe("GET /health", () => {
    it("returns healthy status", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/health?session=${handle.sessionToken}`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { healthy: true } });
    });
  });

  describe("GET /app-bridge.bundle.js", () => {
    it("serves JavaScript bundle", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/app-bridge.bundle.js`;

      const res = await request(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("javascript");
      expect(res.headers["cache-control"]).toContain("max-age");
      expect(res.body).toBe(
        await readFile(new URL("../app-bridge.bundle.js", import.meta.url), "utf8"),
      );
    });
  });

  describe("GET /events (SSE)", () => {
    it("receives tool-result event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(50);
      handle.sendToolResult({ content: [{ type: "text", text: "hello" }] });
      await delay(50);
      sse.close();

      expect(events.some((e) => e.name === "tool-result")).toBe(true);
    });

    it("receives result-patch events when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(50);
      handle.sendResultPatch({
        content: [{ type: "text", text: "phase" }],
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
            status: "ok",
            spec: { kind: "mermaid", title: "Draft" },
          },
        },
      });
      await delay(50);
      sse.close();

      const patch = events.find((e) => e.name === "result-patch");
      expect(patch).toBeTruthy();
      expect(patch?.data).toMatchObject({
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
          },
        },
      });
    });

    it("replays events after Last-Event-ID using SSE ids", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const firstConnectionEvents: Array<{ name: string; data: unknown; id?: string | undefined }> =
        [];
      const firstConnection = await connectSSE(url, (name, data, eventId) => {
        firstConnectionEvents.push({ name, data, id: eventId });
      });

      await delay(50);
      handle.sendResultPatch({
        content: [{ type: "text", text: "shell" }],
        structuredContent: {
          "pi-mcp-adapter/stream": {
            streamId: "stream-1",
            sequence: 0,
            frameType: "checkpoint",
            phase: "shell",
            status: "ok",
            checkpoint: { kind: "mermaid", title: "Flow", code: "graph LR\nA-->B" },
          },
        },
      });
      handle.sendToolResult({ content: [{ type: "text", text: "final" }] });
      await delay(50);
      firstConnection.close();

      const checkpointEvent = firstConnectionEvents.find((event) => event.name === "result-patch");
      expect(checkpointEvent?.id).toBeTruthy();

      const replayedEvents: Array<{ name: string; data: unknown; id?: string | undefined }> = [];
      const replayConnection = await connectSSE(
        url,
        (name, data, eventId) => {
          replayedEvents.push({ name, data, id: eventId });
        },
        { "Last-Event-ID": checkpointEvent?.id ?? "" },
      );

      await delay(50);
      replayConnection.close();

      expect(replayedEvents.map((event) => event.name)).toEqual(["tool-result"]);
    });

    it("receives tool-cancelled event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(50);
      handle.sendToolCancelled("user cancelled");
      await delay(50);
      sse.close();

      const cancelled = events.find((e) => e.name === "tool-cancelled");
      expect(cancelled).toBeTruthy();
      expect(cancelled?.data).toEqual({ reason: "user cancelled" });
    });

    it("receives host-context event when sent", async () => {
      handle = await startUiServer(createServerOptions());
      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;

      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(50);
      handle.sendHostContext({ displayMode: "fullscreen" });
      await delay(50);
      sse.close();

      const ctx = events.find((e) => e.name === "host-context");
      expect(ctx).toBeTruthy();
      expect(ctx?.data).toEqual({ displayMode: "fullscreen" });
    });
  });

  describe("POST /proxy/tools/call", () => {
    it("proxies tool call to MCP server", async () => {
      const mockClient = createClient({
        callTool: vi
          .fn<Client["callTool"]>()
          .mockResolvedValue({ content: [{ type: "text", text: "tool result" }] }),
      });
      const requestOptions = { timeout: 4321 };
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: mockClient,
            tools: [{ name: "some_tool", inputSchema: { type: "object" } }],
          }),
        ),
        getRequestOptions: vi
          .fn<McpServerManager["getRequestOptions"]>()
          .mockReturnValue(requestOptions),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: { arg1: "value1" } },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        result: { content: [{ type: "text", text: "tool result" }] },
      });
      expect(vi.spyOn(manager, "getRequestOptions")).toHaveBeenCalledWith("test-server");
      expect(vi.spyOn(mockClient, "callTool")).toHaveBeenCalledWith(
        {
          name: "some_tool",
          arguments: { arg1: "value1" },
        },
        requestOptions,
      );
    });

    it("applies includeTools and excludeTools to app calls", async () => {
      const mockClient = createClient({
        callTool: vi
          .fn<Client["callTool"]>()
          .mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
      });
      const definition = {
        command: "demo",
        includeTools: ["open_ui", "excluded"],
        excludeTools: ["excluded"],
      };
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            definition,
            client: mockClient,
            tools: ["open_ui", "excluded", "not_included"].map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          }),
        ),
      });
      handle = await startUiServer(
        createServerOptions({
          manager,
          config: { mcpServers: { "test-server": definition } },
        }),
      );

      for (const name of ["excluded", "not_included"]) {
        const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
          method: "POST",
          body: { token: handle.sessionToken, params: { name, arguments: {} } },
        });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          ok: false,
          error: `MCP tool "${name}" is not callable by apps`,
        });
      }
      expect(vi.spyOn(mockClient, "callTool")).not.toHaveBeenCalled();

      const allowed = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { name: "open_ui", arguments: {} } },
      });
      expect(allowed.status).toBe(200);
      expect(vi.spyOn(mockClient, "callTool")).toHaveBeenCalledTimes(1);
    });

    it("returns a gated iframe call as an approval_denied tool result", async () => {
      const mockClient = createClient({ callTool: vi.fn<Client["callTool"]>() });
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: mockClient,
            tools: [{ name: "some_tool", inputSchema: { type: "object" } }],
          }),
        ),
      });
      const config: McpConfig = {
        mcpServers: { "test-server": { command: "demo", approveTools: true } },
      };
      const context = await createTestExtensionContext();
      cleanups.push(context.dispose);
      vi.spyOn(context.context.ui, "select").mockResolvedValue("Deny");
      const state = createTestState({ config, manager, ui: context.context.ui });
      handle = await startUiServer(createServerOptions({ manager, config, state }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: { dangerous: true } },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        result: {
          details: { error: "approval_denied", server: "test-server", tool: "some_tool" },
        },
      });
      expect(vi.spyOn(mockClient, "callTool")).not.toHaveBeenCalled();
    });

    it("checks consent before calling tool", async () => {
      const consentManager = createMockConsentManager({
        ensureApproved: vi.fn<() => void>().mockImplementation(() => {
          throw new Error("Consent denied");
        }),
      });
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(vi.spyOn(consentManager, "ensureApproved")).toHaveBeenCalledWith("test-server");
    });

    it("returns 503 when server not connected", async () => {
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>(),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(503);
      assert(
        res.body !== null &&
          typeof res.body === "object" &&
          "error" in res.body &&
          typeof res.body.error === "string",
      );
      expect(res.body.error).toContain("not connected");
    });

    it("rejects app calls to tools that omit app visibility", async () => {
      const mockClient = createClient({ callTool: vi.fn<Client["callTool"]>() });
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: mockClient,
            tools: [
              {
                name: "model_only",
                inputSchema: { type: "object" },
                _meta: { ui: { visibility: ["model"] } },
              },
            ],
          }),
        ),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "model_only", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        ok: false,
        error: 'MCP tool "model_only" is not callable by apps',
      });
      expect(vi.spyOn(mockClient, "callTool")).not.toHaveBeenCalled();
    });

    it("rejects app calls when the tool definition is unavailable", async () => {
      const mockClient = createClient({ callTool: vi.fn<Client["callTool"]>() });
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: mockClient,
            tools: [],
          }),
        ),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "unlisted", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'MCP tool "unlisted" is not callable by apps' });
      expect(vi.spyOn(mockClient, "callTool")).not.toHaveBeenCalled();
    });

    it("rejects unknown app tools from an empty native catalog", async () => {
      const mockClient = createClient({ callTool: vi.fn<Client["callTool"]>() });
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: mockClient,
            tools: [],
          }),
        ),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "unknown", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'MCP tool "unknown" is not callable by apps' });
      expect(vi.spyOn(mockClient, "callTool")).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid params", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "" }, // Empty name
        },
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid session token", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: "wrong-token",
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(res.status).toBe(403);
    });

    it("rejects anonymous tool calls", async () => {
      const callTool = vi.fn<Client["callTool"]>();
      const manager = createMockManager({
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            status: "connected",
            client: createClient({ callTool }),
            tools: [{ name: "some_tool", inputSchema: { type: "object" } }],
          }),
        ),
      });
      handle = await startUiServer(createServerOptions({ manager }));

      const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: { params: { name: "some_tool", arguments: {} } },
      });

      expect(res.status).toBe(403);
      expect(callTool).not.toHaveBeenCalled();
    });

    it("tracks in-flight requests", async () => {
      const manager = createMockManager();
      handle = await startUiServer(createServerOptions({ manager }));

      await request(`http://localhost:${handle.port}/proxy/tools/call`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { name: "some_tool", arguments: {} },
        },
      });

      expect(vi.spyOn(manager, "incrementInFlight")).toHaveBeenCalledWith("test-server");
      expect(vi.spyOn(manager, "decrementInFlight")).toHaveBeenCalledWith("test-server");
      expect(vi.spyOn(manager, "touch")).toHaveBeenCalled();
    });
  });

  describe("POST /proxy/ui/consent", () => {
    it("rejects anonymous approval", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: { params: { approved: true } },
      });

      expect(res.status).toBe(403);
      expect(vi.spyOn(consentManager, "registerDecision")).not.toHaveBeenCalled();
    });

    it("registers approval", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { approved: true },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { approved: true } });
      expect(vi.spyOn(consentManager, "registerDecision")).toHaveBeenCalledWith(
        "test-server",
        true,
      );
    });

    it("registers denial", async () => {
      const consentManager = createMockConsentManager();
      handle = await startUiServer(createServerOptions({ consentManager }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/consent`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { approved: false },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { approved: false } });
      expect(vi.spyOn(consentManager, "registerDecision")).toHaveBeenCalledWith(
        "test-server",
        false,
      );
    });
  });

  describe("POST /proxy/ui/message", () => {
    it.each([
      { role: 7 },
      { content: "not an array" },
      { type: "unsupported" },
      { message: 7 },
      { prompt: false },
      { intent: [] },
      { params: [] },
    ])("rejects malformed known message fields: %j", async (params) => {
      const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
      handle = await startUiServer(createServerOptions({ onMessage }));
      const res = await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params },
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid UI message params" });
      expect(onMessage).not.toHaveBeenCalled();
      expect(handle.getSessionMessages()).toEqual({
        prompts: [],
        intents: [],
        notifications: [],
        contexts: [],
      });
    });

    it("forwards message extensions and round-trips arbitrary intent parameters on disk", async () => {
      const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
      handle = await startUiServer(createServerOptions({ onMessage }));
      const params = {
        type: "intent",
        intent: "inspect",
        params: { node: "雪😀", extension: { values: [null, 7, true] } },
        _meta: { vendor: "unchanged" },
        vendor: { opaque: ["extension"] },
      };
      const res = await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params },
      });
      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(params);
      const messages = handle.getSessionMessages();
      assert(messages.historyRef !== undefined && messages.historyRef !== "");
      const record: unknown = JSON.parse(await readFile(messages.historyRef, "utf8"));
      expect(record).toEqual({
        category: "intents",
        value: { intent: params.intent, params: params.params },
      });
      expect((await materializeUiMessages(messages)).intents).toEqual([
        { intent: params.intent, params: params.params },
      ]);
    });

    it("acknowledges failed persistence with recovery data and an operator warning", async () => {
      const root = await mkdtemp(join(tmpdir(), "mcp-ui-server-failure-"));
      try {
        const blocked = join(root, "blocked");
        await writeFile(blocked, "not a directory");
        const context = await createTestExtensionContext();
        cleanups.push(context.dispose);
        const notify = vi.spyOn(context.context.ui, "notify");
        const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
        handle = await startUiServer(
          createServerOptions({
            state: createTestState({ outputDirectory: blocked, ui: context.context.ui }),
            onMessage,
          }),
        );
        const res = await request(`http://localhost:${handle.port}/proxy/ui/message`, {
          method: "POST",
          body: {
            token: handle.sessionToken,
            params: { type: "prompt", prompt: "recover this message" },
          },
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true });
        assert(
          res.body !== null &&
            typeof res.body === "object" &&
            "warning" in res.body &&
            typeof res.body.warning === "string",
        );
        expect(res.body.warning).toContain("remain in memory");
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("remain in memory"), "warning");
        expect(res.body.warning).toContain("lost on reload or process exit");
        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining("lost on reload or process exit"),
          "warning",
        );
        expect(onMessage).toHaveBeenCalledWith({ type: "prompt", prompt: "recover this message" });
        expect((await materializeUiMessages(handle.getSessionMessages())).prompts).toEqual([
          "recover this message",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("rejects anonymous messages", async () => {
      const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
      handle = await startUiServer(createServerOptions({ onMessage }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { params: { type: "prompt", prompt: "Injected" } },
      });

      expect(res.status).toBe(403);
      expect(handle.getSessionMessages().prompts).toEqual([]);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("tracks prompt messages", async () => {
      const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
      handle = await startUiServer(createServerOptions({ onMessage }));

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { type: "prompt", prompt: "Hello agent" },
        },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toContain("Hello agent");
      expect(onMessage).toHaveBeenCalled();
    });

    it("tracks intent messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { type: "intent", intent: "navigate", params: { to: "/home" } },
        },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.intents).toEqual([{ intent: "navigate", params: { to: "/home" } }]);
    });

    it("tracks notification messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { type: "notify", message: "User clicked button" },
        },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.notifications).toContain("User clicked button");
    });

    it("handles legacy prompt format", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { prompt: "Legacy prompt" }, // No type field
        },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toContain("Legacy prompt");
    });

    it("handles native AppBridge user messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: {
            role: "user",
            content: [{ type: "text", text: "Native AppBridge prompt" }],
          },
        },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toContain("Native AppBridge prompt");
    });

    it("accumulates multiple messages", async () => {
      handle = await startUiServer(createServerOptions());

      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "prompt", prompt: "First" } },
      });
      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "prompt", prompt: "Second" } },
      });
      await request(`http://localhost:${handle.port}/proxy/ui/message`, {
        method: "POST",
        body: { token: handle.sessionToken, params: { type: "notify", message: "Info" } },
      });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toEqual(["First", "Second"]);
      expect(messages.notifications).toEqual(["Info"]);
    });
  });

  describe("POST /proxy/ui/request-display-mode", () => {
    it("changes display mode to fullscreen", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { mode: "fullscreen" } });
    });

    it("changes display mode to pip", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "pip" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { mode: "pip" } });
    });

    it("rejects unavailable mode", async () => {
      handle = await startUiServer(
        createServerOptions({
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
        }),
      );

      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      // Should return current mode, not requested
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: { mode: "inline" } });
    });
  });

  describe("POST /proxy/ui/heartbeat", () => {
    it("responds with success", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/heartbeat`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: {} });
    });
  });

  describe("POST /proxy/ui/complete", () => {
    it("marks session complete with reason", async () => {
      const onComplete = vi.fn<NonNullable<UiServerOptions["onComplete"]>>();
      handle = await startUiServer(createServerOptions({ onComplete }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/complete`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { reason: "user-done" },
        },
      });

      expect(res.status).toBe(200);
      expect(onComplete).toHaveBeenCalledWith("user-done");
    });

    it("uses default reason when not provided", async () => {
      const onComplete = vi.fn<NonNullable<UiServerOptions["onComplete"]>>();
      handle = await startUiServer(createServerOptions({ onComplete }));

      await request(`http://localhost:${handle.port}/proxy/ui/complete`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(onComplete).toHaveBeenCalledWith("done");
    });
  });

  describe("POST /proxy/ui/open-link", () => {
    it("validates URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { url: "https://example.com" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: {} });
    });

    it("returns error for invalid URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { url: "not-a-valid-url" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { isError: true } });
    });

    it("returns 400 for missing URL", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/open-link`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /proxy/ui/download-file", () => {
    it("returns not supported", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/download-file`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, result: { isError: true } });
    });
  });

  describe("POST /proxy/ui/context", () => {
    it("stores and forwards context updates", async () => {
      const onContextUpdate = vi.fn<NonNullable<UiServerOptions["onContextUpdate"]>>();
      handle = await startUiServer(createServerOptions({ onContextUpdate }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { content: [{ type: "text", text: "some context data" }] },
        },
      });

      expect(res.status).toBe(200);
      expect(onContextUpdate).toHaveBeenCalledWith({
        content: [{ type: "text", text: "some context data" }],
      });
      expect(handle.getSessionMessages().contexts).toEqual([
        {
          payload: { content: [{ type: "text", text: "some context data" }] },
          summary: '{"content":[{"type":"text","text":"some context data"}]}',
          truncated: false,
        },
      ]);
    });

    it("preserves context extensions in the callback and retained payload", async () => {
      const onContextUpdate = vi.fn<NonNullable<UiServerOptions["onContextUpdate"]>>();
      handle = await startUiServer(createServerOptions({ onContextUpdate }));
      const params = {
        content: [
          {
            type: "text",
            text: "selection",
            _meta: { vendor: "block" },
            vendor: { opaque: ["retained block extension"] },
          },
        ],
        structuredContent: { selected: "雪😀" },
        _meta: { progressToken: "selection-7" },
        vendor: { opaque: [null, 7, true] },
      };
      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: { token: handle.sessionToken, params },
      });
      expect(res.status).toBe(200);
      expect(onContextUpdate).toHaveBeenCalledExactlyOnceWith(params);
      expect(handle.getSessionMessages().contexts).toEqual([
        { payload: params, summary: JSON.stringify(params), truncated: false },
      ]);
    });

    it.each([
      { content: "some context data" },
      { content: [{ type: "text", text: 42 }] },
      { structuredContent: [] },
    ])("rejects malformed context updates: %j", async (params) => {
      const onContextUpdate = vi.fn<NonNullable<UiServerOptions["onContextUpdate"]>>();
      handle = await startUiServer(createServerOptions({ onContextUpdate }));

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params,
        },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "Invalid update-model-context params" });
      expect(onContextUpdate).not.toHaveBeenCalled();
      expect(handle.getSessionMessages().contexts).toEqual([]);
    });

    it("bounds oversized context updates", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/ui/context`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { content: [{ type: "text", text: "x".repeat(12_100) }] },
        },
      });

      expect(res.status).toBe(200);
      expect(handle.getSessionMessages().contexts[0]).toMatchObject({ truncated: true });
      const context = handle.getSessionMessages().contexts[0];
      assert(context);
      expect(context.summary.length).toBeLessThanOrEqual(12_000);
      expect(context.payload).toBeUndefined();
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown GET routes", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(
        `http://localhost:${handle.port}/unknown?session=${handle.sessionToken}`,
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 for unknown POST routes", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await request(`http://localhost:${handle.port}/proxy/unknown`, {
        method: "POST",
        body: { token: handle.sessionToken, params: {} },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("handle.close()", () => {
    it("marks session complete", async () => {
      const onComplete = vi.fn<NonNullable<UiServerOptions["onComplete"]>>();
      handle = await startUiServer(createServerOptions({ onComplete }));

      handle.close("manual-close");

      expect(onComplete).toHaveBeenCalledWith("manual-close");
    });

    it("uses default reason when not provided", async () => {
      const onComplete = vi.fn<NonNullable<UiServerOptions["onComplete"]>>();
      handle = await startUiServer(createServerOptions({ onComplete }));

      handle.close();

      expect(onComplete).toHaveBeenCalledWith("closed");
    });
  });

  describe("initialResultPromise", () => {
    it("pushes result when promise resolves", async () => {
      const resultPromise: UiServerOptions["initialResultPromise"] = Promise.resolve({
        content: [{ type: "text", text: "initial" }],
      });
      handle = await startUiServer(createServerOptions({ initialResultPromise: resultPromise }));

      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;
      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(100);
      sse.close();

      expect(events.some((e) => e.name === "tool-result")).toBe(true);
    });

    it("pushes cancelled when promise rejects", async () => {
      const resultPromise = Promise.reject(new Error("Tool failed"));
      handle = await startUiServer(createServerOptions({ initialResultPromise: resultPromise }));

      const url = `http://localhost:${handle.port}/events?session=${handle.sessionToken}`;
      const events: Array<{ name: string; data: unknown }> = [];
      const sse = await connectSSE(url, (name, data) => {
        events.push({ name, data });
      });

      await delay(100);
      sse.close();

      const cancelled = events.find((e) => e.name === "tool-cancelled");
      expect(cancelled).toBeTruthy();
      assert(
        cancelled?.data !== null &&
          typeof cancelled?.data === "object" &&
          "reason" in cancelled.data &&
          typeof cancelled.data.reason === "string",
      );
      expect(cancelled.data.reason).toContain("Tool failed");
    });
  });

  describe("body parsing", () => {
    it("rejects non-JSON body", async () => {
      handle = await startUiServer(createServerOptions());

      const res = await fetch(`http://localhost:${handle.port}/proxy/ui/heartbeat`, {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "text/plain" },
      });

      expect(res.status).toBe(400);
    });

    it("rejects empty body", async () => {
      handle = await startUiServer(createServerOptions());

      const parsed = new URL(`http://localhost:${handle.port}/proxy/ui/heartbeat`);
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end(); // No body
      });

      expect(result.status).toBe(400);
    });
  });
});
