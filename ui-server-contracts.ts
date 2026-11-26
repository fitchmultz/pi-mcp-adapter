import type { CallToolResult } from "@modelcontextprotocol/client";

import type {
  UiHostContext,
  UiModelContextUpdate,
  UiSessionMessages,
  UiStreamSummary,
} from "./types.ts";

export interface UiServerHandle {
  url: string;
  port: number;
  sessionToken: string;
  serverName: string;
  toolName: string;
  viewer?: "browser" | "glimpse";
  close: (reason?: string) => void;
  sendToolInput: (args: Record<string, unknown>) => void;
  sendToolResult: (result: CallToolResult) => void;
  sendResultPatch: (result: CallToolResult) => void;
  sendToolCancelled: (reason: string) => void;
  sendHostContext: (context: UiHostContext) => void;
  /** Get accumulated messages from this session */
  getSessionMessages: () => UiSessionMessages;
  /** Consume the latest pending context for the next user or app chat request. */
  takeModelContext: () => UiModelContextUpdate | undefined;
  /** Latest error reported by the browser host page for this session, if any. */
  getHostError?: () => string | undefined;
  getStreamSummary: () => UiStreamSummary | undefined;
}
