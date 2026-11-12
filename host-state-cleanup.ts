import type { McpExtensionState } from "./state.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";

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
