import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpAdapterHost, HostToolArguments } from "./host-contract.ts";
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
import type { createToolLoader, Feature, FeaturePolicy } from "./tool-loader.ts";
import { renderMcpToolResult, renderMcpProxyToolCall } from "./tool-result-renderer.ts";
import { MAX_PAGE_SIZE, paginate, rankToolMatches } from "./search-ranking.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  resolveMcpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import type * as importProxy from "./proxy-modes.ts";
import type { McpExtensionState } from "./state.ts";
import { throwIfAborted } from "./abort.ts";
import { DEFAULT_MCP_SCRIPT_TIMEOUT_MS } from "./utils.ts";
import {
  gatewayParameters,
  prepareGatewayArguments,
  type GatewayArguments,
} from "./gateway-arguments.ts";
import { executeGateway } from "./host-gateway.ts";

type SearchParams = {
  query?: string;
  enable?: Feature[];
  server?: string;
  limit?: number;
  offset?: number;
};
const unavailableFeatures = (enable: Feature[] = [], tools: Array<{ name: string }>) =>
  enable.filter(
    (feature) =>
      !tools.some((tool) => tool.name === (feature === "gateway" ? "mcp" : "mcp_script")),
  );

export class McpHostTools {
  private readonly pi: ExtensionAPI;
  private readonly host: McpAdapterHost;
  private readonly loader: ReturnType<typeof createToolLoader>;
  private readonly options: McpAdapterOptions;
  private readonly envRaw = process.env.MCP_DIRECT_TOOLS;
  private readonly envDirectToolOverride = this.envRaw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  private scriptToolRegistered = false;
  private proxyToolRegistered = false;
  private proxyToolDescription: string | null = null;

  constructor(
    pi: ExtensionAPI,
    host: McpAdapterHost,
    loader: ReturnType<typeof createToolLoader>,
    options: McpAdapterOptions,
  ) {
    this.pi = pi;
    this.host = host;
    this.loader = loader;
    this.options = options;
  }

  private async searchAndLoad(params: SearchParams, signal: AbortSignal | undefined) {
    throwIfAborted(signal);
    if (params.query === undefined && (params.enable?.length ?? 0) === 0) {
      throw new Error("Provide query or enable.");
    }
    // Loading front doors does not require initialization or connect to a server.
    if (params.query === undefined) {
      return this.loadFeatures(params.enable);
    }
    const ready = await this.host.getToolState(signal);
    if ("content" in ready) {
      return { ...ready, tools: [] };
    }
    const proxy = await import("./proxy-modes.ts");
    if (params.server !== undefined && needsDiscovery(ready, params.server)) {
      const discovery = await proxy.executeConnect(ready, params.server, signal);
      const failed = Boolean(discovery.details.error);
      if (failed) {
        return { ...discovery, tools: [] };
      }
    }
    this.host.syncToolSurface();
    return this.searchLoaded(ready, { ...params, query: params.query }, proxy);
  }

  private async searchLoaded(
    ready: McpExtensionState,
    params: SearchParams & { query: string },
    proxy: typeof importProxy,
  ) {
    const matches = findMatches(ready, params);
    const page = paginate(matches, params.offset ?? 0, params.limit ?? 5);
    const tools = this.loader.activate(page.items, params.enable);
    const unavailable = unavailableFeatures(params.enable, tools);
    const typedCount = tools.filter(
      (tool) => tool.name !== "mcp" && tool.name !== "mcp_script",
    ).length;
    const result = proxy.executeSearch(
      ready,
      params.query,
      params.server,
      typedCount < page.items.length,
      params.limit ?? 5,
      params.offset,
      "mcp_search",
    );
    const guarded = await guardMcpOutput(
      [
        ...result.content,
        {
          type: "text",
          text:
            tools.length > 0
              ? `Loaded for the next request: ${JSON.stringify(tools)}`
              : 'No direct tools loaded. Enable gateway or script with mcp_search({ enable: ["gateway"] }) or mcp_search({ enable: ["script"] }), then use mcp action call or tools.call with the returned exact names.',
        },
        ...(unavailable.length > 0
          ? [
              {
                type: "text" as const,
                text: `Unavailable under configuration or host policy: ${unavailable.join(", ")}`,
              },
            ]
          : []),
      ],
      resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory),
    );
    return {
      content: guarded.content,
      details: {
        ...result.details,
        ...guardedMcpDetails(guarded),
        loaded: tools,
        ...(unavailable.length > 0 ? { unavailable } : {}),
      },
      tools,
    };
  }

  private loadFeatures(enable: Feature[] | undefined) {
    const tools = this.loader.activate([], enable);
    const unavailable = unavailableFeatures(enable, tools);
    return {
      content: [
        {
          type: "text" as const,
          text: `Loaded for the next request: ${JSON.stringify(tools)}${unavailable.length > 0 ? `. Unavailable under configuration or host policy: ${unavailable.join(", ")}` : ""}`,
        },
      ],
      details: { loaded: tools, unavailable },
      tools,
    };
  }

  registerSearch(): void {
    const beforeExecute = this.options.beforeExecute;
    const host = this.host;
    const searchAndLoad = (params: SearchParams, signal?: AbortSignal) =>
      this.searchAndLoad(params, signal);
    const searchDefinition = {
      name: "mcp_search",
      label: "MCP Search",
      description:
        "Discover and load typed MCP tools for the next request. Use query; server discovers an uncached server (empty query browses it). Results report incomplete coverage. Or enable gateway for mcp status/list/search/describe/call/connect/instructions, resources/read-resource, read-result, auth-start/auth-complete and ui-messages; enable script for JavaScript composition, resources and saved-result readback. Enable alone performs no integration action. Loaded schemas stay available in this session/branch.",
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String()),
          enable: Type.Optional(
            Type.Array(Type.Union([Type.Literal("gateway"), Type.Literal("script")]), {
              minItems: 1,
              uniqueItems: true,
            }),
          ),
          server: Type.Optional(Type.String()),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_PAGE_SIZE,
              description: "Tools to load (default 5).",
            }),
          ),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        {
          anyOf: [
            { type: "object", required: ["query"] },
            { type: "object", required: ["enable"] },
          ],
        },
      ),
      renderResult: renderMcpToolResult,
      async execute(...[toolCallId, params, signal, , ctx]: HostToolArguments<SearchParams>) {
        if (beforeExecute) {
          if (host.owner) {
            await host.owner.runCallback("beforeExecute", () => beforeExecute(toolCallId, ctx));
          } else {
            await beforeExecute(toolCallId, ctx);
          }
        }
        return searchAndLoad(params, signal);
      },
    };
    this.pi.registerTool(searchDefinition);
  }

  private registerScriptTool(): void {
    if (this.scriptToolRegistered) {
      return;
    }
    const options = this.options;
    const beforeExecute = options.beforeExecute;
    const getToolState = (signal?: AbortSignal) => this.host.getToolState(signal);
    const getPiTools = () => this.pi.getAllTools();
    this.loader.registerFeature("script", {
      ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
      name: "mcp_script",
      label: "MCP Script",
      description:
        "Compose MCP calls with trusted JavaScript: await tools.search({query, server?}), tools.describe({path}), tools.call(path,args). Describe returns complete JSON schemas. Calls return {ok,data} with raw MCP results, or {ok:false,error,data?}. Resources: tools.resources({server}), tools.readResource({server,uri}). Saved results: tools.readResult({ref,path?,fields?,offset?,limit?}); never repeats a remote call. Use emit(value) to return selected data or content blocks. No Node, filesystem, or network globals. Prefer a direct tool for one call; use scripts for loops, filtering and chains.",
      promptSnippet:
        "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      parameters: Type.Object({
        code: Type.String({
          description:
            "Trusted JavaScript MCP script. Use tools.<prefixedToolName>(args) and emit(value).",
        }),
        timeoutMs: Type.Optional(
          Type.Number({
            minimum: 1,
            description:
              options.defaultScriptTimeoutMs === null
                ? "Execution timeout in milliseconds (no default deadline)"
                : `Execution timeout in milliseconds (default: ${options.defaultScriptTimeoutMs ?? DEFAULT_MCP_SCRIPT_TIMEOUT_MS})`,
          }),
        ),
      }),
      renderResult: renderMcpToolResult,
      async execute(
        ...[toolCallId, params, signal, , ctx]: HostToolArguments<{
          code: string;
          timeoutMs?: number;
        }>
      ) {
        const ready = await getToolState(signal);
        if ("content" in ready) {
          return ready;
        }
        const { runMcpScript } = await import("./mcp-code.ts");
        return runMcpScript(
          ready,
          params.code,
          params.timeoutMs ?? options.defaultScriptTimeoutMs,
          getPiTools,
          signal,
          toolCallId,
          beforeExecute
            ? (callSignal, operation) =>
                beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation)
            : undefined,
        );
      },
    });
    this.scriptToolRegistered = true;
  }

  private registerProxyTool(description: string): void {
    const beforeExecute = this.options.beforeExecute;
    this.loader.registerFeature("gateway", {
      ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
      name: "mcp",
      label: "MCP",
      description,
      promptSnippet:
        "MCP server operations, resources, saved result readback, and fallback tool calls",
      renderCall: renderMcpProxyToolCall,
      parameters: gatewayParameters,
      prepareArguments: prepareGatewayArguments,
      renderResult: renderMcpToolResult,
      execute: (...args: HostToolArguments<GatewayArguments>) =>
        executeGateway(this.pi, this.host, this.options, args),
    });
    this.proxyToolRegistered = true;
    this.proxyToolDescription = description;
  }

  syncGateways(
    config: McpConfig,
    cache: MetadataCache | null,
    directSpecs: DirectToolSpec[],
  ): FeaturePolicy {
    const policy: FeaturePolicy = {};
    if (config.settings?.scriptMode !== false) {
      policy.script = {};
    }
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
      if (!this.proxyToolRegistered || this.proxyToolDescription !== description) {
        this.registerProxyTool(description);
      }
      policy.gateway = { eager: hasPinnedResources };
    }

    if (policy.script) {
      this.registerScriptTool();
    }
    return policy;
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

function findMatches(
  ready: McpExtensionState,
  params: SearchParams & { query: string },
): Parameters<ReturnType<typeof createToolLoader>["activate"]>[0] {
  if (params.query.trim().length > 0) {
    return rankToolMatches(ready, params.query, params.server);
  }
  const server = params.server;
  if (server === undefined || server.length === 0) {
    return [];
  }
  return (ready.toolMetadata.get(server) ?? [])
    .filter((tool) => tool.resourceUri === undefined || tool.resourceUri.length === 0)
    .map((tool) => ({ server, tool }))
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
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

function needsDiscovery(ready: McpExtensionState, server: string): boolean {
  return server.length > 0 && !ready.toolMetadata.has(server);
}
