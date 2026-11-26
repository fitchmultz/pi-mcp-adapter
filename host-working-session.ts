import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasAnyPendingAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import type { McpExtensionState } from "./state.ts";

export interface WorkingSessionSaveEvent {
  readonly type: "working_session_save";
  readonly boundary: "turn" | "settled";
  readonly signal: AbortSignal;
  readonly invalidate?: (reason: string) => void;
}

export interface WorkingSessionReadiness {
  readonly blockers?: string[];
}

export interface DeferredToolSurfaceActions {
  readonly settlePins: boolean;
  readonly toolSync: boolean;
  readonly activateToolSearch: boolean;
  readonly promptSync: boolean;
}

interface WorkingSessionEventHost {
  readonly on: (
    event: "working_session_save",
    handler: (
      event: WorkingSessionSaveEvent,
      ctx: ExtensionContext,
    ) => Promise<WorkingSessionReadiness | undefined> | WorkingSessionReadiness | undefined,
  ) => () => void;
}

function supportsWorkingSessionSave(
  pi: Partial<Pick<ExtensionAPI, "on">>,
): pi is Partial<Pick<ExtensionAPI, "on">> & WorkingSessionEventHost {
  return typeof pi.on === "function";
}

export function registerWorkingSessionSaveHandler(
  pi: Partial<Pick<ExtensionAPI, "on">>,
  handler: (
    event: WorkingSessionSaveEvent,
    ctx: ExtensionContext,
  ) => Promise<WorkingSessionReadiness | undefined> | WorkingSessionReadiness | undefined,
): (() => void) | undefined {
  if (!supportsWorkingSessionSave(pi)) {
    return undefined;
  }
  return pi.on("working_session_save", handler);
}

/**
 * Coordinates with Pi's `working_session_save` hold so managed restarts never race tool
 * registrations or active-tool updates while a working-session snapshot is being captured.
 */
export class WorkingSessionCoordinator {
  private readonly activeSignals = new Set<AbortSignal>();
  private deferredSettlePins = false;
  private deferredToolSync = false;
  private deferredActivateToolSearch = false;
  private deferredPromptSync = false;

  isSaving(): boolean {
    return this.activeSignals.size > 0;
  }

  deferSettlePins(): void {
    this.deferredSettlePins = true;
  }

  deferToolSync(): void {
    this.deferredToolSync = true;
  }

  deferActivateToolSearch(): void {
    this.deferredActivateToolSearch = true;
  }

  deferPromptSync(): void {
    this.deferredPromptSync = true;
  }

  reset(): void {
    this.activeSignals.clear();
    this.deferredSettlePins = false;
    this.deferredToolSync = false;
    this.deferredActivateToolSearch = false;
    this.deferredPromptSync = false;
  }

  collectBlockers(state: McpExtensionState | null, oauthRuntime: McpOAuthRuntime | null): string[] {
    const blockers: string[] = [];
    if (oauthRuntime && hasAnyPendingAuth(oauthRuntime)) {
      blockers.push("MCP OAuth authentication is in progress");
    }
    if (state) {
      for (const [name, connection] of state.manager.getAllConnections()) {
        if (state.manager.inFlightCount(connection) > 0) {
          blockers.push(`MCP requests to ${name} are in progress`);
        }
      }
      if (state.activeScripts > 0) {
        blockers.push("MCP script execution is in progress");
      }
    }
    return blockers;
  }

  handleSave(
    event: WorkingSessionSaveEvent,
    blockers: string[],
    onFlush: (actions: DeferredToolSurfaceActions) => void,
  ): WorkingSessionReadiness {
    if (!event.signal.aborted) {
      this.activeSignals.add(event.signal);
      event.signal.addEventListener(
        "abort",
        () => {
          this.activeSignals.delete(event.signal);
          if (this.activeSignals.size === 0) {
            this.flush(onFlush);
          }
        },
        { once: true },
      );
    }
    return { blockers };
  }

  private flush(onFlush: (actions: DeferredToolSurfaceActions) => void): void {
    const actions: DeferredToolSurfaceActions = {
      settlePins: this.deferredSettlePins,
      toolSync: this.deferredToolSync,
      activateToolSearch: this.deferredActivateToolSearch,
      promptSync: this.deferredPromptSync,
    };
    this.deferredSettlePins = false;
    this.deferredToolSync = false;
    this.deferredActivateToolSearch = false;
    this.deferredPromptSync = false;
    if (
      actions.settlePins ||
      actions.toolSync ||
      actions.activateToolSearch ||
      actions.promptSync
    ) {
      onFlush(actions);
    }
  }
}
