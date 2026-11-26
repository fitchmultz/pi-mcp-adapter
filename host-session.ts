import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abort.ts";
import type { McpAdapterHost } from "./host-contract.ts";
import type { McpExtensionState } from "./state.ts";
import { isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpConfig } from "./types.ts";

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_WAIT_TIMED_OUT = Symbol("init-wait-timed-out");

type ToolStateUnavailable = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string; message?: string; timeoutMs?: number };
};

async function awaitWithTimeout<T>(promise: Promise<T>): Promise<T | typeof INIT_WAIT_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof INIT_WAIT_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(INIT_WAIT_TIMED_OUT), INIT_WAIT_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailableStateMessage(session: HostSession): string {
  const failure = session.failureMessage;
  return failure === null ? "MCP not initialized" : `MCP initialization failed: ${failure}`;
}

function cancelled(
  owner: McpRuntimeOwner | null,
  signal: AbortSignal | undefined,
  error: unknown,
): boolean {
  return signal?.aborted === true || (owner !== null && isAbortError(error, owner.signal));
}

export interface FrozenToolsSnapshot {
  readonly config: McpConfig;
  readonly configPath: string | undefined;
  readonly cacheEnabled: boolean | undefined;
}

/** Whether a cwd-driven session restart can keep already-frozen tool declarations untouched. */
export function canPreserveFrozenTools(
  wasFrozen: boolean,
  previous: FrozenToolsSnapshot,
  next: FrozenToolsSnapshot,
): boolean {
  return (
    wasFrozen &&
    next.config.settings?.freezeDirectTools === true &&
    next.cacheEnabled === previous.cacheEnabled &&
    next.configPath === previous.configPath &&
    isDeepStrictEqual(next.config, previous.config)
  );
}

/**
 * Phases of one adapter session.
 *
 * The phase used to be inferred from which of the state, its initialization promise and the runtime
 * owner happened to be set. "Never started", "start failed" and "shut down" were then the same
 * observation, and a failed initialization lost its reason with its promise. Every transition below
 * is the only place those fields change.
 */
export type HostSessionPhase = "idle" | "starting" | "initializing" | "ready" | "failed";

export class HostSession {
  private currentPhase: HostSessionPhase = "idle";
  private generation = 0;
  private owner: McpRuntimeOwner | null = null;
  private state: McpExtensionState | null = null;
  private initPromise: Promise<McpExtensionState> | null = null;
  private failure: string | null = null;

  get phase(): HostSessionPhase {
    return this.currentPhase;
  }

  get currentState(): McpExtensionState | null {
    return this.state;
  }

  get currentOwner(): McpRuntimeOwner | null {
    return this.owner;
  }

  get pendingInitialization(): Promise<McpExtensionState> | null {
    return this.initPromise;
  }

  /** Why the current session's initialization failed, or null. */
  get failureMessage(): string | null {
    return this.failure;
  }

  /** Starts a session and returns the generation that owns it. */
  begin(owner: McpRuntimeOwner): number {
    this.generation += 1;
    this.currentPhase = "starting";
    this.owner = owner;
    this.state = null;
    this.initPromise = null;
    this.failure = null;
    return this.generation;
  }

  /** Whether this owner and generation still own the runtime. */
  owns(owner: McpRuntimeOwner | null, generation: number): boolean {
    return (
      owner !== null && owner === this.owner && generation === this.generation && owner.isActive()
    );
  }

  /** Records the initialization that carries a starting session to ready or failed. */
  initialize(generation: number, promise: Promise<McpExtensionState>): void {
    if (generation !== this.generation) {
      return;
    }
    this.currentPhase = "initializing";
    this.initPromise = promise;
  }

  /** Publishes a state whose initialization resolved, without settling the session yet. */
  adopt(state: McpExtensionState): void {
    this.state = state;
  }

  /** Settles the session as ready; also clears a promise whose completion work failed later. */
  ready(state: McpExtensionState): void {
    this.state = state;
    this.initPromise = null;
    this.currentPhase = "ready";
  }

  /** Records a rejected initialization for a session that never published a state. */
  fail(message: string): void {
    this.currentPhase = "failed";
    this.initPromise = null;
    this.failure = message;
  }

  /** Ends the session; its owner, state and diagnostics do not survive it. */
  end(): void {
    this.generation += 1;
    this.currentPhase = "idle";
    this.owner = null;
    this.state = null;
    this.initPromise = null;
    this.failure = null;
  }

  isLiveOwner(owner: McpRuntimeOwner | null): owner is McpRuntimeOwner {
    return owner !== null && owner === this.owner && owner.isActive();
  }

  async awaitReadyState(): Promise<{
    readonly state: McpExtensionState;
    readonly owner: McpRuntimeOwner;
  } | null> {
    const owner = this.owner;
    if (!this.isLiveOwner(owner)) {
      return null;
    }
    const pending = this.initPromise;
    if (!this.state && pending) {
      const initialized = await pending.catch(() => null);
      if (!initialized || !this.isLiveOwner(owner)) {
        return null;
      }
      this.adopt(initialized);
    }
    return this.state && this.isLiveOwner(owner) ? { state: this.state, owner } : null;
  }

  async ensureCommandState(
    owner: McpRuntimeOwner | null,
    ctx: ExtensionContext,
  ): Promise<McpExtensionState | null> {
    const pending = this.initPromise;
    if (!this.state && pending) {
      try {
        const initialized = await pending;
        owner?.throwIfInactive();
        this.adopt(initialized);
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return null;
      }
    }
    if (!this.state && ctx.hasUI) {
      ctx.ui.notify(unavailableStateMessage(this), "error");
    }
    return this.state;
  }

  async getToolState(signal?: AbortSignal): ReturnType<McpAdapterHost["getToolState"]> {
    const owner = this.owner;
    const pending = this.initPromise;
    if (!this.state && pending) {
      try {
        const initialized = await awaitWithTimeout(abortable(pending, signal));
        if (initialized === INIT_WAIT_TIMED_OUT) {
          return {
            content: [
              { type: "text", text: "MCP initialization is still in progress. Try again shortly." },
            ],
            details: { error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
          };
        }
        owner?.throwIfInactive();
        this.adopt(initialized);
      } catch (error) {
        if (cancelled(owner, signal, error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    owner?.throwIfInactive();
    return this.toolStateReport();
  }

  private toolStateReport(): McpExtensionState | ToolStateUnavailable {
    if (this.state) {
      return this.state;
    }
    if (this.failure === null) {
      return {
        content: [{ type: "text", text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }
    return {
      content: [{ type: "text", text: `MCP initialization failed: ${this.failure}` }],
      details: { error: "init_failed", message: this.failure },
    };
  }
}
