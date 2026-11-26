import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState, McpInitializationOptions } from "./state.ts";
import type { McpAdapterOptions, McpConfig } from "./types.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { shutdownOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { cleanupRuntimeSkills } from "./mcp-skills-store.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import { formatTerminalError } from "./utils.ts";

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
      cleanupRuntimeSkills(this.state);
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

export function logSessionRestartFailures(failures: readonly unknown[]): void {
  for (const error of failures) {
    console.error(`MCP: failed to shut down previous session state: ${formatTerminalError(error)}`);
  }
}

export function shouldAwaitDirectToolBootstrap(input: {
  readonly envRaw: string | undefined;
  readonly envDirectToolOverride: string[] | undefined;
  readonly config: McpConfig;
  readonly cache: MetadataCache | null;
}): boolean {
  return (
    input.envRaw !== "__none__" &&
    getMissingConfiguredDirectToolServers(input.config, input.cache, input.envDirectToolOverride)
      .length > 0
  );
}

export function buildHostInitOptions(input: {
  readonly programmaticConfig: boolean;
  readonly runtimeConfig: McpConfig;
  readonly configPath: string | undefined;
  readonly options: McpAdapterOptions;
  readonly oauthRuntime: McpOAuthRuntime;
  readonly statusEvents: ExtensionAPI["events"];
}): McpInitializationOptions {
  const { programmaticConfig, runtimeConfig, configPath, options, oauthRuntime, statusEvents } =
    input;
  return {
    ...(programmaticConfig ? { config: runtimeConfig } : { resolvedConfig: runtimeConfig }),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(options.outputDirectory !== undefined ? { outputDirectory: options.outputDirectory } : {}),
    oauthRuntime,
    statusEvents,
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
  };
}

export async function finalizeHostShutdown(input: {
  readonly events: ExtensionAPI["events"];
  readonly state: McpExtensionState | null;
  readonly owner: McpRuntimeOwner | null;
  readonly oauthRuntime: McpOAuthRuntime | null;
  readonly flush: ((state: McpExtensionState) => void) | undefined;
}): Promise<void> {
  const failures = await stopRuntimeSession({
    ...input,
    stateReason: "session_shutdown",
    ownerReason: "MCP extension session shutdown",
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "MCP session shutdown persistence/cleanup failed");
  }
}

/** Hooks passed into `reconcileSessionState` without creating a static import cycle. */
export interface ReconcileRetryHooks {
  readonly interruptedServers: ReadonlyMap<string, boolean>;
  readonly onReconcileInterrupted: (name: string, wasConnected: boolean) => void;
  readonly onSurfaceChanged: () => void;
}

/** Coordinates serialized live session reconciliation and interrupted-close retries. */
export class HostReconcileCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private pendingRetry = false;
  private readonly interruptedServers = new Map<string, boolean>();

  get retryPending(): boolean {
    return this.pendingRetry;
  }

  reset(): void {
    this.pendingRetry = false;
    this.interruptedServers.clear();
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {
      // Keep the reconcile queue alive after an individual reconciliation failure.
    });
    return next;
  }

  async execute(
    runReconcile: (hooks: ReconcileRetryHooks) => Promise<void>,
    onSurfaceChanged: () => void,
    isStillCurrent: () => boolean,
  ): Promise<void> {
    if (!isStillCurrent()) {
      return;
    }
    try {
      await runReconcile({
        interruptedServers: this.interruptedServers,
        onReconcileInterrupted: (name, wasConnected) => {
          const prior = this.interruptedServers.get(name) === true;
          this.interruptedServers.set(name, prior || wasConnected);
        },
        onSurfaceChanged: () => {
          this.pendingRetry = false;
          this.interruptedServers.clear();
          onSurfaceChanged();
        },
      });
    } catch (error) {
      if (isStillCurrent()) {
        this.pendingRetry = true;
      }
      throw error;
    }
  }
}

export async function stopStaleInitState(
  state: McpExtensionState,
  flush: ((state: McpExtensionState) => void) | undefined,
): Promise<void> {
  try {
    await new McpStateCleanup(state).stop("stale_session_start", flush);
  } catch (error) {
    console.error(`MCP: failed to clean stale initialization state: ${formatTerminalError(error)}`);
  }
}

export async function stopRejectedInitialization(
  owner: McpRuntimeOwner,
  oauthRuntime: McpOAuthRuntime,
): Promise<void> {
  try {
    await Promise.all([owner.stop("MCP initialization failed"), shutdownOAuth(oauthRuntime)]);
  } catch (cleanupError) {
    console.error(
      `MCP: failed to clean rejected initialization: ${formatTerminalError(cleanupError)}`,
    );
  }
}
