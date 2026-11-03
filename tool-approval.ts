import { abortable } from "./abort.ts";
import { combineAbortSignals, type McpRuntimeOwner } from "./runtime-owner.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getToolNameCandidates,
  matchesToolPattern,
  resolveToolPrefix,
  type McpConfig,
  type ToolMetadata,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

interface ToolApprovalState {
  owner: McpRuntimeOwner;
  config: McpConfig;
  approvedToolCalls: Map<string, true>;
  ui?: ExtensionContext["ui"];
}

export type ToolCallApprovalResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "approval_required_headless" };

export function isToolCallApprovalRequired(
  config: McpConfig,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName">,
): boolean {
  const definition = config.mcpServers[serverName];
  const approval =
    definition?.approveTools !== undefined
      ? definition.approveTools
      : config.settings?.approveTools;

  if (approval === true) {
    return true;
  }
  if (!Array.isArray(approval) || approval.length === 0) {
    return false;
  }

  const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix);
  return matchesToolPattern(
    getToolNameCandidates(toolMeta.originalName, serverName, prefix),
    approval,
  );
}

export async function ensureToolCallApproved(
  state: ToolApprovalState,
  {
    serverName,
    toolMeta,
    args,
    signal,
  }: {
    serverName: string;
    toolMeta: ToolMetadata;
    args: Record<string, unknown> | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<ToolCallApprovalResult> {
  if (!isToolCallApprovalRequired(state.config, serverName, toolMeta)) {
    return { ok: true };
  }

  const cacheKey = `${serverName}\u0000${toolMeta.originalName}`;
  if (state.approvedToolCalls.has(cacheKey)) {
    return { ok: true };
  }

  if (!state.ui) {
    return { ok: false, reason: "approval_required_headless" };
  }

  const json = JSON.stringify(args ?? {}, null, 2);
  const sanitized = sanitizeTerminalText(json);
  const preview = sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  const title = `MCP: ${sanitizeTerminalText(serverName)} wants to run ${sanitizeTerminalText(toolMeta.originalName)}`;
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  const decision = await abortable(
    state.ui.select(`${title}\n\nArguments:\n${preview}`, [
      "Allow once",
      "Allow for session",
      "Deny",
    ]),
    ownedSignal,
  );

  if (decision === "Allow once") {
    return { ok: true };
  }
  if (decision === "Allow for session") {
    state.approvedToolCalls.set(cacheKey, true);
    return { ok: true };
  }
  return { ok: false, reason: "denied" };
}
