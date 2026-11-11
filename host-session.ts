import type { McpExtensionState } from "./state.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";

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
}
