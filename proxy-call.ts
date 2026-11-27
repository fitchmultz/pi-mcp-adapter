import type { McpExtensionState } from "./state.ts";
import {
  type ProxyToolResult,
  type ProxyToolUpdateCallback,
  disabledResult,
  dynamicResourceTarget,
  resourcesDisabledResult,
} from "./proxy-result.ts";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TOOL_PREFIX,
  type ToolMetadata,
  type ServerEntry,
  type McpOperationContext,
  type McpToolCallIdentity,
  getServerPrefix,
  getServerToolPrefix,
  isServerDisabled,
  resolveToolPrefix,
} from "./types.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import { rankSuggestions } from "./search-ranking.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";
import { getAuthRequiredMessage } from "./proxy-auth.ts";
import { prepareMcpConnection } from "./proxy-connection.ts";
import { runToolCall } from "./proxy-call-runtime.ts";
import {
  approvalFailure,
  callPreparationError,
  invalidCallRequest,
  nativeToolCallResult,
  serverNotFoundResult,
  suggestedServerCallResult,
  validateCallTargetArguments,
} from "./proxy-call-validate.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import {
  catalogCoverage,
  matchesBackwardCompatibleToolName,
  undiscoveredServersHint,
} from "./tool-metadata.ts";
export interface ExecuteCallOptions {
  exactOriginalName?: boolean;
  resourceUri?: string;
}

interface ExecuteCallRequest {
  toolName: string;
  args?: unknown;
  serverOverride?: string | undefined;
  getPiTools?: (() => ToolInfo[]) | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?: ProxyToolUpdateCallback | undefined;
  identity?: McpToolCallIdentity | undefined;
  beforeDispatch?:
    | ((signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>)
    | undefined;
  options?: ExecuteCallOptions | undefined;
}
interface CallRequest extends Omit<ExecuteCallRequest, "args"> {
  args: Record<string, unknown> | undefined;
  identity: McpToolCallIdentity;
  options: ExecuteCallOptions;
}
export async function executeCall(
  state: McpExtensionState,
  request: ExecuteCallRequest,
): Promise<ProxyToolResult> {
  const input = {
    ...request,
    identity: request.identity ?? {},
    options: request.options ?? {},
  };
  const { toolName, args: rawArgs, serverOverride, signal } = input;
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const invalid = invalidCallRequest(toolName, serverOverride);
  if (invalid) {
    return invalid;
  }
  const args = asObjectRecord(rawArgs);
  if (rawArgs !== undefined && (args === undefined || Array.isArray(rawArgs))) {
    return {
      content: [{ type: "text", text: "Tool arguments must be an object." }],
      details: { mode: "call", error: "invalid_arguments", requestedTool: toolName },
    };
  }
  return executeResolvedCall(state, { ...input, args }, ownedSignal);
}
class CallLookup {
  private readonly state: McpExtensionState;
  private readonly request: CallRequest;
  constructor(state: McpExtensionState, request: CallRequest) {
    this.state = state;
    this.request = request;
  }
  resolve(): string | ProxyToolResult {
    const { state } = this;
    const { serverOverride } = this.request;
    const inferred = (serverOverride ?? "").length > 0 ? serverOverride : this.inferServer();
    if (typeof inferred === "object") {
      return inferred;
    }
    const serverName = inferred;
    if (serverName === undefined || serverName.length === 0) {
      return this.missing(serverName);
    }
    return (
      this.definitionError(serverName, state.config.mcpServers[serverName]) ??
      this.cachedCatalogError(serverName) ??
      serverName
    );
  }
  private definitionError(
    serverName: string,
    definition: ServerEntry | undefined,
  ): ProxyToolResult | undefined {
    if (!definition) {
      return serverNotFoundResult(serverName, this.request.toolName);
    }
    if (isServerDisabled(definition)) {
      return disabledResult("call", serverName);
    }
    if (this.request.options.resourceUri !== undefined && definition.exposeResources === false) {
      return resourcesDisabledResult(serverName, this.request.options.resourceUri);
    }
    return undefined;
  }
  private cachedCatalogError(serverName: string): ProxyToolResult | undefined {
    const { state } = this;
    const { options } = this.request;
    const cached = state.toolMetadata.get(serverName);
    const matched = this.matches(cached, serverName);
    if (matched.length > 1) {
      return this.ambiguous(serverName);
    }
    // Misspellings in a known catalog do not cause connection churn or guessed execution.
    if (
      cached &&
      matched.length === 0 &&
      options.exactOriginalName !== true &&
      options.resourceUri === undefined
    ) {
      return this.missing(serverName);
    }

    return;
  }
  matches(metadata: ToolMetadata[] = [], serverName?: string): ToolMetadata[] {
    const { options, serverOverride, toolName } = this.request;
    if (options.resourceUri !== undefined) {
      return metadata.filter((tool) => tool.resourceUri === options.resourceUri);
    }
    if (options.exactOriginalName === true) {
      return metadata.filter(
        (tool) => tool.originalName === toolName && (tool.resourceUri ?? "").length === 0,
      );
    }
    const direct = this.matchDirectNames(metadata, serverOverride, toolName);
    if (direct.length > 0 || serverName === undefined) {
      return direct;
    }
    return this.matchBackwardCompatibleNames(metadata, serverName, toolName);
  }
  private matchDirectNames(
    metadata: ToolMetadata[],
    serverOverride: string | undefined,
    toolName: string,
  ): ToolMetadata[] {
    if ((serverOverride ?? "").length > 0) {
      const originals = metadata.filter((tool) => tool.originalName === toolName);
      if (originals.length > 0) {
        return originals;
      }
    }
    const exact = metadata.filter((tool) => tool.name === toolName);
    if (exact.length > 0) {
      return exact;
    }
    const normalized = toolName.replace(/-/g, "_");
    return metadata.filter((tool) => tool.name.replace(/-/g, "_") === normalized);
  }
  private matchBackwardCompatibleNames(
    metadata: ToolMetadata[],
    serverName: string,
    toolName: string,
  ): ToolMetadata[] {
    const prefix = resolveToolPrefix(
      this.state.config.mcpServers[serverName],
      this.state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX,
    );
    return metadata.filter((tool) =>
      matchesBackwardCompatibleToolName(tool, serverName, toolName, prefix),
    );
  }

  ambiguous(serverName?: string): ProxyToolResult {
    const { toolName } = this.request;
    return {
      content: [
        {
          type: "text",
          text: `Tool "${toolName}" is ambiguous. Specify its exact server and tool name; no call was dispatched.`,
        },
      ],
      details: {
        mode: "call",
        error: "ambiguous_tool",
        requestedTool: toolName,
        ...((serverName ?? "").length > 0 ? { server: serverName } : {}),
      },
    };
  }

  inferServer(): string | ProxyToolResult | undefined {
    const { state } = this;
    const candidates = [...state.toolMetadata].flatMap(([server, metadata]) =>
      isServerDisabled(state.config.mcpServers[server])
        ? []
        : this.matches(metadata, server).map((tool) => ({ server, tool })),
    );
    if (candidates.length > 1) {
      return this.ambiguous();
    }
    const serverName = candidates[0]?.server;
    if (serverName === undefined || serverName.length === 0) {
      const disabled = [...state.toolMetadata].find(
        ([server, metadata]) =>
          isServerDisabled(state.config.mcpServers[server]) &&
          this.matches(metadata, server).length > 0,
      );
      if (disabled) {
        return disabledResult("call", disabled[0]);
      }
      return this.inferPrefix();
    }
    return serverName;
  }

  private inferPrefix(): string | ProxyToolResult | undefined {
    const { state } = this;
    const { toolName } = this.request;
    const globalPrefix = state.config.settings?.toolPrefix ?? DEFAULT_TOOL_PREFIX;
    const enabled = Object.entries(state.config.mcpServers).filter(
      ([, definition]) => !isServerDisabled(definition),
    );
    const configured = enabled.map(([server, definition]) => ({
      server,
      prefix: getServerToolPrefix(server, resolveToolPrefix(definition, globalPrefix)),
    }));
    const direct = this.pickPrefixMatch(configured, toolName);
    if (direct !== undefined) {
      return direct;
    }
    const legacy = enabled
      .filter(([, definition]) => resolveToolPrefix(definition, globalPrefix) === "mcp")
      .flatMap(([server]) => [
        { server, prefix: `${getServerPrefix(server, "mcp")}_` },
        { server, prefix: getServerToolPrefix(server, "server") },
      ]);
    return this.pickPrefixMatch(legacy, toolName);
  }

  private pickPrefixMatch(
    entries: Array<{ server: string; prefix: string }>,
    toolName: string,
  ): string | ProxyToolResult | undefined {
    const matches = entries
      .filter(({ prefix }) => prefix.length > 0 && toolName.startsWith(prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    if (matches.length > 1 && matches[0]?.prefix === matches[1]?.prefix) {
      return this.ambiguous();
    }
    return matches[0]?.server;
  }
  private suggestedOwner() {
    const { state } = this;
    const { toolName, serverOverride } = this.request;
    const normalizedName = toolName.replace(/-/g, "_");
    const localOriginal =
      serverOverride !== undefined &&
      serverOverride.length > 0 &&
      state.toolMetadata
        .get(serverOverride)
        ?.some((tool) => tool.originalName.replace(/-/g, "_") === normalizedName);
    const owners =
      (serverOverride ?? "").length > 0 && localOriginal !== true
        ? [...state.toolMetadata].filter(
            ([server, metadata]) =>
              server !== serverOverride &&
              !isServerDisabled(state.config.mcpServers[server]) &&
              this.matches(metadata, server).length === 1,
          )
        : [];
    const suggestedOwner = owners.length === 1 ? owners[0] : undefined;

    return suggestedOwner;
  }
  private missingHint(serverName: string | undefined, suggestions: string[]): string {
    const { state } = this;
    const { toolName } = this.request;
    let hint: string;
    if (suggestions.length > 0) {
      hint = ` Did you mean: ${suggestions.join(", ")}. Inspect with mcp({ action: "describe", tool: ${JSON.stringify(suggestions[0])} }).`;
    } else if (serverName !== undefined && serverName.length > 0) {
      hint = ` Search with mcp({ action: "search", query: ${JSON.stringify(toolName)}, server: ${JSON.stringify(serverName)} }).`;
    } else {
      hint = ' Use mcp({ action: "search", query: "..." }) to search.';
    }
    if (
      serverName !== undefined &&
      serverName.length > 0 &&
      state.toolMetadata.has(serverName) &&
      state.manager.getConnection(serverName)?.status !== "connected"
    ) {
      hint += ` Refresh a stale catalog with mcp({ action: "connect", server: ${JSON.stringify(serverName)} }).`;
    }
    hint += undiscoveredServersHint(state, serverName);

    return hint;
  }
  missing(serverName?: string): ProxyToolResult {
    const { state } = this;
    const { toolName, serverOverride, getPiTools } = this.request;
    const nativeTool =
      (serverOverride ?? "").length === 0 &&
      getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp");
    if (nativeTool !== false && nativeTool !== undefined) {
      return nativeToolCallResult(toolName);
    }
    const suggestedOwner = this.suggestedOwner();
    if (suggestedOwner) {
      return suggestedServerCallResult({
        toolName,
        serverOverride,
        hintServer: serverName,
        suggestedServer: suggestedOwner[0],
        suggestions: this.matches(suggestedOwner[1], suggestedOwner[0]).map((tool) => tool.name),
      });
    }
    const suggestions = rankSuggestions(state, toolName, 5, serverName);
    const { unknownServers } = catalogCoverage(state, serverName);
    const hint = this.missingHint(serverName, suggestions);
    return {
      content: [{ type: "text", text: `Tool "${toolName}" not found.${hint}` }],
      details: {
        mode: "call",
        error: "tool_not_found",
        requestedTool: toolName,
        hintServer: serverName,
        suggestions,
        ...(unknownServers.length > 0 ? { undiscoveredServers: unknownServers } : {}),
      },
    };
  }
}
function singleMatchedTarget(targets: ToolMetadata[]): ToolMetadata | undefined {
  return targets.length === 1 ? targets[0] : undefined;
}
function resolveTarget(
  state: McpExtensionState,
  request: CallRequest,
  lookup: CallLookup,
  serverName: string,
): ToolMetadata | ProxyToolResult {
  const definition = state.config.mcpServers[serverName];
  if (isServerDisabled(definition)) {
    return disabledResult("call", serverName);
  }
  if (request.options.resourceUri !== undefined && definition?.exposeResources === false) {
    return resourcesDisabledResult(serverName, request.options.resourceUri);
  }
  const targets = lookup.matches(state.toolMetadata.get(serverName), serverName);
  if (targets.length > 1) {
    return lookup.ambiguous(serverName);
  }
  if (targets[0]) {
    return targets[0];
  }
  if (request.options.resourceUri !== undefined) {
    return dynamicResourceTarget(
      serverName,
      request.options.resourceUri,
      definition,
      state.config.settings?.toolPrefix,
    );
  }
  return lookup.missing(serverName);
}
async function executeResolvedCall(
  state: McpExtensionState,
  request: CallRequest,
  ownedSignal: AbortSignal | undefined,
): Promise<ProxyToolResult> {
  const { toolName } = request;
  const lookup = new CallLookup(state, request);
  const resolved = lookup.resolve();
  if (typeof resolved !== "string") {
    return resolved;
  }
  const serverName = resolved;
  const cachedTarget =
    request.options.resourceUri === undefined
      ? singleMatchedTarget(lookup.matches(state.toolMetadata.get(serverName), serverName))
      : undefined;
  let validatedSchema: ToolMetadata["inputSchema"];
  let validatedArgs = request.args;
  if (cachedTarget) {
    const preCheck = validateCallTargetArguments(serverName, cachedTarget, request.args);
    if (!preCheck.ok) {
      return preCheck.error;
    }
    validatedSchema = cachedTarget.inputSchema;
    validatedArgs = preCheck.args;
  }
  const prepared = await prepareMcpConnection(state, serverName, ownedSignal, request.onUpdate);
  if (prepared.error) {
    return callPreparationError(
      prepared.error,
      cachedTarget,
      toolName,
      request.options.resourceUri,
    );
  }
  const target = resolveTarget(state, request, lookup, serverName);
  if ("content" in target) {
    return target;
  }
  if (request.options.resourceUri === undefined && target.inputSchema !== validatedSchema) {
    const liveCheck = validateCallTargetArguments(serverName, target, request.args);
    if (!liveCheck.ok) {
      return liveCheck.error;
    }
    validatedArgs = liveCheck.args;
  }
  return dispatchApprovedCall(
    state,
    { ...request, args: validatedArgs },
    { serverName, toolMeta: target, ownedSignal, prepared },
  );
}
async function dispatchApprovedCall(
  state: McpExtensionState,
  request: CallRequest,
  {
    serverName,
    toolMeta,
    ownedSignal,
    prepared,
  }: {
    serverName: string;
    toolMeta: ToolMetadata;
    ownedSignal: AbortSignal | undefined;
    prepared: Extract<Awaited<ReturnType<typeof prepareMcpConnection>>, { connection: unknown }>;
  },
): Promise<ProxyToolResult> {
  const { args, identity, beforeDispatch, signal, onUpdate } = request;
  const approval = await ensureToolCallApproved(state, {
    serverName,
    toolMeta,
    args,
    signal: ownedSignal,
  });
  if (!approval.ok) {
    return approvalFailure(approval.reason, serverName, toolMeta);
  }
  return runToolCall({
    state,
    serverName,
    target: toolMeta,
    args,
    options: {
      ...identity,
      ...(beforeDispatch ? { beforeDispatch } : {}),
      detailsBase: {
        mode: "call",
        server: serverName,
        ...((toolMeta.resourceUri ?? "").length > 0
          ? { resourceUri: toolMeta.resourceUri }
          : { tool: toolMeta.originalName }),
      },
      ownedSignal,
      signal,
      onUpdate,
      recoverAuthConnection: prepared.recoverAuthConnection,
      authRequiredMessage: () => getAuthRequiredMessage(state, serverName),
      autoAuthAttempted: prepared.autoAuthAttempted,
    },
  });
}
