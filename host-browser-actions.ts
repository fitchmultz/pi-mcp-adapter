import { z } from "zod";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  McpUiMessageRequestSchema,
  McpUiMessageResultSchema,
} from "@modelcontextprotocol/ext-apps";
import type { HostBrowserProxy } from "./host-browser-proxy.ts";
import type { HostBrowserView } from "./host-browser-view.ts";
import type { HostConfiguration } from "./host-browser-contracts.ts";

const rawMessageSchema = z.looseObject({
  type: z.string(),
  payload: z.unknown().optional(),
  jsonrpc: z.unknown().optional(),
  method: z.unknown().optional(),
});

function payloadFields(value: unknown): object {
  if (typeof value === "object" && value !== null) {
    return value;
  }
  if (typeof value === "string") {
    // Object spread exposes UTF-16 indexes, not Unicode code points.
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function isBridgeMessage({ jsonrpc, method }: z.infer<typeof rawMessageSchema>): boolean {
  const hasJsonRpc = Boolean(jsonrpc);
  return (
    hasJsonRpc ||
    (typeof method === "string" && (method.startsWith("app/") || method.startsWith("host/")))
  );
}

export class HostBrowserActions {
  private consentGranted: boolean;
  private readonly bridge: AppBridge;
  private readonly proxy: HostBrowserProxy;
  private readonly view: HostBrowserView;

  constructor(
    bridge: AppBridge,
    proxy: HostBrowserProxy,
    view: HostBrowserView,
    config: HostConfiguration,
  ) {
    this.bridge = bridge;
    this.proxy = proxy;
    this.view = view;
    this.consentGranted = !config.requireToolConsent;
  }

  listen(): void {
    this.bindRequests();
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.forwardRawMessage(event).catch((error: unknown) => {
        console.error("[host] Raw message forwarding failed:", error);
      });
    });
  }

  private bindRequests(): void {
    this.bridge.oncalltool = async (params) => {
      if (!this.consentGranted) {
        const accepted = window.confirm("Allow this UI to call server tools for this session?");
        if (!accepted) {
          await this.proxy.advisory("/proxy/ui/consent", { approved: false });
          return { isError: true, content: [{ type: "text", text: "Tool call denied by user." }] };
        }
        await this.proxy.post("/proxy/ui/consent", { approved: true });
        this.consentGranted = true;
      }
      const result = await this.proxy.callTool(params);
      await this.proxy.advisory("/proxy/ui/message", {
        type: "intent",
        intent: "call_tool",
        params: { tool: params.name, arguments: params.arguments, isError: result.isError },
      });
      return result;
    };
    this.bridge.setRequestHandler(
      "ui/message",
      { params: McpUiMessageRequestSchema.shape.params, result: McpUiMessageResultSchema },
      (params) => this.proxy.message(params),
    );
    this.bridge.onupdatemodelcontext = (params) => this.proxy.context(params);
    this.bridge.ondownloadfile = (params) => this.proxy.downloadFile(params);
    this.bridge.onrequestdisplaymode = (params) => this.proxy.displayMode(params);
    this.bridge.onopenlink = async (params) => {
      const result = await this.proxy.openLink(params);
      if (result.isError !== true) {
        window.open(params.url, "_blank", "noopener,noreferrer");
        await this.proxy.advisory("/proxy/ui/message", {
          type: "intent",
          intent: "open_link",
          params: { url: params.url },
        });
      }
      return result;
    };
  }

  private async forwardRawMessage(event: MessageEvent<unknown>): Promise<void> {
    if (event.source !== this.view.iframe.contentWindow) {
      return;
    }
    const parsed = rawMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    const { type, payload, ...directFields } = parsed.data;
    if (isBridgeMessage(parsed.data)) {
      return;
    }
    switch (type) {
      case "notify":
      case "prompt":
      case "intent":
      case "message":
        await this.proxy.advisory("/proxy/ui/message", {
          type,
          ...directFields,
          ...payloadFields(payload),
        });
        return;
      default:
        if (type.startsWith("ui-lifecycle-") || type.startsWith("ui-message-")) {
          return;
        }
        const hasPayload = Boolean(payload);
        await this.proxy.advisory("/proxy/ui/message", {
          type: "intent",
          intent: type,
          params: hasPayload ? payload : {},
        });
    }
  }
}
