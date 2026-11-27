import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsentManager } from "./consent-manager.ts";
import type { McpLifecycleManager } from "./lifecycle.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { AuthStorageOptions } from "./mcp-auth.ts";
import type { McpConfigValidationError } from "./config-types.ts";
import type {
  ToolMetadata,
  PromptMetadata,
  SkillMetadata,
  McpConfig,
  McpAdapterOptions,
  UiModelContextUpdate,
  McpResourceTemplate,
  UiSessionMessages,
  UiStreamSummary,
} from "./types.ts";
import type { UiResourceHandler } from "./ui-resource-handler.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import type { McpStatusEventBus } from "./mcp-status-events.ts";

export interface CompletedUiSession {
  serverName: string;
  toolName: string;
  completedAt: Date;
  reason: string;
  messages: UiSessionMessages;
  stream?: UiStreamSummary;
}

export interface PendingUiModelContext {
  serverName: string;
  toolName: string;
  context: UiModelContextUpdate;
}

export type SendMessageFn = (
  message: {
    customType: string;
    content: Array<{ type: "text"; text: string }>;
    display?: string;
    details?: unknown;
  },
  options?: { triggerTurn?: boolean },
) => void;

export type McpInitializationOptions = McpAdapterOptions & {
  oauthRuntime?: McpOAuthRuntime;
  statusEvents?: McpExtensionState["statusEvents"];
  resolvedConfig?: McpConfig;
};

export interface McpExtensionState {
  owner: McpRuntimeOwner;
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;
  /** Native resource counts, separate from callable tools. */
  resourceCounts: Map<string, number>;
  /** Discovered or cached MCP resource URI templates per server. */
  resourceTemplates: Map<string, McpResourceTemplate[]>;
  promptMetadata: Map<string, PromptMetadata[]>;
  /** Servers whose prompt inventory came from successful live discovery. */
  promptMetadataLive: Set<string>;
  /** Verified MCP skills indexed by server name. */
  skillMetadata?: Map<string, SkillMetadata[]>;
  /** Materialized private skill directory paths indexed by server name. */
  skillPaths?: Map<string, string[]>;
  /** Adapter-managed directory identifier for materialized skills in this runtime. */
  skillsRuntimeId?: string;
  /** Whether the active working directory was trusted when state was created/reconciled. */
  projectTrusted?: boolean;
  /** Explicit config path and working directory used for skill origin/trust checks. */
  configPath?: string | undefined;
  cwd?: string | undefined;
  includeNativePi?: boolean;
  serverInstructions: Map<string, string>;
  config: McpConfig;
  configErrors?: McpConfigValidationError[] | undefined;
  recentStderr?: Map<string, string> | undefined;
  programmaticConfig?: boolean;
  outputDirectory?: string;
  onToolCall?: McpAdapterOptions["onToolCall"];
  oauthRuntime: McpOAuthRuntime;
  authStorageOptions: AuthStorageOptions;
  metadataCacheEnabled: boolean;
  failureTracker: Map<string, number>;
  failureMessages: Map<string, string>;
  /** Session-only approvals keyed by server and original tool name. */
  /** Approvals last for this adapter state, including until a working-directory rebuild. */
  approvedToolCalls: Map<string, true>;
  uiResourceHandler: UiResourceHandler;
  consentManager: ConsentManager;
  /**
   * Current HTTP UI session. Replacement closes the previous handle; completion
   * clears only its own handle. Runtime cleanup closes whichever handle remains.
   */
  uiServer: UiServerHandle | null;
  /** Latest unconsumed model context retained when a UI session closes before the next user turn. */
  pendingUiModelContext?: PendingUiModelContext | undefined;
  completedUiSessions: CompletedUiSession[];
  activeScripts: number;
  openBrowser: (url: string) => Promise<void>;
  /** Adapter hosts may supply the UI without Pi's terminal theme. */
  ui?: Omit<ExtensionContext["ui"], "theme"> & {
    theme?: ExtensionContext["ui"]["theme"] | undefined;
  };
  sendMessage?: SendMessageFn;
  onToolMetadataUpdated?: (serverName: string, reason: string) => void | Promise<void>;
  statusEvents?: McpStatusEventBus;
}
