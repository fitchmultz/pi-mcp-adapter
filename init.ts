import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled } from "./types.ts";
import {
  createMcpRuntimeOwner,
  combineAbortSignals,
  type McpRuntimeOwner,
} from "./runtime-owner.ts";
import { createInitialState, type McpInitializationOptions } from "./init-state.ts";
import {
  registerServers,
  connectStartupServers,
  bootstrapDirectTools,
  bindLifecycle,
} from "./init-startup.ts";
import { publishMcpStatusSnapshot } from "./mcp-status.ts";

export { MAX_CONCURRENT_SERVER_CONNECTS } from "./utils.ts";
export {
  clearFailure,
  recordFailure,
  updateStatusBar,
  getFailureAgeSeconds,
  getFailureRemainingSeconds,
  getFailureMessage,
  lazyConnect,
} from "./init-status.ts";
export {
  applyConnectionMetadata,
  markKeepAliveAfterConnect,
  updateServerMetadata,
  updateMetadataCache,
  notifyToolMetadataUpdated,
  flushMetadataCache,
} from "./init-metadata.ts";

function formatStartupConfigErrorLine(error: {
  severity: string;
  filePath: string;
  serverName?: string;
  field?: string;
  message: string;
}): string {
  const scope = [error.serverName, error.field].filter(Boolean).join(".");
  const location = scope.length > 0 ? `${error.filePath} (${scope})` : error.filePath;
  return `  • [${error.severity}] ${location}: ${error.message}`;
}

function reportStartupConfigErrors(state: McpExtensionState): void {
  const errors = state.configErrors;
  if (!state.ui || !errors || errors.length === 0) {
    return;
  }
  const preview = errors.slice(0, 5).map(formatStartupConfigErrorLine);
  const overflow =
    errors.length > 5 ? [`  … and ${errors.length - 5} more (run /mcp doctor for details)`] : [];
  const header = `MCP configuration validation (${errors.length} ${errors.length === 1 ? "issue" : "issues"}):`;
  state.ui.notify([header, ...preview, ...overflow].join("\n"), "warning");
}

function isStartupServer(definition: McpExtensionState["config"]["mcpServers"][string]): boolean {
  const mode = definition.lifecycle ?? "lazy";
  return mode === "keep-alive" || mode === "eager";
}

async function connectInitialServers(
  state: McpExtensionState,
  startupServers: Array<[string, McpExtensionState["config"]["mcpServers"][string]]>,
  signals: { initial: AbortSignal | undefined; runtime: AbortSignal | undefined },
): Promise<void> {
  const startupNames = new Set(startupServers.map(([name]) => name));
  const [connectedStartupServers] = await Promise.all([
    connectStartupServers(state, startupServers, signals),
    signals.initial?.aborted === true
      ? Promise.resolve()
      : bootstrapDirectTools(state, (name) => !startupNames.has(name), signals.runtime),
  ]);
  if (signals.initial?.aborted === true) {
    return;
  }
  const failedStartupNames = new Set(
    [...startupNames].filter((name) => !connectedStartupServers.has(name)),
  );
  if (failedStartupNames.size > 0) {
    await bootstrapDirectTools(state, (name) => failedStartupNames.has(name), signals.runtime);
  }
}

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: McpRuntimeOwner = createMcpRuntimeOwner(),
  options: McpInitializationOptions = {},
): Promise<McpExtensionState> {
  // Capture host getters before the first await; Pi invalidates them on reload.
  // ctx.signal is the current agent run's signal (undefined between runs): it scopes per-run
  // startup work below. Session-scoped background work binds to owner.signal alone.
  const initialSignal = ctx.signal;
  const hasUI = ctx.hasUI;
  const runtimeSignal = combineAbortSignals(owner.signal, initialSignal);
  const state = createInitialState(pi, ctx, owner, options);
  if (hasUI) {
    reportStartupConfigErrors(state);
  }
  const allServerEntries = Object.entries(state.config.mcpServers);
  const serverEntries = allServerEntries.filter(([, definition]) => !isServerDisabled(definition));
  if (serverEntries.length === 0) {
    if (allServerEntries.length > 0 && hasUI) {
      state.ui?.notify(`MCP: All ${allServerEntries.length} server(s) are disabled`, "info");
    }
    publishMcpStatusSnapshot(state);
    return state;
  }
  registerServers(state, serverEntries);
  const startupServers = serverEntries.filter(([, definition]) => isStartupServer(definition));
  await connectInitialServers(state, startupServers, {
    initial: initialSignal,
    runtime: runtimeSignal,
  });
  bindLifecycle(state, owner.signal);
  publishMcpStatusSnapshot(state);
  return state;
}
