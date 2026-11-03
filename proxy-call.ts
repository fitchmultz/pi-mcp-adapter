import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  type ToolMetadata,
  type McpOperationContext,
  type McpToolCallIdentity,
  getServerPrefix,
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
export interface ExecuteCallOptions {
  exactOriginalName?: boolean;
  resourceUri?: string;
  /** Scripts receive the raw protocol result without model-facing content transformation. */
  raw?: boolean;
}

interface ExecuteCallRequest {
  toolName: string;
  args?: Record<string, unknown> | undefined;
  serverOverride?: string | undefined;
  getPiTools?: (() => ToolInfo[]) | undefined;
  signal?: AbortSignal | undefined;
  identity?: McpToolCallIdentity | undefined;
  beforeDispatch?:
    | ((signal: AbortSignal | undefined, operation: McpOperationContext) => Promise<void>)
    | undefined;
  options?: ExecuteCallOptions | undefined;
}
interface CallRequest extends ExecuteCallRequest {
  identity: McpToolCallIdentity;
  options: ExecuteCallOptions;
}
function invalidCall(
  toolName: unknown,
  serverOverride: unknown,
  args: unknown,
): ProxyToolResult | undefined {
  if (
    typeof toolName !== "string" ||
    toolName.trim().length === 0 ||
    (serverOverride !== undefined &&
      (typeof serverOverride !== "string" || serverOverride.length === 0))
  ) {
    return {
      content: [
        { type: "text", text: "Specify a non-empty tool name and, when supplied, server." },
      ],
      details: { mode: "call", error: "invalid_arguments" },
    };
  }
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    return {
      content: [{ type: "text", text: "Tool arguments must be an object." }],
      details: { mode: "call", error: "invalid_arguments", requestedTool: toolName },
    };
  }
  return;
}
export async function executeCall(
  state: McpExtensionState,
  request: ExecuteCallRequest,
): Promise<ProxyToolResult> {
  return executeResolvedCall(state, {
    ...request,
    identity: request.identity ?? {},
    options: request.options ?? {},
  });
}

function callPreparationError(
  error: ProxyToolResult,
  cachedTarget: ToolMetadata | undefined,
  toolName: string,
): ProxyToolResult {
  let target: Record<string, unknown> = { requestedTool: toolName };
  if (cachedTarget) {
    target =
      (cachedTarget.resourceUri ?? "").length > 0
        ? { resourceUri: cachedTarget.resourceUri }
        : { tool: cachedTarget.originalName };
  }
  return { ...error, details: { ...error.details, ...target } };
}
function approvalFailure(
  reason: string,
  serverName: string,
  toolMeta: ToolMetadata,
): ProxyToolResult {
  const denied = reason === "denied";
  return {
    content: [
      {
        type: "text",
        text: denied
          ? `The user declined approval to run MCP tool "${toolMeta.originalName}" on server "${serverName}".`
          : `MCP tool "${toolMeta.originalName}" on server "${serverName}" is approval-gated and requires an interactive session.`,
      },
    ],
    details: {
      mode: "call",
      error: denied ? "approval_denied" : "approval_required",
      server: serverName,
      tool: toolMeta.originalName,
    },
  };
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
    const { toolName, serverOverride } = this.request;
    const inferred = (serverOverride ?? "").length > 0 ? serverOverride : this.inferServer();
    if (typeof inferred === "object") {
      return inferred;
    }
    const serverName = inferred;
    if (serverName === undefined || serverName.length === 0) {
      return this.missing(serverName);
    }
    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [
          {
            type: "text",
            text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers (load it first with mcp_search({ enable: ["gateway"] }) if inactive).`,
          },
        ],
        details: {
          mode: "call",
          error: "server_not_found",
          server: serverName,
          requestedTool: toolName,
        },
      };
    }
    if (isServerDisabled(definition)) {
      return disabledResult("call", serverName);
    }
    const catalogError = this.cachedCatalogError(serverName);
    if (catalogError) {
      return catalogError;
    }
    return serverName;
  }
  private cachedCatalogError(serverName: string): ProxyToolResult | undefined {
    const { state } = this;
    const { options } = this.request;
    const cached = state.toolMetadata.get(serverName);
    if (this.matches(cached).length > 1) {
      return this.ambiguous(serverName);
    }
    // Misspellings in a known catalog do not cause connection churn or guessed execution.
    if (
      cached &&
      this.matches(cached).length === 0 &&
      options.exactOriginalName !== true &&
      options.resourceUri === undefined
    ) {
      return this.missing(serverName);
    }

    return;
  }
  matches(metadata: ToolMetadata[] = []): ToolMetadata[] {
    const { options, serverOverride, toolName } = this.request;
    if (options.resourceUri !== undefined) {
      return metadata.filter((tool) => tool.resourceUri === options.resourceUri);
    }
    if (options.exactOriginalName === true) {
      return metadata.filter(
        (tool) => tool.originalName === toolName && (tool.resourceUri ?? "").length === 0,
      );
    }
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
    return metadata.filter((tool) => tool.name.replace(/-/g, "_") === toolName.replace(/-/g, "_"));
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
        : this.matches(metadata).map((tool) => ({ server, tool })),
    );
    if (candidates.length > 1) {
      return this.ambiguous();
    }
    const serverName = candidates[0]?.server;
    if (serverName === undefined || serverName.length === 0) {
      const disabled = [...state.toolMetadata].find(
        ([server, metadata]) =>
          isServerDisabled(state.config.mcpServers[server]) && this.matches(metadata).length > 0,
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
    const prefixes = Object.entries(state.config.mcpServers)
      .filter(([, definition]) => !isServerDisabled(definition))
      .map(([server, definition]) => ({
        server,
        prefix: getServerPrefix(
          server,
          resolveToolPrefix(definition, state.config.settings?.toolPrefix ?? "server"),
        ),
      }))
      .filter(({ prefix }) => prefix.length > 0 && toolName.startsWith(`${prefix}_`))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    if (prefixes.length > 1 && prefixes[0]?.prefix === prefixes[1]?.prefix) {
      return this.ambiguous();
    }
    return prefixes[0]?.server;
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
              this.matches(metadata).length === 1,
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
    hint += ' If mcp is inactive, load it with mcp_search({ enable: ["gateway"] }).';
    if (
      serverName !== undefined &&
      serverName.length > 0 &&
      state.toolMetadata.has(serverName) &&
      state.manager.getConnection(serverName)?.status !== "connected"
    ) {
      hint += ` Refresh a stale catalog with mcp({ action: "connect", server: ${JSON.stringify(serverName)} }).`;
    }

    return hint;
  }
  missing(serverName?: string): ProxyToolResult {
    const { state } = this;
    const { toolName, serverOverride, getPiTools } = this.request;
    const nativeTool =
      (serverOverride ?? "").length === 0 &&
      getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp");
    if (nativeTool !== false && nativeTool !== undefined) {
      return {
        content: [
          {
            type: "text",
            text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ action: "call", tool: "${toolName}" }).`,
          },
        ],
        details: { mode: "call", error: "native_tool", requestedTool: toolName },
      };
    }
    const suggestedOwner = this.suggestedOwner();
    if (suggestedOwner) {
      return {
        content: [
          {
            type: "text",
            text: `Tool ${JSON.stringify(toolName)} is on server ${JSON.stringify(suggestedOwner[0])}, not ${JSON.stringify(serverOverride)}. Retry the same call with server: ${JSON.stringify(suggestedOwner[0])} or omit server.`,
          },
        ],
        details: {
          mode: "call",
          error: "tool_not_found",
          requestedTool: toolName,
          hintServer: serverName,
          suggestedServer: suggestedOwner[0],
          suggestions: this.matches(suggestedOwner[1]).map((tool) => tool.name),
        },
      };
    }
    const suggestions = rankSuggestions(state, toolName, 5, serverName);
    const hint = this.missingHint(serverName, suggestions);
    return {
      content: [{ type: "text", text: `Tool "${toolName}" not found.${hint}` }],
      details: {
        mode: "call",
        error: "tool_not_found",
        requestedTool: toolName,
        hintServer: serverName,
        suggestions,
      },
    };
  }
}
async function executeResolvedCall(
  state: McpExtensionState,
  request: CallRequest,
): Promise<ProxyToolResult> {
  const { toolName, args, serverOverride, signal } = request;
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const invalid = invalidCall(toolName, serverOverride, args);
  if (invalid) {
    return invalid;
  }
  const lookup = new CallLookup(state, request);
  const resolved = lookup.resolve();
  if (typeof resolved !== "string") {
    return resolved;
  }
  const serverName = resolved;
  const cached = state.toolMetadata.get(serverName);
  const prepared = await prepareMcpConnection(state, serverName, ownedSignal);
  if (prepared.error) {
    return callPreparationError(prepared.error, lookup.matches(cached)[0], toolName);
  }
  const targets = lookup.matches(state.toolMetadata.get(serverName));
  if (targets.length > 1) {
    return lookup.ambiguous(serverName);
  }
  const toolMeta = targets[0];
  if (!toolMeta) {
    return lookup.missing(serverName);
  }
  if (isServerDisabled(state.config.mcpServers[serverName])) {
    return disabledResult("call", serverName);
  }
  return dispatchApprovedCall(state, request, { serverName, toolMeta, ownedSignal, prepared });
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
  const { args, identity, beforeDispatch, options, signal } = request;
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
      ...(options.raw !== undefined ? { raw: options.raw } : {}),
      detailsBase: {
        mode: "call",
        server: serverName,
        ...((toolMeta.resourceUri ?? "").length > 0
          ? { resourceUri: toolMeta.resourceUri }
          : { tool: toolMeta.originalName }),
      },
      ownedSignal,
      signal,
      recoverAuthConnection: prepared.recoverAuthConnection,
      authRequiredMessage: () => getAuthRequiredMessage(state, serverName),
      autoAuthAttempted: prepared.autoAuthAttempted,
    },
  });
}
