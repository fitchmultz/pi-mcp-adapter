import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUnsafe } from "typebox";
import type { McpExtensionState } from "./state.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { parseDirectToolSelectors } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import {
  type DirectToolSpec,
  type McpAdapterOptions,
  type McpConfig,
  isServerDisabled,
} from "./types.ts";
import { nativeMcpResult } from "./tool-registrar.ts";

export function directToolSelection(
  config: McpConfig,
  serverName: string,
  envOverride?: string[],
): true | string[] | false {
  if (envOverride) {
    const selection = parseDirectToolSelectors(envOverride);
    if (selection.servers.has(serverName)) {
      return true;
    }
    const tools = selection.tools.get(serverName);
    return tools ? [...tools] : false;
  }
  return config.mcpServers[serverName]?.directTools ?? config.settings?.directTools ?? false;
}

export function buildProxyDescription(config: McpConfig): string {
  const servers = Object.entries(config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([name]) => name)
    .sort();
  return [
    'MCP gateway. Use mcp_search to discover typed tools; enable mcp_script with mcp_search({ enable: ["script"] }) for multi-call composition. Native Pi tools are called directly.',
    `Configured servers: ${servers.length > 0 ? servers.join(", ") : "none"}. Catalog discovery is lazy.`,
    "Actions: status; list/search/describe; call (tool,args,server?); connect (server); instructions (server); resources (server); read-resource (server,uri); read-result (ref,path?,fields?,offset?,limit?); auth-start/auth-complete (server,args?); ui-messages.",
    "Use call when a discovered direct tool is unavailable in this host. read-result reads a retained response without repeating the remote operation.",
  ].join("\n");
}

type DirectToolExecute = ToolDefinition<
  TUnsafe<Record<string, unknown>>,
  Record<string, unknown>
>["execute"];

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec,
  beforeExecute?: McpAdapterOptions["beforeExecute"],
): DirectToolExecute {
  return (
    // oxlint-disable-next-line eslint/max-params -- QX-025: Pi supplies context in the fifth callback position.
    async function execute(toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      let state = getState();
      const initPromise = getInitPromise();

      if (!state && initPromise) {
        try {
          state = await abortable(initPromise, signal);
        } catch (error) {
          throwIfAborted(signal);
          const message = error instanceof Error ? error.message : String(error);
          return nativeMcpResult(
            {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            },
            Boolean(spec.outputSchema),
          );
        }
      }
      if (!state) {
        return nativeMcpResult(
          {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          },
          Boolean(spec.outputSchema),
        );
      }

      const { executeCall } = await import("./proxy-modes.ts");
      const result = await executeCall(state, {
        toolName: spec.originalName,
        args: params,
        serverOverride: spec.serverName,
        signal,
        identity: { toolCallId },
        beforeDispatch: beforeExecute
          ? (callSignal, operation) =>
              beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation)
          : undefined,
        options: {
          exactOriginalName: true,
          ...((spec.resourceUri ?? "").length > 0 ? { resourceUri: spec.resourceUri } : {}),
        },
      });
      const { mode: _mode, ...details } = result.details;
      return nativeMcpResult({ ...result, details }, Boolean(spec.outputSchema));
    }
  );
}
