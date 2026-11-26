import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type PromptMetadata } from "./types.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { logger } from "./logger.ts";
import {
  findUnquotedEquals,
  parsePromptTokens,
  splitActiveArgument,
  unquotePartial,
} from "./prompt-args.ts";

interface CompletionTarget {
  name: string;
  value: string;
  replacementPrefix: string;
  isNamed: boolean;
  contextArgs: Record<string, string>;
}

/**
 * Create a slash-command argument completer backed by MCP `completion/complete`.
 * Cancels superseded in-flight requests and degrades cleanly to `null` when
 * disconnected, unsupported, timed out, or errored.
 */
export function createPromptArgumentCompleter(
  getState: () => McpExtensionState | null,
  metadata: PromptMetadata,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
  let activeController: AbortController | undefined;

  return async (argumentPrefix: string): Promise<AutocompleteItem[] | null> => {
    activeController?.abort();
    activeController = undefined;

    const state = getState();
    const live = resolveCompletablePrompt(state, metadata);
    const target = live ? resolveCompletionTarget(live, argumentPrefix) : null;
    if (!state || !live || !target) {
      return null;
    }

    const controller = new AbortController();
    activeController = controller;
    try {
      return await fetchCompletionItems(state, { live, target, controller });
    } finally {
      if (activeController === controller) {
        activeController = undefined;
      }
    }
  };
}

async function fetchCompletionItems(
  state: McpExtensionState,
  input: {
    live: PromptMetadata;
    target: CompletionTarget;
    controller: AbortController;
  },
): Promise<AutocompleteItem[] | null> {
  const { live, target, controller } = input;
  const signal = combineAbortSignals(state.owner.signal, controller.signal);
  try {
    const result = await state.manager.complete(
      live.serverName,
      {
        ref: { type: "ref/prompt", name: live.originalName },
        argument: { name: target.name, value: target.value },
        ...(Object.keys(target.contextArgs).length > 0
          ? { context: { arguments: target.contextArgs } }
          : {}),
      },
      signal,
    );
    if (controller.signal.aborted || result.completion.values.length === 0) {
      return null;
    }
    return result.completion.values.map((candidate) => ({
      value: `${target.replacementPrefix}${formatCompletedToken(candidate, target.isNamed)}`,
      label: candidate,
    }));
  } catch (error) {
    if (!controller.signal.aborted && !isAbortError(error, signal)) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        `MCP: completion/complete failed for ${live.serverName}/${live.originalName}: ${message}`,
      );
    }
    return null;
  }
}

function supportsLiveCompletions(state: McpExtensionState, serverName: string): boolean {
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) {
    return false;
  }
  const connection = state.manager.getConnection(serverName);
  return (
    connection?.status === "connected" &&
    Boolean(connection.client.getServerCapabilities()?.completions)
  );
}

function resolveCompletablePrompt(
  state: McpExtensionState | null,
  metadata: PromptMetadata,
): PromptMetadata | undefined {
  if (!state || !supportsLiveCompletions(state, metadata.serverName)) {
    return undefined;
  }
  const live = state.promptMetadata
    .get(metadata.serverName)
    ?.find((prompt) => prompt.originalName === metadata.originalName);
  if (state.promptMetadataLive.has(metadata.serverName) && !live) {
    return undefined;
  }
  return live ?? metadata;
}

export function resolveCompletionTarget(
  metadata: PromptMetadata,
  argumentPrefix: string,
): CompletionTarget | null {
  const { priorTokens, prefixBeforeActive, activeToken } = splitActiveArgument(argumentPrefix);
  const contextArgs = resolvePriorContextArgs(metadata, priorTokens);
  const eq = findUnquotedEquals(activeToken);
  if (eq > 0) {
    const name = activeToken.slice(0, eq).trim();
    if (name === "") {
      return null;
    }
    return {
      name,
      value: unquotePartial(activeToken.slice(eq + 1)),
      replacementPrefix: `${prefixBeforeActive}${activeToken.slice(0, eq + 1)}`,
      isNamed: true,
      contextArgs,
    };
  }
  const nextDeclared = metadata.arguments.find((arg) => !(arg.name in contextArgs));
  if (!nextDeclared) {
    return null;
  }
  return {
    name: nextDeclared.name,
    value: unquotePartial(activeToken),
    replacementPrefix: prefixBeforeActive,
    isNamed: false,
    contextArgs,
  };
}

function resolvePriorContextArgs(
  metadata: PromptMetadata,
  priorTokens: readonly string[],
): Record<string, string> {
  const parsed = parsePromptTokens(priorTokens);
  const resolved: Record<string, string> = {};
  let positionalIndex = 0;
  for (const argDef of metadata.arguments) {
    const value = parsed.named[argDef.name] ?? parsed.positional[positionalIndex++];
    if (value !== undefined && value !== "") {
      resolved[argDef.name] = value;
    }
  }
  for (const [key, value] of Object.entries(parsed.named)) {
    if (!(key in resolved) && value !== "") {
      resolved[key] = value;
    }
  }
  return resolved;
}

function formatCompletedToken(value: string, isNamed: boolean): string {
  const needsQuotes =
    value === "" ||
    /\s/.test(value) ||
    value.includes("\\") ||
    value.includes('"') ||
    value.includes("'") ||
    (!isNamed && value.includes("="));
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
