// types.ts - Core type definitions
import type {
  Transport as McpTransport,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
} from "@modelcontextprotocol/client";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { McpConfig, ServerEntry } from "./config-types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UiStreamMode } from "./ui-stream-types.ts";
import type { UiToolVisibility } from "./ui-tool-visibility.ts";

export type Transport = McpTransport;

/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export const MCP_STATUS_EVENT = "fitch-mcp-adapter/status/v1";

export const MCP_STATUS_SNAPSHOT_VERSION = 1;

export type McpServerRuntimeStatus =
  | "connected"
  | "cached"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

export interface McpServerStatusSnapshot {
  readonly name: string;
  readonly status: McpServerRuntimeStatus;
  readonly toolCount: number;
  /** False means the server has not been discovered, rather than an empty inventory. */
  readonly catalogKnown?: boolean;
  readonly resourceCount?: number;
  readonly failedAgoSeconds?: number;
  readonly disabled: boolean;
}

export interface McpStatusSnapshot {
  readonly version: typeof MCP_STATUS_SNAPSHOT_VERSION;
  readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
  readonly totalTools: number;
  readonly totalResources: number;
  readonly connectedCount: number;
  readonly disabledCount: number;
}

type SdkTool = ListToolsResult["tools"][number];
type SdkResource = ListResourcesResult["resources"][number];
type SdkPrompt = ListPromptsResult["prompts"][number];
type SdkPromptArgument = NonNullable<SdkPrompt["arguments"]>[number];

// Legacy cache records may omit inputSchema; otherwise retain the native descriptor.
export interface McpTool extends Omit<SdkTool, "inputSchema"> {
  inputSchema?: SdkTool["inputSchema"];
}

export type McpResource = SdkResource;

export interface McpPromptArgument {
  name: SdkPromptArgument["name"];
  description?: SdkPromptArgument["description"];
  required?: SdkPromptArgument["required"];
}

export interface McpPrompt {
  name: SdkPrompt["name"];
  title?: SdkPrompt["title"];
  description?: SdkPrompt["description"];
  arguments?: SdkPrompt["arguments"];
  _meta?: SdkPrompt["_meta"];
}

export * from "./ui-message-types.ts";

// Content types from MCP
export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

export type * from "./config-types.ts";
export {
  isNonInteractiveOAuth,
  validateServerProtocolConfig,
  isServerDisabled,
} from "./config-protocol.ts";

export interface McpToolCallIdentity {
  /** Native Pi call ID; correlation only, never a provider idempotency key. */
  toolCallId?: string;
}

export type McpToolCallEvent = McpToolCallIdentity & {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  annotations?: McpTool["annotations"];
  resourceUri?: string;
  signal: AbortSignal;
} & (
    | { phase: "before" }
    | { phase: "after"; result: unknown }
    | { phase: "after"; error: unknown }
  );

/** Resolved operation facts before the service deadline; no connection/configuration objects. */
export type McpOperationContext = Omit<
  Extract<McpToolCallEvent, { phase: "before" }>,
  "phase" | "signal"
> & {
  /** The configured server opted into trusting annotations via retryOnTransportFailure. */
  annotationsTrusted: boolean;
};

export interface McpAdapterOptions {
  /** Awaited before the service deadline for each resolved call; operation is absent for other proxy modes. Honor ctx.signal. Selects native sequential sibling scheduling. */
  beforeExecute?: (
    toolCallId: string,
    ctx: ExtensionContext,
    operation?: McpOperationContext,
  ) => Promise<void>;
  config?: McpConfig;
  configPath?: string;
  /** Synchronously transform a clone of the resolved config once per session_start, before registration/initialization.
   * The result is cloned for session ownership. Ambient config/trust and panels remain enabled unless config is supplied. */
  transformConfig?: (config: McpConfig, ctx: ExtensionContext) => McpConfig;
  /**
   * Host-owned parent for saved results and UI history. Defaults to the system
   * temp directory. Returned paths outlive adapter sessions; the host owns
   * retention and deletion once readers no longer need them. Use a persistent
   * directory when references must survive the OS's temporary-file cleanup.
   */
  outputDirectory?: string;
  /** Awaited before dispatch and after its raw outcome. */
  onToolCall?: (event: McpToolCallEvent) => Promise<void>;
}

// Alias for clarity
export type ServerDefinition = ServerEntry;

export interface ToolMetadata extends Omit<McpTool, "name" | "description"> {
  name: string; // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string; // Original MCP tool name (e.g., "list_sims")
  description: string;
  resourceUri?: string; // Legacy resource alias; new calls address server + URI.
  resourceDescriptor?: McpResource;
  uiResourceUri?: string; // For app-enabled tools: the UI resource URI
  uiVisibility?: UiToolVisibility[];
  uiStreamMode?: UiStreamMode;
}

export interface PromptMetadata {
  serverName: string;
  originalName: string;
  commandName: string;
  title?: string;
  description: string;
  arguments: McpPromptArgument[];
}

export interface DirectToolSpec extends Omit<ToolMetadata, "name"> {
  serverName: string;
  prefixedName: string;
}

export interface ServerProvenance {
  path: string;
  kind: "user" | "project" | "import";
  importKind?: string;
}

export interface McpAuthResult {
  ok: boolean;
  message?: string;
}

export interface CachedTool extends McpTool {
  // Version-1 caches stored flattened UI fields instead of the raw _meta.
  uiResourceUri?: string;
  uiVisibility?: UiToolVisibility[];
  uiStreamMode?: UiStreamMode;
}

export type CachedResource = McpResource;

export interface CachedPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  prompts?: CachedPrompt[];
  instructions?: string;
  cachedAt: number;
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

/** What the `/mcp` panel reports; the panel adds its local reconnect as "connecting". */
export type McpPanelConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "disabled";

export interface McpPanelCallbacks {
  reconnect: (serverName: string, afterAuth?: boolean) => Promise<boolean>;
  canAuthenticate: (serverName: string) => boolean;
  authenticate: (serverName: string) => Promise<McpAuthResult>;
  getConnectionStatus: (serverName: string) => McpPanelConnectionStatus;
  getFailureMessage?: (serverName: string) => string | null;
  refreshCacheAfterReconnect: (serverName: string) => ServerCacheEntry | null;
}

export interface McpPanelResult {
  changes: Map<string, true | string[] | false>;
  cancelled: boolean;
}

export * from "./tool-names.ts";
