import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig } from "./types.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { parseDirectToolSelectors } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { executeCall } from "./proxy-modes.ts";
import { isServerDisabled } from "./types.ts";

export function directToolSelection(config: McpConfig, serverName: string, envOverride?: string[]): true | string[] | false {
  if (envOverride) {
    const selection = parseDirectToolSelectors(envOverride);
    if (selection.servers.has(serverName)) return true;
    return selection.tools.has(serverName) ? [...selection.tools.get(serverName)!] : false;
  }
  return config.mcpServers[serverName]?.directTools ?? config.settings?.directTools ?? false;
}

export function buildProxyDescription(config: McpConfig): string {
  const servers = Object.entries(config.mcpServers).filter(([, definition]) => !isServerDisabled(definition)).map(([name]) => name).sort();
  return [
    "MCP gateway. Use mcp_search to discover and load typed tools; mcp_script for multi-call composition. Native Pi tools are called directly.",
    `Configured servers: ${servers.join(", ") || "none"}. Catalog discovery is lazy.`,
    "Actions: status; list/search/describe; call (tool,args,server?); connect (server); instructions (server); resources (server); read-resource (server,uri); read-result (ref,path?,fields?,offset?,limit?); auth-start/auth-complete (server,args?); ui-messages.",
    "Use call when a discovered direct tool is unavailable in this host. read-result reads a retained response without repeating the remote operation.",
  ].join("\n");
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
): DirectToolExecute {
  return async function execute(toolCallId, params, signal, _onUpdate, ctx) {
    throwIfAborted(signal);
    let state = getState();
    const initPromise = getInitPromise();

    if (!state && initPromise) {
      try {
        state = await abortable(initPromise, signal);
      } catch (error) {
        throwIfAborted(signal);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    const result = await executeCall(
      state, spec.originalName, params, spec.serverName, undefined, signal, undefined, { toolCallId },
      beforeExecute ? (callSignal, operation) => beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation) : undefined,
      { exactOriginalName: true, ...(spec.resourceUri ? { resourceUri: spec.resourceUri } : {}) },
    );
    const { mode: _mode, ...details } = result.details;
    return { ...result, details };
  };
}
