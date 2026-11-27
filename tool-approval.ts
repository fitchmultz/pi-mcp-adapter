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
  ui?: Pick<ExtensionContext["ui"], "select">;
}

const pendingApprovalChains = new WeakMap<Map<string, true>, Map<string, Promise<void>>>();

function getApprovalChains(state: ToolApprovalState): Map<string, Promise<void>> {
  let chains = pendingApprovalChains.get(state.approvedToolCalls);
  if (!chains) {
    chains = new Map();
    pendingApprovalChains.set(state.approvedToolCalls, chains);
  }
  return chains;
}

async function runSerializedApproval(
  state: ToolApprovalState,
  cacheKey: string,
  ownedSignal: AbortSignal | undefined,
  task: () => Promise<ToolCallApprovalResult>,
): Promise<ToolCallApprovalResult> {
  const chains = getApprovalChains(state);
  const previous = chains.get(cacheKey);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nextChain = (previous ?? Promise.resolve()).then(
    () => gate,
    () => gate,
  );
  chains.set(cacheKey, nextChain);
  const releaseChain = () => {
    if (chains.get(cacheKey) === nextChain) {
      chains.delete(cacheKey);
    }
  };
  void nextChain.then(releaseChain, releaseChain);
  try {
    if (previous) {
      await abortable(previous, ownedSignal);
    }
    return await task();
  } finally {
    release?.();
  }
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

function approvalPreviewArgs(
  toolMeta: Pick<ToolMetadata, "resourceUri">,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (
    toolMeta.resourceUri !== undefined &&
    toolMeta.resourceUri !== "" &&
    Object.keys(args ?? {}).length === 0
  ) {
    return { uri: toolMeta.resourceUri };
  }
  return args ?? {};
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

  const cacheKey =
    toolMeta.resourceUri !== undefined && toolMeta.resourceUri !== ""
      ? `${serverName}\u0000${toolMeta.originalName}\u0000${toolMeta.resourceUri}`
      : `${serverName}\u0000${toolMeta.originalName}`;
  if (state.approvedToolCalls.has(cacheKey)) {
    return { ok: true };
  }

  if (!state.ui) {
    return { ok: false, reason: "approval_required_headless" };
  }

  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  return await runSerializedApproval(state, cacheKey, ownedSignal, async () => {
    if (state.approvedToolCalls.has(cacheKey)) {
      return { ok: true };
    }
    return await promptToolApproval({ state, serverName, toolMeta, args, cacheKey, ownedSignal });
  });
}

async function promptToolApproval(input: {
  state: ToolApprovalState;
  serverName: string;
  toolMeta: ToolMetadata;
  args: Record<string, unknown> | undefined;
  cacheKey: string;
  ownedSignal: AbortSignal | undefined;
}): Promise<ToolCallApprovalResult> {
  const { state, serverName, toolMeta, args, cacheKey, ownedSignal } = input;
  if (!state.ui) {
    return { ok: false, reason: "approval_required_headless" };
  }
  const json = JSON.stringify(approvalPreviewArgs(toolMeta, args), null, 2);
  const sanitized = sanitizeTerminalText(json);
  const preview = sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  const title = `MCP: ${sanitizeTerminalText(serverName)} wants to run ${sanitizeTerminalText(toolMeta.originalName)}`;
  const decision = await abortable(
    state.ui.select(
      `${title}\n\nArguments:\n${preview}`,
      ["Allow once", "Allow for session", "Deny"],
      ownedSignal ? { signal: ownedSignal } : {},
    ),
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
