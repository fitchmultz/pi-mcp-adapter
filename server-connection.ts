import type { Client } from "@modelcontextprotocol/client";
import type {
  McpTool,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  resourceTemplates?: McpResourceTemplate[];
  /** True after resources/list_changed until resourceTemplates are refreshed. */
  resourceTemplatesStale?: boolean;
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  instructions?: string;
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
