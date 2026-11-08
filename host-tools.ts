import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { McpAdapterHost, HostToolExecute } from "./host-contract.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig } from "./types.ts";
import {
  buildProxyDescription,
  directToolSelection,
  getMissingConfiguredDirectToolServers,
} from "./direct-tools.ts";
import {
  isServerCacheValid,
  reconstructToolMetadata,
  type MetadataCache,
} from "./metadata-cache.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { renderMcpToolResult, renderMcpProxyToolCall } from "./tool-result-renderer.ts";
import { gatewayParameters, prepareGatewayArguments } from "./gateway-arguments.ts";
import { executeGateway } from "./host-gateway.ts";

export class McpHostTools {
  private readonly pi: ExtensionAPI;
  private readonly host: McpAdapterHost;
  private readonly options: McpAdapterOptions;
  private readonly envRaw = process.env.MCP_DIRECT_TOOLS;
  private readonly envDirectToolOverride = this.envRaw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  private readonly withdrawals = new Map<string, () => void>();
  private readonly hidden = new Set<string>();
  private proxyToolDescription: string | null = null;

  constructor(pi: ExtensionAPI, host: McpAdapterHost, options: McpAdapterOptions) {
    this.pi = pi;
    this.host = host;
    this.options = options;
  }

  private registerHostTool<TParams extends TSchema, TDetails>(
    definition: ToolDefinition<TParams, TDetails>,
  ): void {
    const wrapped: ToolDefinition<TParams, TDetails> = {
      ...definition,
      async execute(...args) {
        const result = await definition.execute(...args);
        return { ...result, ...toolErrorOverride(result.details) };
      },
    };
    this.withdrawals.set(definition.name, () =>
      this.pi.registerTool({ ...wrapped, exposure: "hidden" }),
    );
    this.hidden.delete(definition.name);
    this.pi.registerTool(wrapped);
  }

  /** Pi cannot unregister a tool; a withdrawn gateway is re-registered hidden until needed again. */
  private hideHostTool(name: string): void {
    const withdraw = this.withdrawals.get(name);
    if (!withdraw || this.hidden.has(name)) {
      return;
    }
    this.hidden.add(name);
    withdraw();
  }

  private registered(name: string): boolean {
    return this.withdrawals.has(name) && !this.hidden.has(name);
  }

  private registerProxyTool(description: string): void {
    const beforeExecute = this.options.beforeExecute;
    const { pi, host, options } = this;
    const execute: HostToolExecute<Record<string, unknown>> =
      // oxlint-disable-next-line eslint/max-params -- QX-025: preserve Pi's native five-position execute callback.
      async function executeMcpGateway(toolCallId, rawParams, signal, _onUpdate, ctx) {
        return executeGateway(pi, host, options, [toolCallId, rawParams, signal, _onUpdate, ctx]);
      };
    this.registerHostTool({
      ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
      name: "mcp",
      label: "MCP",
      description,
      promptSnippet:
        "MCP server operations, resources, saved result readback, and fallback tool calls",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Unsafe<Record<string, unknown>>(gatewayParameters),
      prepareArguments: prepareGatewayArguments,
      renderResult: renderMcpToolResult,
      execute,
    });
    this.proxyToolDescription = description;
  }

  syncGateways(
    config: McpConfig,
    cache: MetadataCache | null,
    directSpecs: DirectToolSpec[],
  ): void {
    const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
      config,
      cache,
      this.envRaw === "__none__" ? undefined : this.envDirectToolOverride,
    );
    const hasPinnedResources = this.hasPinnedResources(config, cache);
    const shouldRegisterProxyTool = gatewayRequired(config, {
      hasPinnedResources,
      directCount: directSpecs.length,
      missingCount: missingConfiguredDirectToolServers.length,
    });

    if (shouldRegisterProxyTool) {
      const description = buildProxyDescription(config);
      if (!this.registered("mcp") || this.proxyToolDescription !== description) {
        this.registerProxyTool(description);
      }
    } else {
      this.hideHostTool("mcp");
    }
  }
  private hasPinnedResources(config: McpConfig, cache: MetadataCache | null): boolean {
    return (
      this.envRaw !== "__none__" &&
      Object.entries(config.mcpServers).some(([server, definition]) => {
        if (definition.disabled === true) {
          return false;
        }
        const selection = directToolSelection(config, server, this.envDirectToolOverride);
        if (selection === false) {
          return false;
        }
        const metadata = this.resourceMetadata(config, cache, server);
        return metadata.some(
          (tool) =>
            tool.resourceUri !== undefined &&
            tool.resourceUri.length > 0 &&
            (selection === true || selection.includes(tool.originalName)),
        );
      })
    );
  }
  private resourceMetadata(config: McpConfig, cache: MetadataCache | null, server: string) {
    const definition = config.mcpServers[server];
    if (!definition) {
      return [];
    }
    const entry = cache?.servers[server];
    return (
      this.host.state?.toolMetadata.get(server) ??
      (entry && isServerCacheValid(entry, definition)
        ? reconstructToolMetadata(
            server,
            entry,
            config.settings?.toolPrefix ?? "server",
            definition,
          )
        : [])
    );
  }
}

function gatewayRequired(
  config: McpConfig,
  {
    hasPinnedResources,
    directCount,
    missingCount,
  }: { hasPinnedResources: boolean; directCount: number; missingCount: number },
): boolean {
  return (
    config.settings?.disableProxyTool !== true ||
    hasPinnedResources ||
    directCount === 0 ||
    missingCount > 0
  );
}
