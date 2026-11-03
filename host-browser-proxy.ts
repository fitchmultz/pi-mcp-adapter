import { z } from "zod";
import { CallToolResultSchema, EmptyResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult, EmptyResult } from "@modelcontextprotocol/client";
import {
  McpUiMessageResultSchema,
  McpUiOpenLinkResultSchema,
  McpUiDownloadFileResultSchema,
  McpUiRequestDisplayModeResultSchema,
  type McpUiMessageResult,
  type McpUiOpenLinkResult,
  type McpUiDownloadFileResult,
  type McpUiRequestDisplayModeResult,
} from "@modelcontextprotocol/ext-apps";

const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.unknown().optional(),
});

function isCallToolResult(value: unknown): value is CallToolResult {
  return CallToolResultSchema.safeParse(value).success;
}
function isEmptyResult(value: unknown): value is EmptyResult {
  return EmptyResultSchema.safeParse(value).success;
}
function isMessageResult(value: unknown): value is McpUiMessageResult {
  return McpUiMessageResultSchema.safeParse(value).success;
}
function isOpenLinkResult(value: unknown): value is McpUiOpenLinkResult {
  return McpUiOpenLinkResultSchema.safeParse(value).success;
}
function isDownloadFileResult(value: unknown): value is McpUiDownloadFileResult {
  return McpUiDownloadFileResultSchema.safeParse(value).success;
}
function isDisplayModeResult(value: unknown): value is McpUiRequestDisplayModeResult {
  return McpUiRequestDisplayModeResultSchema.safeParse(value).success;
}

export class HostBrowserProxy {
  private readonly sessionToken: string;

  constructor(sessionToken: string) {
    this.sessionToken = sessionToken;
  }

  async post(endpoint: string, params: unknown): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.sessionToken, params }),
    });
    const value: unknown = await response
      .json()
      .catch(() => ({ ok: false, error: "Invalid JSON response" }));
    const body = envelopeSchema.parse(value);
    if (!response.ok || !body.ok) {
      throw new Error(
        body.error !== undefined && body.error.length > 0 ? body.error : `HTTP ${response.status}`,
      );
    }
    return body.result ?? {};
  }

  async advisory(endpoint: string, params: unknown): Promise<void> {
    try {
      await this.post(endpoint, params);
    } catch {
      // Advisory notifications must not replace a completed native operation.
    }
  }

  async callTool(params: unknown): Promise<CallToolResult> {
    const result = await this.post("/proxy/tools/call", params);
    if (!isCallToolResult(result)) {
      throw new Error("Invalid tools/call result");
    }
    return result;
  }

  async message(params: unknown): Promise<McpUiMessageResult> {
    const result = await this.post("/proxy/ui/message", params);
    if (!isMessageResult(result)) {
      throw new Error("Invalid UI message result");
    }
    return result;
  }

  async context(params: unknown): Promise<EmptyResult> {
    const result = await this.post("/proxy/ui/context", params);
    if (!isEmptyResult(result)) {
      throw new Error("Invalid model context result");
    }
    return result;
  }

  async openLink(params: unknown): Promise<McpUiOpenLinkResult> {
    const result = await this.post("/proxy/ui/open-link", params);
    if (!isOpenLinkResult(result)) {
      throw new Error("Invalid open link result");
    }
    return result;
  }

  async downloadFile(params: unknown): Promise<McpUiDownloadFileResult> {
    const result = await this.post("/proxy/ui/download-file", params);
    if (!isDownloadFileResult(result)) {
      throw new Error("Invalid download file result");
    }
    return result;
  }

  async displayMode(params: unknown): Promise<McpUiRequestDisplayModeResult> {
    const result = await this.post("/proxy/ui/request-display-mode", params);
    if (!isDisplayModeResult(result)) {
      throw new Error("Invalid display mode result");
    }
    return result;
  }
}
