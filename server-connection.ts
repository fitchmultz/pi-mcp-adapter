import type { Client } from "@modelcontextprotocol/client";
import type {
  McpTool,
  McpResource,
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
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  instructions?: string;
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
  /** Whether this connection was constructed with the native OAuth provider. */
  oauthProvider?: boolean;
}

export type UiStreamListener = (
  serverName: string,
  notification: ServerStreamResultPatchNotification["params"],
) => void;
export type MetadataListChangedListener = (serverName: string, reason: string) => void;
