/**
 * Integration tests for MCP UI flow
 *
 * These tests exercise the full flow from tool call with UI resource
 * through browser communication back to agent message retrieval.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import { hostConfiguration } from "./fixtures/host-document.ts";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./fixtures/strict-ui-boundaries-http.ts";
import { UiBoundaryWire, connectUiBoundaryWire } from "./fixtures/strict-ui-boundaries-wire.ts";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { materializeUiMessages } from "../ui-message-history.ts";
import { startUiServer, type UiServerHandle } from "../ui-server.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";
import { ConsentManager } from "../consent-manager.ts";
import type { McpServerManager } from "../server-manager.ts";
import type { UiResourceContent, UiSessionMessages } from "../types.ts";

// Simulate browser behavior
class BrowserSimulator {
  private readonly serverUrl: string;
  private readonly sessionToken: string;

  constructor(handle: UiServerHandle) {
    this.serverUrl = `http://localhost:${handle.port}`;
    this.sessionToken = handle.sessionToken;
  }

  async loadPage(): Promise<string> {
    const res = await request(`${this.serverUrl}/?session=${this.sessionToken}`);
    if (res.status !== 200) {
      throw new Error(`Page load failed: ${res.status}`);
    }
    assert(typeof res.body === "string");
    return res.body;
  }

  async sendPrompt(prompt: string): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "prompt", prompt },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Send prompt failed: ${res.status}`);
    }
  }

  async sendIntent(intent: string, params?: Record<string, unknown>): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "intent", intent, params },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Send intent failed: ${res.status}`);
    }
  }

  async sendNotification(message: string): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "notify", message },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Send notification failed: ${res.status}`);
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const res = await request(`${this.serverUrl}/proxy/tools/call`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { name, arguments: args },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Tool call failed: ${res.status}`);
    }
    assert(res.body !== null && typeof res.body === "object" && "result" in res.body);
    return res.body.result;
  }

  async grantConsent(): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/consent`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { approved: true },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Consent failed: ${res.status}`);
    }
  }

  async heartbeat(): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/heartbeat`, {
      method: "POST",
      body: { token: this.sessionToken, params: {} },
    });
    if (res.status !== 200) {
      throw new Error(`Heartbeat failed: ${res.status}`);
    }
  }

  async complete(reason = "done"): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/complete`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { reason },
      },
    });
    if (res.status !== 200) {
      throw new Error(`Complete failed: ${res.status}`);
    }
  }
}

const cleanups: Array<() => Promise<void>> = [];

async function createIntegrationManager(
  name = "test-server",
  toolError = false,
): Promise<McpServerManager> {
  const wire = new UiBoundaryWire();
  wire.tools = ["get_data", "save_file", "slow_operation", "failing_tool"].map((toolName) => ({
    name: toolName,
    inputSchema: { type: "object" },
  }));
  wire.resultText = JSON.stringify({ data: [1, 2, 3] });
  wire.toolError = toolError;
  wire.resourceResult = {
    contents: [
      {
        uri: "ui://test/app",
        mimeType: "text/html",
        text: "<!doctype html><html><head><title>Test App</title></head><body><h1>Test MCP App</h1><button id='getData'>Get Data</button><button id='sendPrompt'>Ask Agent</button></body></html>",
      },
    ],
  };
  const manager = await connectUiBoundaryWire(wire, name);
  cleanups.push(
    () => wire.close(),
    () => manager.closeAll(),
  );
  vi.spyOn(manager, "incrementInFlight");
  vi.spyOn(manager, "decrementInFlight");
  return manager;
}

function approvedConsentManager(): ConsentManager {
  const manager = new ConsentManager();
  for (const serverName of ["test-server", "chat-server", "error-server", "disconnected-server"]) {
    manager.registerDecision(serverName, true);
  }
  return manager;
}

describe("MCP UI Integration", () => {
  let handle: UiServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      const ref = handle.getSessionMessages().historyRef;
      handle.close("test-cleanup");
      if (ref !== undefined) {
        await rm(dirname(ref), { recursive: true, force: true });
      }
      handle = null;
    }
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  describe("Full UI Session Flow", () => {
    it("completes a full agent → browser → agent cycle", async () => {
      // 1. Agent calls tool with UI
      const manager = await createIntegrationManager();
      const consentManager = approvedConsentManager(); // No consent prompts

      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>Test App</h1>",
        mimeType: "text/html",
        meta: { permissions: {} },
      };

      const receivedMessages: Omit<UiSessionMessages, "contexts"> = {
        prompts: [],
        notifications: [],
        intents: [],
      };
      const onMessage = vi
        .fn<NonNullable<Parameters<typeof startUiServer>[0]["onMessage"]>>()
        .mockImplementation((params) => {
          if (params.type === "prompt" && params.prompt !== undefined) {
            receivedMessages.prompts.push(params.prompt);
          }
        });

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "launch_app",
        toolArgs: { mode: "interactive" },
        resource,
        manager,
        consentManager,
        onMessage,
      });

      // 2. Browser loads the page
      const browser = new BrowserSimulator(handle);
      const html = await browser.loadPage();
      expect(html).toContain("test-server");
      expect(html).toContain("launch_app");

      // 3. Browser calls a tool through the proxy
      const toolResult = await browser.callTool("get_data", { query: "test" });
      expect(toolResult).toBeDefined();

      // 4. Browser sends a prompt back to the agent
      await browser.sendPrompt("Please analyze this data and summarize");

      // 5. Agent retrieves the messages
      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toContain("Please analyze this data and summarize");

      // 6. Browser completes the session
      await browser.complete("user-done");
    });

    it("handles multiple messages in conversation", async () => {
      const manager = await createIntegrationManager("chat-server");
      const consentManager = approvedConsentManager();

      const resource: UiResourceContent = {
        uri: "ui://test/chat",
        html: "<div id='chat'></div>",
        mimeType: "text/html",
        meta: { permissions: {} },
      };

      handle = await startUiServer({
        serverName: "chat-server",
        toolName: "open_chat",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Simulate a multi-turn conversation
      await browser.sendPrompt("What is the capital of France?");
      await browser.sendNotification("User is typing...");
      await browser.sendPrompt("And what about Germany?");
      await browser.sendIntent("show_map", { countries: ["France", "Germany"] });

      const messages = await materializeUiMessages(handle.getSessionMessages());
      expect(messages.prompts).toHaveLength(2);
      expect(messages.prompts[0]).toBe("What is the capital of France?");
      expect(messages.prompts[1]).toBe("And what about Germany?");
      expect(messages.notifications).toHaveLength(1);
      expect(messages.intents).toHaveLength(1);
      expect(messages.intents[0]).toEqual({
        intent: "show_map",
        params: { countries: ["France", "Germany"] },
      });
    });

    it("handles consent flow for tool calls", async () => {
      const manager = await createIntegrationManager("sensitive-server");
      const consentManager = new ConsentManager();

      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>App</h1>",
        mimeType: "text/html",
        meta: { permissions: {} },
      };

      handle = await startUiServer({
        serverName: "sensitive-server",
        toolName: "admin_tool",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // First tool call should fail - no consent yet
      await expect(browser.callTool("get_data")).rejects.toThrow("403");

      // Grant consent
      await browser.grantConsent();

      // Now tool call should succeed
      const result = await browser.callTool("get_data");
      expect(result).toBeDefined();
    });

    it("tracks in-flight requests correctly", async () => {
      const manager = await createIntegrationManager();
      const consentManager = approvedConsentManager();

      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>App</h1>",
        mimeType: "text/html",
        meta: { permissions: {} },
      };

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Call multiple tools
      await Promise.all([browser.callTool("get_data"), browser.callTool("save_file")]);

      // Both should have incremented/decremented
      expect(vi.spyOn(manager, "incrementInFlight")).toHaveBeenCalledTimes(2);
      expect(vi.spyOn(manager, "decrementInFlight")).toHaveBeenCalledTimes(2);
    });
  });

  describe("UiResourceHandler + UiServer Integration", () => {
    it("reads resource and starts server with correct content", async () => {
      const manager = await createIntegrationManager();
      const handler = new UiResourceHandler(manager);

      // Read the UI resource
      const resource = await handler.readUiResource("test-server", "ui://test/app");
      expect(resource.html).toContain("Test MCP App");
      expect(resource.mimeType).toBe("text/html");

      // Start server with the resource
      const consentManager = approvedConsentManager();
      handle = await startUiServer({
        serverName: "test-server",
        toolName: "launch_app",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      const html = await browser.loadPage();
      const resourceToken = hostConfiguration(html).uiResourceToken;
      expect(resourceToken).toBeDefined();
      const response = await request(
        `http://localhost:${handle.port}/ui-app?resource=${encodeURIComponent(resourceToken)}`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toBe(resource.html);
    });
  });

  describe("Session Lifecycle", () => {
    it("calls onComplete when session ends", async () => {
      const onComplete = vi.fn<NonNullable<Parameters<typeof startUiServer>[0]["onComplete"]>>();
      const manager = await createIntegrationManager();
      const consentManager = approvedConsentManager();

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: {} },
        },
        manager,
        consentManager,
        onComplete,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();
      await browser.complete("user-finished");

      // Wait for callback
      await delay(50);
      expect(onComplete).toHaveBeenCalledWith("user-finished");
    });
  });

  describe("Error Handling", () => {
    it("handles MCP server errors gracefully", async () => {
      const manager = await createIntegrationManager("error-server", true);

      const consentManager = approvedConsentManager();

      handle = await startUiServer({
        serverName: "error-server",
        toolName: "error_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: {} },
        },
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Tool call should fail but not crash the server
      await expect(browser.callTool("failing_tool")).rejects.toThrow("500");

      // Server should still be responsive
      await browser.heartbeat();
    });

    it("handles disconnected server", async () => {
      const manager = await createIntegrationManager("disconnected-server");
      await manager.close("disconnected-server");

      const consentManager = approvedConsentManager();

      handle = await startUiServer({
        serverName: "disconnected-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: {} },
        },
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Tool call should fail with 503
      await expect(browser.callTool("any_tool")).rejects.toThrow("503");
    });
  });

  describe("Display Mode Changes", () => {
    it("allows switching display modes", async () => {
      const manager = await createIntegrationManager();
      const consentManager = approvedConsentManager();

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: {} },
        },
        manager,
        consentManager,
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen", "pip"],
        },
      });

      // Request fullscreen
      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: { mode: "fullscreen" } });
    });
  });
});
