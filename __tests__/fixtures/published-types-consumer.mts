import adapter, {
  createMcpAdapter,
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  type McpAdapterOptions,
  type McpStatusSnapshot,
} from "pi-mcp-adapter";
import { extractUiPromptText, type McpConfig, type McpToolCallEvent } from "pi-mcp-adapter/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const config: McpConfig = { mcpServers: {} };
const options: McpAdapterOptions = {
  config,
  defaultScriptTimeoutMs: null,
  transformConfig: (resolved, ctx) => {
    const cwd: string = ctx.cwd;
    void cwd;
    return resolved;
  },
  beforeExecute: async (toolCallId, ctx, operation) => {
    const id: string = toolCallId;
    const trusted: boolean | undefined = operation?.annotationsTrusted;
    const cwd: string = ctx.cwd;
    void [id, trusted, cwd];
  },
  onToolCall: async (event: McpToolCallEvent) => {
    const phase: "before" | "after" = event.phase;
    // @ts-expect-error Call phases must remain a typed union.
    const invalidPhase: "pending" = event.phase;
    void [phase, invalidPhase];
  },
};
const extension: (pi: ExtensionAPI) => void = createMcpAdapter(options);
const defaultExtension: typeof extension = adapter;
const channel: "pi-mcp-adapter/status/v1" = MCP_STATUS_EVENT;
const snapshot: McpStatusSnapshot = {
  version: MCP_STATUS_SNAPSHOT_VERSION,
  servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0,
};
const prompt: string | undefined = extractUiPromptText({ prompt: "hello" });

// @ts-expect-error Factory options must retain their declared value types.
createMcpAdapter({ defaultScriptTimeoutMs: "unlimited" });
// @ts-expect-error The returned extension requires the host API.
createMcpAdapter(options)("invalid host");
// @ts-expect-error The default export also requires the host API.
adapter("invalid host");
// @ts-expect-error The /types export must retain function return types.
const invalidPrompt: number = extractUiPromptText({ prompt: "hello" });
void [extension, defaultExtension, channel, snapshot, prompt, invalidPrompt];
