import type { ServerConnection } from "./server-connection.ts";
import {
  isServerDisabled,
  type McpPanelConnectionStatus,
  type McpServerRuntimeStatus,
  type ServerDefinition,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

/** How long a recorded failure keeps a server out of retry. */
export const FAILURE_BACKOFF_MS = 60 * 1000;

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
export function failureAgeSeconds(failedAt: number | undefined, now: number): number | null {
  if (failedAt === undefined || failedAt === 0 || Number.isNaN(failedAt)) {
    return null;
  }
  const ageMs = now - failedAt;
  return ageMs > FAILURE_BACKOFF_MS ? null : Math.round(ageMs / 1000);
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
