import { describe, it, expect, vi } from "vitest";
import { UiResourceHandler } from "../ui-resource-handler.ts";
import { buildCspMetaContent } from "../host-html-template.ts";
import { SdkError, SdkErrorCode, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import type { McpServerManager } from "../server-manager.ts";
import { createMockManager, createConnection } from "./fixtures/strict-ui-boundaries-manager.ts";

import assert from "node:assert/strict";
import { UiBoundaryWire, connectUiBoundaryWire } from "./fixtures/strict-ui-boundaries-wire.ts";

describe("UiResourceHandler", () => {
  describe("readUiResource", () => {
    it("throws for non-ui:// URIs", async () => {
      const manager = createMockManager();
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "https://example.com")).rejects.toThrow(
        /URI must start with ui:\/\//,
      );
    });

    it("preserves URL-required errors for the outer tool adapter", async () => {
      const error = new UrlElicitationRequiredError([
        {
          mode: "url",
          message: "Connect",
          elicitationId: "connect-1",
          url: "https://example.com/connect",
        },
      ]);
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockRejectedValue(error),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toBe(error);
    });

    it("recovers a terminated HTTP session while loading a UI resource", async () => {
      const wire = new UiBoundaryWire();
      const manager = await connectUiBoundaryWire(wire, "server");
      try {
        const stale = manager.getConnection("server");
        assert(stale);
        const staleRead = vi.spyOn(stale.client, "readResource");
        const reconnect = vi.spyOn(manager, "reconnect");
        const increment = vi.spyOn(manager, "incrementInFlight");
        const decrement = vi.spyOn(manager, "decrementInFlight");
        const config = { mcpServers: { server: wire.definition() } };
        wire.expired = true;
        const handler = new UiResourceHandler(manager);
        const result = await handler.readUiResource("server", "ui://test/widget", { config });
        expect(result.html).toBe("<h1>Recovered</h1>");
        expect(staleRead).toHaveBeenCalledTimes(1);
        expect(wire.calls.filter((call) => call.method === "resources/read")).toEqual([
          { method: "resources/read", session: "session-1" },
          { method: "resources/read", session: "session-2" },
        ]);
        expect(reconnect).toHaveBeenCalledWith("server", config.mcpServers.server, stale);
        expect(increment).toHaveBeenCalledWith("server");
        expect(decrement).toHaveBeenCalledWith("server");
      } finally {
        await manager.closeAll();
        await wire.close();
      }
    });

    it("reads and returns HTML from text content", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Hello</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.uri).toBe("ui://test/widget");
      expect(result.html).toBe("<h1>Hello</h1>");
      expect(result.mimeType).toBe("text/html");
    });

    it("reads and decodes blob content", async () => {
      const htmlContent = "<div>Blob content</div>";
      const base64Content = Buffer.from(htmlContent).toString("base64");

      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              blob: base64Content,
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe(htmlContent);
    });

    it("throws for empty content", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "   ",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        /content is empty/,
      );
    });

    it("throws for unsupported MIME type", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "application/json",
              text: '{"key": "value"}',
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
        /unsupported MIME type/,
      );
    });

    it("accepts text/html;profile=mcp-app MIME type", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html;profile=mcp-app",
              text: "<app>content</app>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<app>content</app>");
    });

    it("throws when no contents returned", async () => {
      const wire = new UiBoundaryWire();
      const manager = await connectUiBoundaryWire(wire, "server");
      try {
        wire.resourceResult = { contents: [] };
        const handler = new UiResourceHandler(manager);
        await expect(handler.readUiResource("server", "ui://test/widget")).rejects.toThrow(
          "No contents returned for UI resource: ui://test/widget",
        );
      } finally {
        await manager.closeAll();
        await wire.close();
      }
    });

    it("prefers content with matching URI", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://other/widget",
              mimeType: "text/html",
              text: "<h1>Wrong</h1>",
            },
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Correct</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<h1>Correct</h1>");
    });

    it("falls back to first HTML content if no URI match", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://other/json",
              mimeType: "application/json",
              text: "{}",
            },
            {
              uri: "ui://other/html",
              mimeType: "text/html",
              text: "<h1>HTML</h1>",
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.html).toBe("<h1>HTML</h1>");
    });

    it("extracts standard resourceDomains CSP metadata", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: ["https://esm.sh"],
                    connectDomains: ["https://esm.sh"],
                  },
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      });
    });

    it("normalizes OpenAI widget CSP metadata from resource content", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                "openai/widgetCSP": {
                  resource_domains: ["https://cdn.example.com"],
                  connect_domains: ["https://api.example.com"],
                  frame_domains: ["https://frames.example.com"],
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://frames.example.com"],
      });
    });

    it("normalizes OpenAI widget CSP metadata from resources/list", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
            },
          ],
        }),
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            resources: [
              {
                uri: "ui://test/widget",
                name: "widget",
                _meta: {
                  "openai/widgetCSP": {
                    resource_domains: ["https://cdn.example.com"],
                    connect_domains: ["https://api.example.com"],
                  },
                },
              },
            ],
          }),
        ),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
      });
    });

    it("lets standard CSP fields override equivalent OpenAI compatibility fields", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: ["https://standard.example.com"],
                  },
                },
                "openai/widgetCSP": {
                  resource_domains: ["https://openai.example.com"],
                  connect_domains: ["https://api.example.com"],
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://standard.example.com"],
        connectDomains: ["https://api.example.com"],
      });
    });

    it("copies only string arrays from standard and OpenAI CSP metadata", async () => {
      const standardResourceDomains = ["https://standard.example.com"];
      const standardBaseUriDomains = ["https://base.example.com"];
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: standardResourceDomains,
                    connectDomains: ["https://mixed.example.com", 42],
                    frameDomains: "https://scalar.example.com",
                    baseUriDomains: standardBaseUriDomains,
                  },
                },
                "openai/widgetCSP": {
                  resource_domains: ["https://mixed-openai.example.com", null],
                  connect_domains: ["https://api.example.com"],
                  frame_domains: ["https://frames.example.com"],
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: standardResourceDomains,
        baseUriDomains: standardBaseUriDomains,
      });
      expect(result.meta.csp?.resourceDomains).not.toBe(standardResourceDomains);
    });

    it.each([
      ["standard array", { ui: { csp: [] } }],
      ["standard scalar", { ui: { csp: "invalid" } }],
      ["standard null", { ui: { csp: null } }],
      ["OpenAI array", { "openai/widgetCSP": [] }],
      ["OpenAI scalar", { "openai/widgetCSP": "invalid" }],
      ["OpenAI null", { "openai/widgetCSP": null }],
    ])(
      "normalizes a declared malformed %s CSP container to an empty policy",
      async (_description, meta) => {
        const manager = createMockManager({
          readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
            contents: [
              {
                uri: "ui://test/widget",
                mimeType: "text/html",
                text: "<h1>Content</h1>",
                _meta: meta,
              },
            ],
          }),
        });
        const handler = new UiResourceHandler(manager);

        const result = await handler.readUiResource("server", "ui://test/widget");

        expect(result.meta.csp).toEqual({});
      },
    );

    it("fails closed when a null standard CSP is combined with valid OpenAI widget CSP", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: { csp: null },
                "openai/widgetCSP": {
                  resource_domains: ["https://attacker.example"],
                  connect_domains: ["https://attacker.example"],
                  frame_domains: ["https://attacker.example"],
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({});
      expect(buildCspMetaContent(result.meta.csp)).toBe(
        "default-src 'none'; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'",
      );
    });

    it("does not fall back to an OpenAI field when its standard equivalent is malformed", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: { csp: { resourceDomains: "not-an-array" } },
                "openai/widgetCSP": {
                  resource_domains: ["https://attacker.example"],
                  connect_domains: ["https://api.example.com"],
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({ connectDomains: ["https://api.example.com"] });
      expect(buildCspMetaContent(result.meta.csp)).not.toContain("https://attacker.example");
    });

    it("prefers a declared malformed content CSP over resource-list CSP", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: { ui: { csp: null } },
            },
          ],
        }),
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            resources: [
              {
                uri: "ui://test/widget",
                name: "widget",
                _meta: {
                  "openai/widgetCSP": {
                    resource_domains: ["https://list.example.com"],
                  },
                },
              },
            ],
          }),
        ),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({});
    });

    it("prefers conflicting content CSP over resource-list CSP", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  csp: {
                    resourceDomains: ["https://content.example.com"],
                  },
                },
              },
            },
          ],
        }),
        getConnection: vi.fn<McpServerManager["getConnection"]>().mockReturnValue(
          createConnection({
            resources: [
              {
                uri: "ui://test/widget",
                name: "widget",
                _meta: {
                  "openai/widgetCSP": {
                    resource_domains: ["https://list.example.com"],
                  },
                },
              },
            ],
          }),
        ),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.csp).toEqual({
        resourceDomains: ["https://content.example.com"],
      });
    });

    it("extracts permissions meta", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  permissions: {
                    camera: {},
                    microphone: {},
                  },
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.permissions).toEqual({
        camera: {},
        microphone: {},
      });
    });

    it("extracts domain and prefersBorder meta", async () => {
      const manager = createMockManager({
        readResource: vi.fn<McpServerManager["readResource"]>().mockResolvedValue({
          contents: [
            {
              uri: "ui://test/widget",
              mimeType: "text/html",
              text: "<h1>Content</h1>",
              _meta: {
                ui: {
                  domain: "example.com",
                  prefersBorder: true,
                },
              },
            },
          ],
        }),
      });
      const handler = new UiResourceHandler(manager);

      const result = await handler.readUiResource("server", "ui://test/widget");

      expect(result.meta.domain).toBe("example.com");
      expect(result.meta.prefersBorder).toBe(true);
    });

    it("throws when content has no text or blob", async () => {
      const wire = new UiBoundaryWire();
      const manager = await connectUiBoundaryWire(wire, "server");
      try {
        wire.resourceResult = { contents: [{ uri: "ui://test/widget", mimeType: "text/html" }] };
        const handler = new UiResourceHandler(manager);
        const failure: unknown = await handler
          .readUiResource("server", "ui://test/widget")
          .catch((error: unknown) => error);
        assert(failure instanceof Error);
        expect(failure.message).toContain(
          'Failed to fetch UI resource "ui://test/widget": Invalid result for resources/read',
        );
        assert(failure.cause instanceof SdkError);
        expect(failure.cause.code).toBe(SdkErrorCode.InvalidResult);
        expect(failure.cause.message).toContain('"text"');
        expect(failure.cause.message).toContain('"blob"');
      } finally {
        await manager.closeAll();
        await wire.close();
      }
    });
  });
});
