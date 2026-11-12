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
  getFailureMessage,
  lazyConnect,
} from "./init-status.ts";
export {
  markKeepAliveAfterConnect,
  updateServerMetadata,
  updateMetadataCache,
  notifyToolMetadataUpdated,
  flushMetadataCache,
} from "./init-metadata.ts";

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
  const startupServers = serverEntries.filter(([, definition]) => {
    const mode = definition.lifecycle ?? "lazy";
    return mode === "keep-alive" || mode === "eager";
  });
  const connected = await connectStartupServers(state, startupServers, {
    initial: initialSignal,
    runtime: runtimeSignal,
  });
  if (initialSignal?.aborted !== true) {
    await bootstrapDirectTools(state, connected, runtimeSignal);
  }
  bindLifecycle(state, owner.signal);
  publishMcpStatusSnapshot(state);
  return state;
}
