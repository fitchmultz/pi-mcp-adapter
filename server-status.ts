import type { ServerConnection } from "./server-connection.ts";
import {
  isServerDisabled,
  type McpPanelConnectionStatus,
  type McpServerRuntimeStatus,
  type ServerDefinition,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

/** Maximum backoff window for repeated lazy-connect failures. */
export const FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * Progressive backoff windows for repeated lazy-connect failures:
 * recovers from a transient first failure in 2s and converges to the existing 60s cap.
 */
export const FAILURE_BACKOFF_STEPS_MS = [2_000, 10_000, 30_000, FAILURE_BACKOFF_MS] as const;

// Keeps per-server status and server_backoff lines scannable in multi-server output; raw storage stays at 8 KiB.
const MAX_DIAGNOSTIC_SUMMARY_CHARS = 500;

export interface FailureBackoffEntry {
  consecutiveFailures: number;
  backoffMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const stateFailureBackoffs = new WeakMap<object, Map<string, FailureBackoffEntry>>();

export function getFailureBackoffMap(state: object): Map<string, FailureBackoffEntry> | undefined {
  return stateFailureBackoffs.get(state);
}

export function ensureFailureBackoffMap(
  state: object,
  onCreate: (entries: Map<string, FailureBackoffEntry>) => void,
): Map<string, FailureBackoffEntry> {
  let entries = stateFailureBackoffs.get(state);
  if (!entries) {
    entries = new Map();
    stateFailureBackoffs.set(state, entries);
    onCreate(entries);
  }
  return entries;
}

/** Shared bounded exponential backoff helper (doubles baseMs per failure up to maxMs). */
export function exponentialBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  const safeBase = Math.max(1, baseMs);
  return Math.min(safeBase * 2 ** Math.max(0, failures - 1), Math.max(safeBase, maxMs));
}

export function failureBackoffMs(consecutiveFailures: number): number {
  const index = Math.min(Math.max(0, consecutiveFailures - 1), FAILURE_BACKOFF_STEPS_MS.length - 1);
  return FAILURE_BACKOFF_STEPS_MS[index] ?? FAILURE_BACKOFF_MS;
}

export function serverFailureBackoffMs(state: object, serverName: string): number {
  return stateFailureBackoffs.get(state)?.get(serverName)?.backoffMs ?? FAILURE_BACKOFF_MS;
}

/** Sanitize and bound a failure message for status and backoff diagnostics. */
export function formatFailureSummary(
  message: string | null | undefined,
  maxChars = MAX_DIAGNOSTIC_SUMMARY_CHARS,
): string | null {
  if (message === null || message === undefined) {
    return null;
  }
  const clean = sanitizeTerminalText(message);
  if (clean.length === 0) {
    return null;
  }
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 3)}...` : clean;
}

/**
 * The one stage every status surface derives from.
 *
 * A connection record carries only the transport fact. Disabled configuration, catalog availability
 * and an active failure window live elsewhere, so each surface used to re-infer the same status from
 * those inputs with its own precedence and its own words. Each surface keeps its vocabulary below.
 */
export type ServerStage =
  | "disabled"
  | "connected"
  | "needs-auth"
  | "failed"
  | "cached"
  | "undiscovered";

export interface ServerStageInput {
  definition: ServerDefinition | undefined;
  transport: ServerConnection["status"] | undefined;
  failedAgoSeconds: number | null;
  /** Whether a discovered or cached catalog exists; false means never discovered. */
  catalogKnown: boolean;
}

/** Age of an active failure record, or null once the retry window has passed. */
export function failureAgeSeconds(
  failedAt: number | undefined,
  now: number,
  backoffMs = FAILURE_BACKOFF_MS,
): number | null {
  if (failedAt === undefined || failedAt === 0 || Number.isNaN(failedAt)) {
    return null;
  }
  const ageMs = now - failedAt;
  return ageMs >= backoffMs ? null : Math.max(0, Math.round(ageMs / 1000));
}

/** Remaining seconds in an active failure backoff window, or null once expired. */
export function failureRemainingSeconds(
  failedAt: number | undefined,
  now: number,
  backoffMs = FAILURE_BACKOFF_MS,
): number | null {
  if (failedAt === undefined || failedAt === 0 || Number.isNaN(failedAt)) {
    return null;
  }
  const remainingMs = failedAt + backoffMs - now;
  return remainingMs <= 0 ? null : Math.max(1, Math.ceil(remainingMs / 1000));
}

export function serverStage({
  definition,
  transport,
  failedAgoSeconds,
  catalogKnown,
}: ServerStageInput): ServerStage {
  if (isServerDisabled(definition)) {
    return "disabled";
  }
  if (transport === "connected") {
    return "connected";
  }
  if (transport === "needs-auth") {
    return "needs-auth";
  }
  if (failedAgoSeconds !== null) {
    return "failed";
  }
  return catalogKnown ? "cached" : "undiscovered";
}

/** Machine-readable `fitch-mcp-adapter/status/v1` snapshot vocabulary. */
export function runtimeStatus(stage: ServerStage): McpServerRuntimeStatus {
  return stage === "undiscovered" ? "not-connected" : stage;
}

/** Text reported by `mcp({ action: "status" })`. */
export function proxyStatusText(stage: ServerStage): string {
  return stage === "undiscovered" ? "not connected" : stage;
}

/** `/mcp` panel vocabulary; the panel shows its local reconnect as "connecting". */
export function panelStatus(stage: ServerStage): McpPanelConnectionStatus {
  return stage === "cached" || stage === "undiscovered" ? "idle" : stage;
}

export interface InspectionStatus {
  status: string;
  statusIcon: string;
  failed: boolean;
}

/** `/mcp status` notification line. */
export function inspectionStatus(
  stage: ServerStage,
  failedAgoSeconds: number | null,
  failureMessage: string | null,
): InspectionStatus {
  switch (stage) {
    case "disabled":
      return { status: "disabled", statusIcon: "⊘", failed: false };
    case "connected":
      return { status: "connected", statusIcon: "✓", failed: false };
    case "needs-auth":
      return { status: "needs auth", statusIcon: "⚠", failed: false };
    case "cached":
      return { status: "cached", statusIcon: "○", failed: false };
    case "undiscovered":
      return { status: "not connected", statusIcon: "○", failed: false };
    case "failed": {
      const reason = sanitizeTerminalText(failureMessage ?? "");
      return {
        status:
          reason.length > 0
            ? `failed ${failedAgoSeconds ?? 0}s ago — ${reason}`
            : `failed ${failedAgoSeconds ?? 0}s ago`,
        statusIcon: "✗",
        failed: true,
      };
    }
  }
}
