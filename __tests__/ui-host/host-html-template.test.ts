import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { z } from "zod";
import {
  LATEST_PROTOCOL_VERSION,
  McpUiInitializeResultSchema,
} from "@modelcontextprotocol/ext-apps";
import { materializeUiMessages } from "../../ui-message-history.ts";
import { describe, it, expect, afterEach, vi } from "vitest";
import { hostConfiguration } from "../fixtures/host-document.ts";
import { closeHosts, openHost } from "../fixtures/host-runtime.ts";
import { readToolResult } from "../../host-browser-contracts.ts";
import type { UiServerOptions } from "../../ui-server-options.ts";

afterEach(closeHosts);
import { buildHostHtmlTemplate, type HostHtmlTemplateInput } from "../../host-html-template.ts";

function createMinimalInput(overrides: Partial<HostHtmlTemplateInput> = {}): HostHtmlTemplateInput {
  return {
    sessionToken: "test-token-123",
    uiResourceToken: "resource-token-456",
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: { arg1: "value1" },
    resource: {
      uri: "ui://test/widget",
      html: "<h1>Test Widget</h1>",
      mimeType: "text/html",
      meta: {},
    },
    allowAttribute: "",
    requireToolConsent: false,
    ...overrides,
  };
}

async function initializeApp(host: Awaited<ReturnType<typeof openHost>>): Promise<void> {
  host.dispatchWindow({
    jsonrpc: "2.0",
    id: "initialize",
    method: "ui/initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      appInfo: { name: "native-test-peer", version: "1" },
      appCapabilities: {},
    },
  });
  await vi.waitFor(() =>
    expect(
      host.appMessages.some(
        (message) =>
          z
            .object({
              id: z.literal("initialize"),
              result: McpUiInitializeResultSchema,
            })
            .safeParse(message).success,
      ),
    ).toBe(true),
  );
  host.dispatchWindow({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
}

describe("buildHostHtmlTemplate", () => {
  describe("structure", () => {
    it("generates valid HTML document", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("<!doctype html>");
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("</html>");
    });

    it("includes title with server and tool name", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "my-server", toolName: "my-tool" }),
      );

      expect(html).toContain("<title>MCP UI - my-server / my-tool</title>");
    });

    it("includes header with server and tool info", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "demo-server", toolName: "widget-tool" }),
      );

      expect(html).toContain('id="server-name"');
      expect(html).toContain('id="tool-name"');
      expect(html).toContain("Sandboxed");
    });

    it("includes iframe for app content", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('<iframe id="mcp-app"');
      expect(html).toContain(
        'sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"',
      );
      expect(html).not.toContain("allow-popups-to-escape-sandbox");
      expect(html).not.toContain("allow-same-origin");
      expect(html).toContain('referrerpolicy="no-referrer"');
    });

    it("rejects nested-frame protocol and raw messages by binding to the sandboxed app frame", async () => {
      const host = await openHost();
      const child = host.document.createElement("iframe");
      host.document.body.append(child);
      assert(child.contentWindow !== null);
      const ping = { jsonrpc: "2.0", id: "nested", method: "ping" };
      host.dispatchWindow(ping, child.contentWindow);
      host.dispatchWindow(
        { type: "prompt", prompt: "nested must not forward" },
        child.contentWindow,
      );
      host.dispatchWindow({ ...ping, id: "app" });
      host.dispatchWindow({ type: "prompt", prompt: "direct app message" });
      await vi.waitFor(() =>
        expect(host.appMessages).toContainEqual({ jsonrpc: "2.0", id: "app", result: {} }),
      );
      await host.settleRequests();
      expect(host.appMessages).not.toContainEqual(expect.objectContaining({ id: "nested" }));
      expect((await materializeUiMessages(host.handle.getSessionMessages())).prompts).toEqual([
        "direct app message",
      ]);
    });

    it("forwards raw app messages with their original fields", async () => {
      const onMessage = vi.fn<NonNullable<UiServerOptions["onMessage"]>>();
      const host = await openHost({ onMessage });
      const params = { node: "雪😀", ["__proto__"]: { own: "intent parameter" } };
      host.dispatchWindow({
        vendor: { opaque: ["raw extension"] },
        ["__proto__"]: { own: "top-level key" },
        method: "vendor/raw",
        type: "intent",
        payload: { intent: "inspect", params },
      });
      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
      const forwarded = {
        type: "intent",
        vendor: { opaque: ["raw extension"] },
        ["__proto__"]: { own: "top-level key" },
        method: "vendor/raw",
        intent: "inspect",
        params,
      };
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(forwarded);
      // Serialized text also proves key order, which deep equality ignores.
      expect(JSON.stringify(onMessage.mock.calls[0]?.[0])).toBe(JSON.stringify(forwarded));
      const { intents } = await materializeUiMessages(host.handle.getSessionMessages());
      expect(JSON.stringify(intents)).toBe(JSON.stringify([{ intent: "inspect", params }]));
    });

    it("includes control buttons", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain('id="done-btn"');
      expect(html).toContain('id="cancel-btn"');
    });

    it("includes mobile and in-app-browser host shell affordances", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("min-height: 100dvh");
      expect(html).toContain("env(safe-area-inset-top");
      expect(html).toContain("@media (max-width: 640px)");
      expect(html).toContain('id="completion-overlay"');
      // Close fallback and visibility recovery are exercised by the lifecycle owner.
      const dom = new JSDOM(html);
      expect(
        dom.window.document.getElementById("completion-overlay")?.classList.contains("visible"),
      ).toBe(false);
      dom.window.close();
    });
  });

  describe("data injection", () => {
    it("keeps the session token out of the sandboxed app URL", async () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          sessionToken: "secret-session-token",
          uiResourceToken: "app-resource-token",
        }),
      );
      expect(hostConfiguration(html)).toMatchObject({
        sessionToken: "secret-session-token",
        uiResourceToken: "app-resource-token",
      });
      const host = await openHost();
      const url = new URL(host.iframe.src);
      expect(url.pathname).toBe("/ui-app");
      expect([...url.searchParams.keys()]).toEqual(["resource"]);
      expect(url.searchParams.get("resource")).toBe(
        hostConfiguration(await (await fetch(host.handle.url)).text()).uiResourceToken,
      );
      expect(host.iframe.src).not.toContain(host.handle.sessionToken);
    });

    it("injects tool arguments", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ toolArgs: { location: "NYC", units: "metric" } }),
      );

      expect(html).toContain('"location"');
      expect(html).toContain('"NYC"');
      expect(html).toContain('"units"');
      expect(html).toContain('"metric"');
    });

    it("injects host context", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          hostContext: {
            displayMode: "fullscreen",
            theme: "dark",
          },
        }),
      );

      expect(html).toContain('"displayMode"');
      expect(html).toContain('"fullscreen"');
      expect(html).toContain('"theme"');
      expect(html).toContain('"dark"');
    });

    it("escapes HTML in injected values", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          toolArgs: { script: "<script>alert('xss')</script>" },
        }),
      );

      // Should be escaped
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("\\u003cscript\\u003e");
    });
  });

  describe("consent handling", () => {
    it("injects requireToolConsent=false", () => {
      const html = buildHostHtmlTemplate(createMinimalInput({ requireToolConsent: false }));

      expect(hostConfiguration(html).requireToolConsent).toBe(false);
    });

    it("injects requireToolConsent=true", () => {
      const html = buildHostHtmlTemplate(createMinimalInput({ requireToolConsent: true }));

      expect(hostConfiguration(html).requireToolConsent).toBe(true);
    });

    it("records explicit consent denials", async () => {
      const host = await openHost({ confirm: false });
      host.dispatchWindow({
        jsonrpc: "2.0",
        id: "denied",
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      });
      await vi.waitFor(() =>
        expect(host.appMessages).toContainEqual(
          expect.objectContaining({
            id: "denied",
            result: {
              isError: true,
              content: [{ type: "text", text: "Tool call denied by user." }],
            },
          }),
        ),
      );
      await host.settleRequests();
      expect(host.requests("/proxy/ui/consent").map((request) => request.status)).toEqual([200]);
      expect(host.requests("/proxy/tools/call")).toHaveLength(0);
    });
  });

  describe("iframe permissions", () => {
    it("sets allow attribute when provided", async () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ allowAttribute: "camera; microphone" }),
      );

      expect(hostConfiguration(html).allowAttribute).toBe("camera; microphone");
      const host = await openHost({ permissions: { camera: {}, microphone: {} } });
      expect(host.iframe.getAttribute("allow")).toBe("camera; microphone");
    });
  });

  describe("CSP handling", () => {
    it("maps standard resourceDomains to static resource directives", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://api.example.com"],
      });

      expect(csp).toBe(
        [
          "default-src 'none'",
          "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
          "script-src 'self' 'unsafe-inline' https://esm.sh",
          "style-src 'self' 'unsafe-inline' https://esm.sh",
          "font-src 'self' https://esm.sh",
          "img-src 'self' data: https://esm.sh",
          "media-src 'self' data: https://esm.sh",
          "connect-src https://api.example.com",
          "frame-src 'none'",
          "worker-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join("; "),
      );
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("rejects CSP source expressions that can inject directives", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: [
          "https://safe.example.com",
          "https://safe.example.com",
          "https://evil.example.com; script-src *",
          "https://evil.example.com\nimg-src",
          "https://evil.example.com\rimg-src",
          "https://evil.example.com\timg-src",
          "https://evil.example.com\fimg-src",
          "https://nul-evil.example.com\0img-src",
          "https://del-evil.example.com\x7Fimg-src",
          "https://two sources.example.com",
          'https://evil.example.com"img-src',
          "'unsafe-eval'",
          42,
        ],
      });

      expect(csp).toContain("https://safe.example.com");
      expect(csp.match(/https:\/\/safe\.example\.com/g)).toHaveLength(5);
      expect(csp).not.toContain("evil.example.com");
      expect(csp).not.toContain("nul-evil.example.com");
      expect(csp).not.toContain("del-evil.example.com");
      expect(csp).not.toContain("https://two sources.example.com");
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("rejects all control characters and non-ASCII CSP sources before serialization", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");
      const rejectedSources = [
        "https://vertical-tab.example.com\vimg-src",
        "https://unit-separator.example.com\x1Fimg-src",
        "https://c1-low.example.com\x80img-src",
        "https://c1-high.example.com\x9Fimg-src",
        "https://emoji.example.com/😀",
        "https://accent.example.com/café",
      ];

      const csp = buildCspMetaContent({
        resourceDomains: ["https://safe.example.com", ...rejectedSources],
      });

      expect(csp.match(/https:\/\/safe\.example\.com/g)).toHaveLength(5);
      for (const source of rejectedSources) {
        expect(csp).not.toContain(source);
      }
    });

    it("fails closed for malformed CSP domain containers", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");

      const csp = buildCspMetaContent({
        resourceDomains: {},
        connectDomains: "https://api.example.com",
      });

      expect(csp).toBe(
        [
          "default-src 'none'",
          "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' data:",
          "media-src 'self' data:",
          "connect-src 'none'",
          "frame-src 'none'",
          "worker-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join("; "),
      );
    });

    it("deduplicates frame and base URI domains", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");

      const csp = buildCspMetaContent({
        frameDomains: ["https://frames.example.com", "https://frames.example.com"],
        baseUriDomains: ["https://base.example.com", "https://base.example.com"],
      });

      expect(csp).toContain("frame-src https://frames.example.com");
      expect(csp).toContain("base-uri https://base.example.com");
      expect(csp.match(/https:\/\/frames\.example\.com/g)).toHaveLength(1);
      expect(csp.match(/https:\/\/base\.example\.com/g)).toHaveLength(1);
    });

    it("returns a restrictive default when the app declares no CSP metadata", async () => {
      const { buildCspMetaContent } = await import("../../host-html-template.ts");

      expect(buildCspMetaContent()).toBe(
        [
          "default-src 'none'",
          "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' data:",
          "media-src 'self' data:",
          "connect-src 'none'",
          "frame-src 'none'",
          "worker-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join("; "),
      );
    });
  });

  describe("module loading", () => {
    const importMap = (html: string): unknown =>
      JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? "null");
    // The year-long cached asset is content-addressed, so an upgraded host never
    // links against an earlier cached copy that lacks its imports.
    const sdkUrl = `/app-bridge.bundle.js?v=${createHash("sha256")
      .update(readFileSync(new URL("../../app-bridge.bundle.js", import.meta.url)))
      .digest("base64url")}`;

    it("uses default AppBridge module URL", () => {
      const html = buildHostHtmlTemplate(createMinimalInput());

      expect(html).toContain("/app-bridge.bundle.js");
      // The host shares the cached native SDK asset for its bridge, schemas and Zod.
      expect(importMap(html)).toEqual({
        imports: {
          "@modelcontextprotocol/ext-apps/app-bridge": sdkUrl,
          "@modelcontextprotocol/ext-apps": sdkUrl,
          "@modelcontextprotocol/core": sdkUrl,
          zod: sdkUrl,
        },
      });
    });

    it("uses custom AppBridge module URL when provided", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          appBridgeModuleUrl: "https://cdn.example.com/app-bridge.js",
        }),
      );

      expect(html).toContain("https://cdn.example.com/app-bridge.js");
      // A custom bridge supplies only AppBridge and PostMessageTransport; shared schemas stay local.
      expect(importMap(html)).toEqual({
        imports: {
          "@modelcontextprotocol/ext-apps/app-bridge": "https://cdn.example.com/app-bridge.js",
          "@modelcontextprotocol/ext-apps": sdkUrl,
          "@modelcontextprotocol/core": sdkUrl,
          zod: sdkUrl,
        },
      });
    });
  });

  describe("stream mode", () => {
    it("honors the native tool-result content default without dropping opaque fields", () => {
      expect(
        readToolResult({
          structuredContent: ["opaque", { nested: true }],
          vendor: { extension: "retained" },
        }),
      ).toEqual({
        content: [],
        structuredContent: ["opaque", { nested: true }],
        vendor: { extension: "retained" },
      });
      expect(
        readToolResult({
          content: [{ type: "text", text: "known", vendor: { opaque: "nested" } }],
        }),
      ).toEqual({
        content: [{ type: "text", text: "known", vendor: { opaque: "nested" } }],
      });
      expect(() => readToolResult({ content: "not native content" })).toThrow(
        "Invalid tool result",
      );
    });

    it("registers the stream patch notification method", async () => {
      const host = await openHost();
      await initializeApp(host);
      // A valid JSON result may use an own "__proto__" key; the app receives the original.
      const patch = {
        ["__proto__"]: { own: "result key" },
        content: [],
        structuredContent: { extension: { values: [1, "unknown"] } },
      };
      host.handle.sendResultPatch(patch);
      await vi.waitFor(() =>
        expect(host.appMessages).toContainEqual({
          jsonrpc: "2.0",
          method: "notifications/pi-mcp-adapter/ui-result-patch",
          params: patch,
        }),
      );
      const delivered = host.appMessages
        .map(
          (message) =>
            z
              .object({
                method: z.literal("notifications/pi-mcp-adapter/ui-result-patch"),
                params: z.unknown(),
              })
              .safeParse(message).data?.params,
        )
        .filter((params) => params !== undefined);
      expect(JSON.stringify(delivered)).toBe(JSON.stringify([patch]));
    });

    it.each(["stream-first", "eager"] as const)(
      "buffers early frames until initialization and sends initial tool input only in eager mode (%s)",
      async (mode) => {
        const toolArgs = { marker: "initial tool input" };
        const host = await openHost({
          toolArgs,
          hostContext: {
            "pi-mcp-adapter/stream": {
              mode,
              streamId: "stream-1",
              intermediateResultPatches: true,
              partialInput: false,
            },
          },
        });
        const patch = { content: [], structuredContent: { progress: "early" } };
        const result: Parameters<typeof host.handle.sendToolResult>[0] = {
          content: [{ type: "text", text: "complete" }],
        };
        host.handle.sendResultPatch(patch);
        host.handle.sendToolResult(result);
        await vi.waitFor(() =>
          expect(host.eventSource.receivedEvents).toEqual(["result-patch", "tool-result"]),
        );
        expect(host.appMessages).toEqual([]);
        await initializeApp(host);
        await vi.waitFor(() =>
          expect(host.appMessages).toContainEqual({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: result,
          }),
        );
        const methods = host.appMessages.flatMap((message) => {
          const parsed = z.object({ method: z.string() }).safeParse(message);
          return parsed.success ? [parsed.data.method] : [];
        });
        expect(methods).toEqual([
          ...(mode === "eager" ? ["ui/notifications/tool-input"] : []),
          "notifications/pi-mcp-adapter/ui-result-patch",
          "ui/notifications/tool-result",
        ]);
        await vi.waitFor(() =>
          expect(host.element("status").textContent).toBe(
            mode === "stream-first" ? "Streaming…" : "Connected",
          ),
        );
        const initial = {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: toolArgs },
        };
        const inputs = host.appMessages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "method" in message &&
            message.method === "ui/notifications/tool-input",
        );
        expect(inputs).toEqual(mode === "eager" ? [initial] : []);
        host.handle.sendToolInput({ marker: "subsequent input" });
        await vi.waitFor(() =>
          expect(host.appMessages).toContainEqual({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-input",
            params: { arguments: { marker: "subsequent input" } },
          }),
        );
        host.handle.sendToolResult({ content: [{ type: "text", text: "last before close" }] });
        host.handle.close("done");
        await host.teardownStarted;
        const ending = host.appMessages.slice(-2);
        expect(ending).toEqual([
          {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: { content: [{ type: "text", text: "last before close" }] },
          },
          expect.objectContaining({ method: "ui/resource-teardown" }),
        ]);
        host.respondToTeardowns();
      },
    );
  });

  describe("XSS prevention", () => {
    it("escapes server name in title", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ serverName: "<script>evil</script>" }),
      );

      expect(html).toContain("&lt;script&gt;evil&lt;/script&gt;");
      expect(html).not.toContain("<script>evil</script>");
    });

    it("escapes tool name in title", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({ toolName: '<img onerror="alert(1)">' }),
      );

      expect(html).toContain("&lt;img onerror=");
    });

    it("escapes unicode line/paragraph separators", () => {
      const html = buildHostHtmlTemplate(
        createMinimalInput({
          toolArgs: { text: "line\u2028separator\u2029here" },
        }),
      );

      // Should be escaped to prevent JS parsing issues
      expect(html).toContain("\\u2028");
      expect(html).toContain("\\u2029");
    });
  });
});
