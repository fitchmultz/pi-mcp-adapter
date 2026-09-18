import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { flushMetadataCache } from "./init.ts";
import { getOAuthCheckpointBlocker, holdOAuthCheckpoint } from "./mcp-auth-flow.ts";
import { isServerDisabled } from "./types.ts";

/** Optional host event. Published Pi hosts without this event simply never emit it.
 * Keep its structural typing local; do not require a private host package/version. */
export interface McpCheckpointEvent {
  readonly boundary: "turn" | "settled";
  readonly signal: AbortSignal;
  invalidate(): void;
}
export type McpCheckpointResult = { sleepReady: true } | { sleepReady: false; reason: string };
export function onSessionCheckpoint(pi: ExtensionAPI, handler: (event: McpCheckpointEvent) => Promise<McpCheckpointResult>): void {
  (pi.on as unknown as (event: "session_checkpoint", callback: (event: McpCheckpointEvent) => Promise<McpCheckpointResult>) => unknown)("session_checkpoint", handler);
}

/** No shutdown, credential copying, connection replay or permanent owner cancellation. */
export async function prepareMcpCheckpoint(state: McpExtensionState, event: McpCheckpointEvent): Promise<McpCheckpointResult> {
  event.signal.throwIfAborted();
  const releases: Array<() => void> = [];
  const release = () => { for (const undo of releases.splice(0).reverse()) undo(); };
  // Fence all owned sources synchronously, before the first await (including trace flush).
  event.signal.addEventListener("abort", release, { once: true });
  const undo = () => { release(); event.signal.removeEventListener("abort", release); };
  const blocked = (reason: string): McpCheckpointResult => { undo(); return { sleepReady: false, reason }; };
  try {
    releases.push(state.owner.holdCheckpoint(event));
    releases.push(state.manager.holdCheckpoint(event));
    releases.push(holdOAuthCheckpoint(state.oauthRuntime, event));
    releases.push(state.lifecycle.pauseForCheckpoint());
    if (state.lifecycle.hasActiveHealthCheck()) return blocked("MCP health check is active");
    for (const [name, definition] of Object.entries(state.config.mcpServers)) {
      if (!isServerDisabled(definition) && !definition.url) return blocked(`MCP ${name}: stdio/Unix server state is not reconstructible`);
    }
    if (state.onToolCall) return blocked("MCP host capture callback is not checkpoint-supported");
    if (state.activeScripts) return blocked("MCP script is active");
    if (state.uiServer || state.completedUiSessions.length) return blocked("MCP UI session/messages require the running runtime");
    if (state.approvedToolCalls.size || state.consentManager.hasDecisions()) return blocked("MCP session approvals are not persisted");
    const oauth = getOAuthCheckpointBlocker(state.oauthRuntime);
    if (oauth) return blocked(oauth);
    const manager = state.manager.getCheckpointBlocker();
    if (manager) return blocked(manager);
    flushMetadataCache(state);
    await state.manager.flushForCheckpoint();
    event.signal.throwIfAborted();
    // Release/cancellation is host-owned. Existing clients/timers remain usable afterwards.
    return { sleepReady: true };
  } catch (error) {
    undo();
    throw error;
  }
}
