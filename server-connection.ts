import type { Client } from "@modelcontextprotocol/client";
import type {
  CachedPriorDiscovery,
  McpTool,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  SkillMetadata,
  Transport,
} from "./types.ts";
import type { VerifiedSkillBundle } from "./mcp-skills.ts";

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  /** Refreshed resources held until resourceTemplates refresh completes atomically. */
  pendingResources?: McpResource[] | undefined;
  resourceTemplates?: McpResourceTemplate[];
  /** True after resources/list_changed until resourceTemplates are refreshed. */
  resourceTemplatesStale?: boolean;
  /** Monotonic generation bumped on each resources/list_changed to guard overlapping template refreshes. */
  resourceTemplatesGeneration?: number;
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  /** True when skills discovery or verification failed transiently. */
  skillDiscoveryFailed?: boolean;
  /** Verified MCP skill metadata discovered from SEP-2640 skills extension. */
  skills?: SkillMetadata[];
  /** Verified in-memory skill file bundles ready for adapter-managed materialization. */
  verifiedSkillBundles?: readonly VerifiedSkillBundle[];
  instructions?: string;
  /** Cached SDK 2.4.0 protocol-era verdict for HTTP StreamableHTTP reconnects. */
  priorDiscovery?: CachedPriorDiscovery;
  lastUsedAt: number;
  status: "connected" | "closed" | "needs-auth";
  /** Whether this connection was constructed with the native OAuth provider. */
  oauthProvider?: boolean;
  /** Recent sanitized stderr tail captured for live stdio connections. */
  getStderrTail?: () => string;
}

export type UiStreamListener = (
  serverName: string,
  notification: ServerStreamResultPatchNotification["params"],
) => void;
export type MetadataListChangedListener = (serverName: string, reason: string) => void;
export type ServerClosedListener = (serverName?: string) => void;
