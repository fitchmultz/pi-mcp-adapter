import type { CallToolResult } from "@modelcontextprotocol/client";

import type { UiHostContext, UiSessionMessages, UiStreamSummary } from "./types.ts";

export interface UiServerHandle {
  url: string;
  port: number;
  sessionToken: string;
  serverName: string;
  toolName: string;
  viewer?: "browser" | "glimpse" | "suppressed";
  windowOpen?: boolean;
  close: (reason?: string) => void;
  sendToolInput: (args: Record<string, unknown>) => void;
  sendToolResult: (result: CallToolResult) => void;
  sendResultPatch: (result: CallToolResult) => void;
  sendToolCancelled: (reason: string) => void;
  sendHostContext: (context: UiHostContext) => void;
  /** Get accumulated messages from this session */
  getSessionMessages: () => UiSessionMessages;
  getStreamSummary: () => UiStreamSummary | undefined;
}
