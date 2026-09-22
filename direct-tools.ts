import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, ToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { isServerCacheValid, parseDirectToolSelectors, reconstructToolMetadata } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { executeCall } from "./proxy-modes.ts";
import { isServerDisabled } from "./types.ts";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;
const advisedDirectToolSets = new Set<string>();

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    for (const { name: prefixedName, ...tool } of reconstructToolMetadata(serverName, serverCache, prefix, definition)) {
      if (tool.resourceUri !== undefined) continue;
      if (toolFilter !== true && !toolFilter.includes(tool.originalName)) continue;
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({ ...tool, serverName, prefixedName });
    }
  }

  const advisoryKey = specs.map(spec => spec.prefixedName).sort().join("\0");
  if (specs.length >= DIRECT_TOOLS_ADVISORY_THRESHOLD && !advisedDirectToolSets.has(advisoryKey)) {
    advisedDirectToolSets.add(advisoryKey);
    console.warn(`MCP: ${specs.length} direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered.`);
  }

  return specs;
}

export function buildProxyDescription(config: McpConfig): string {
  let desc = `MCP gateway — server status, tool search/describe, auth, and single MCP tool calls. When one request needs several MCP calls with logic between them, use mcp_script. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  // Catalog counts and instruction previews change on connect and break prompt caching.
  // Keep this directory config-only; discovery and instructions belong in tool results.
  const enabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([serverName]) => serverName)
    .sort();
  if (enabledServers.length > 0) {
    desc += `\nConfigured servers (call mcp({}) for live status): ${enabledServers.join(", ")}\n`;
  }

  const disabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => isServerDisabled(definition))
    .map(([serverName]) => serverName);
  if (disabledServers.length > 0) {
    desc += `\nDisabled servers (enable with /mcp enable <server> and /reload): ${disabledServers.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name", limit: 12 })    → Browse a server's tools (use offset for more)\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ instructions: "name" })         → Show full server usage instructions\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: { key: "value" } })         → Call a tool (object args; JSON string also accepted)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `  mcp({ action: "auth-start", server: "name" })      → Start manual OAuth and get a browser URL\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > instructions > search > server (list) > nothing (status)`;

  return desc;
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
