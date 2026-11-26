import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { shutdownOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";

/** Owns the final UI handle release and persistence/transport teardown for a state. */
export class McpStateCleanup {
  private readonly state: McpExtensionState;

  constructor(state: McpExtensionState) {
    this.state = state;
  }

  closeUiServer(reason: string): void {
    try {
      this.state.uiServer?.close(reason);
    } finally {
      this.state.uiServer = null;
      this.state.pendingUiModelContext = undefined;
    }
  }

  async stop(
    reason: string,
    flush: ((state: McpExtensionState) => void) | undefined,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      publishMcpStatusShutdown(this.state.statusEvents);
    } catch (error) {
      failures.push(error);
    }
    try {
      this.closeUiServer(reason);
    } catch (error) {
      failures.push(error);
    }
    try {
      // Snapshot live connections before owner cleanup can retire them.
      flush?.(this.state);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.state.owner.stop(reason);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP state persistence/cleanup failed");
    }
  }
}

export async function stopRuntimeSession(input: {
  readonly events: ExtensionAPI["events"];
  readonly state: McpExtensionState | null;
  readonly owner: McpRuntimeOwner | null;
  readonly oauthRuntime: McpOAuthRuntime | null;
  readonly stateReason: string;
  readonly ownerReason: string;
  readonly flush: ((state: McpExtensionState) => void) | undefined;
}): Promise<unknown[]> {
  const stopState = input.state
    ? new McpStateCleanup(input.state).stop(input.stateReason, input.flush)
    : Promise.resolve().then(() => publishMcpStatusShutdown(input.events));
  const tasks: Array<Promise<unknown>> = [stopState];
  if (input.owner) {
    tasks.push(input.owner.stop(input.ownerReason));
  }
  if (input.oauthRuntime) {
    tasks.push(shutdownOAuth(input.oauthRuntime));
  }
  const results = await Promise.allSettled(tasks);
  return results.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : [],
  );
}
