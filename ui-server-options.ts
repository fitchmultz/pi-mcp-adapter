import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ConsentManager } from "./consent-manager.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { McpExtensionState } from "./state.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import type {
  McpConfig,
  UiHostContext,
  UiMessageParams,
  UiModelContextParams,
  UiResourceContent,
} from "./types.ts";

export interface UiServerOptions {
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  manager: McpServerManager;
  /**
   * Live extension config, used to re-read the server definition when
   * recovering a terminated Streamable HTTP session (see
   * session-recovery.ts). Optional so existing embedders/tests that don't
   * need session recovery aren't forced to supply it; without it, proxied
   * tool calls run without recovery (unchanged pre-existing behavior).
   */
  config?: McpConfig;
  /** Live state enables TUI approval prompts for iframe-originated tool calls. */
  state?: McpExtensionState;
  onNeedsAuth?: SessionRecoveryDeps["onNeedsAuth"];
  consentManager: ConsentManager;
  hostContext?: UiHostContext;
  initialResultPromise?: Promise<CallToolResult>;
  sessionToken?: string;
  port?: number;
  onMessage?: (params: UiMessageParams) => Promise<void> | void;
  onContextUpdate?: (params: UiModelContextParams) => Promise<void> | void;
  onComplete?: (reason: string) => void;
}
