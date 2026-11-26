import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GetPromptResult } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import { isServerDisabled, type PromptMetadata } from "./types.ts";
import { prepareMcpConnection } from "./proxy-connection.ts";
import { getAuthRequiredMessage } from "./proxy-auth.ts";
import type { ProxyToolResult } from "./proxy-result.ts";
import { paginate } from "./search-ranking.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  resolveMcpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import { formatPromptContent } from "./prompt-content.ts";

interface PromptDescriptor {
  server: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{
    name: string;
    description?: string;
    required: boolean;
  }>;
}

export async function fetchPromptWithRecovery(
  state: McpExtensionState,
  request: {
    serverName: string;
    promptName: string;
    args?: Record<string, string> | undefined;
    signal?: AbortSignal | undefined;
    recoverAuthConnection?: SessionRecoveryDeps["onNeedsAuth"] | undefined;
  },
): Promise<GetPromptResult> {
  const { withSessionRecovery } = await import("./session-recovery.ts");
  const { serverName, promptName, args, signal, recoverAuthConnection } = request;
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const promptArgs = args && Object.keys(args).length > 0 ? args : undefined;
  const recovery: SessionRecoveryDeps = {
    manager: state.manager,
    config: state.config,
    ...(ownedSignal ? { signal: ownedSignal } : {}),
    ...(recoverAuthConnection ? { onNeedsAuth: recoverAuthConnection } : {}),
  };
  return withSessionRecovery(recovery, serverName, (connection) => {
    const call =
      state.manager.getConnection(serverName) === connection
        ? state.manager.getPrompt(serverName, promptName, promptArgs, signal)
        : connection.client.getPrompt(
            { name: promptName, ...(promptArgs ? { arguments: promptArgs } : {}) },
            state.manager.getRequestOptions(serverName, signal),
          );
    return ownedSignal ? abortable(call, ownedSignal) : call;
  });
}

export async function executePromptList(
  state: McpExtensionState,
  {
    server,
    limit = 12,
    offset = 0,
    signal,
  }: {
    server?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<AgentToolResult<Record<string, unknown>>> {
  throwIfAborted(combineAbortSignals(state.owner.signal, signal));
  if (server !== undefined && server.length > 0) {
    return executeServerPromptList(state, { server, limit, offset, signal });
  }
  const descriptors = collectAllPrompts(state);
  const page = paginate(descriptors, offset, limit);
  const coverage = promptCatalogCoverage(state);
  const payload = { ...page, coverage };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: { mode: "prompts", ...payload },
  };
}

async function executeServerPromptList(
  state: McpExtensionState,
  {
    server,
    limit,
    offset,
    signal,
  }: {
    server: string;
    limit: number;
    offset: number;
    signal: AbortSignal | undefined;
  },
): Promise<AgentToolResult<Record<string, unknown>>> {
  const definition = state.config.mcpServers[server];
  if (!definition || isServerDisabled(definition)) {
    return unavailablePromptResult("prompts", server, definition !== undefined);
  }
  const prepared = await prepareMcpConnection(state, server, signal);
  if (prepared.error) {
    return { ...prepared.error, details: { ...prepared.error.details, mode: "prompts" } };
  }
  const descriptors = (state.promptMetadata.get(server) ?? [])
    .map(toPromptDescriptor)
    .sort((a, b) => a.name.localeCompare(b.name));
  const page = paginate(descriptors, offset, limit);
  const failed = prepared.connection.promptDiscoveryFailed === true;
  const payload = {
    server,
    ...page,
    ...(failed ? { promptDiscoveryFailed: true } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: { mode: "prompts", ...payload },
  };
}

export async function executeGetPrompt(
  state: McpExtensionState,
  {
    server,
    prompt,
    args,
    signal,
  }: {
    server: string;
    prompt: string;
    args?: Record<string, unknown> | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[server];
  if (!definition || isServerDisabled(definition)) {
    return unavailablePromptResult("get-prompt", server, definition !== undefined, prompt);
  }
  const parsedArgs = parseGatewayPromptArgs(args, server, prompt);
  if (!parsedArgs.ok) {
    return parsedArgs.error;
  }
  const prepared = await prepareMcpConnection(state, server, ownedSignal);
  if (prepared.error) {
    return {
      ...prepared.error,
      details: { ...prepared.error.details, mode: "get-prompt", server, prompt },
    };
  }
  const missing = findMissingPromptArgs(state, server, prompt, parsedArgs.args);
  if (missing.length > 0) {
    return missingPromptArgsResult(server, prompt, missing);
  }
  return dispatchGetPrompt(state, {
    server,
    prompt,
    args: parsedArgs.args,
    signal,
    ownedSignal,
    prepared,
  });
}

async function dispatchGetPrompt(
  state: McpExtensionState,
  input: {
    server: string;
    prompt: string;
    args: Record<string, string>;
    signal: AbortSignal | undefined;
    ownedSignal: AbortSignal | undefined;
    prepared: Extract<Awaited<ReturnType<typeof prepareMcpConnection>>, { connection: unknown }>;
  },
): Promise<ProxyToolResult> {
  const { server, prompt, args, signal, ownedSignal, prepared } = input;
  const { SessionRecoveryAuthRequiredError } = await import("./session-recovery.ts");
  try {
    const result = await fetchPromptWithRecovery(state, {
      serverName: server,
      promptName: prompt,
      args,
      signal,
      recoverAuthConnection: prepared.recoverAuthConnection,
    });
    const guarded = await guardMcpOutput(formatPromptContent(result), {
      ...resolveMcpOutputGuardOptions(state.config.settings, state.outputDirectory),
      emptyTextFallback: "(empty prompt)",
    });
    return {
      content: guarded.content,
      details: {
        mode: "get-prompt",
        server,
        prompt,
        ...(result.description !== undefined ? { description: result.description } : {}),
        messageCount: result.messages.length,
        ...guardedMcpDetails(guarded),
      },
    };
  } catch (error) {
    if (error instanceof SessionRecoveryAuthRequiredError) {
      const message = error.authMessage ?? getAuthRequiredMessage(state, server);
      return {
        content: [{ type: "text", text: message }],
        details: {
          mode: "get-prompt",
          server,
          prompt,
          error: "auth_required",
          autoAuthAttempted: prepared.autoAuthAttempted(),
          message,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Failed to get prompt "${prompt}": ${message}` }],
      isError: true,
      details: {
        mode: "get-prompt",
        server,
        prompt,
        error: isAbortError(error, ownedSignal) ? "aborted" : "prompt_failed",
        message,
      },
    };
  }
}

function parseGatewayPromptArgs(
  args: Record<string, unknown> | undefined,
  server: string,
  prompt: string,
): { ok: true; args: Record<string, string> } | { ok: false; error: ProxyToolResult } {
  const result: Record<string, string> = {};
  if (!args) {
    return { ok: true, args: result };
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      return {
        ok: false,
        error: {
          content: [
            {
              type: "text",
              text: `Prompt argument "${key}" must be a string.`,
            },
          ],
          details: {
            mode: "get-prompt",
            server,
            prompt,
            error: "invalid_arguments",
          },
        },
      };
    }
    result[key] = value;
  }
  return { ok: true, args: result };
}

function findMissingPromptArgs(
  state: McpExtensionState,
  server: string,
  prompt: string,
  args: Record<string, string>,
): string[] {
  const metadata = state.promptMetadata
    .get(server)
    ?.find((candidate) => candidate.originalName === prompt);
  if (!metadata) {
    return [];
  }
  return metadata.arguments
    .filter(
      (arg) => arg.required === true && (args[arg.name] === undefined || args[arg.name] === ""),
    )
    .map((arg) => arg.name);
}

function missingPromptArgsResult(
  server: string,
  prompt: string,
  missing: string[],
): ProxyToolResult {
  const list = missing.join(", ");
  return {
    content: [
      {
        type: "text",
        text: `Missing required prompt argument${missing.length > 1 ? "s" : ""} for "${prompt}" on "${server}": ${list}.`,
      },
    ],
    details: {
      mode: "get-prompt",
      server,
      prompt,
      error: "missing_arguments",
      missingArguments: missing,
    },
  };
}

function unavailablePromptResult(
  mode: "prompts" | "get-prompt",
  server: string,
  configured: boolean,
  prompt?: string,
): ProxyToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Server "${server}" is ${configured ? "disabled" : "not configured"}.`,
      },
    ],
    details: {
      mode,
      server,
      ...(prompt !== undefined ? { prompt } : {}),
      error: configured ? "server_disabled" : "server_not_found",
    },
  };
}

function collectAllPrompts(state: McpExtensionState): PromptDescriptor[] {
  const enabledServers = Object.entries(state.config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const descriptors: PromptDescriptor[] = [];
  for (const serverName of enabledServers) {
    const prompts = [...(state.promptMetadata.get(serverName) ?? [])].sort((a, b) =>
      a.originalName.localeCompare(b.originalName),
    );
    descriptors.push(...prompts.map(toPromptDescriptor));
  }
  return descriptors;
}

function promptCatalogCoverage(state: McpExtensionState): {
  complete: boolean;
  knownServers: string[];
  unknownServers: string[];
} {
  const enabled = Object.keys(state.config.mcpServers).filter(
    (name) => !isServerDisabled(state.config.mcpServers[name]),
  );
  const isKnown = (name: string) =>
    state.promptMetadataLive.has(name) ||
    state.promptMetadata.has(name) ||
    state.toolMetadata.has(name);
  const knownServers = enabled.filter(isKnown);
  const unknownServers = enabled.filter((name) => !isKnown(name));
  return { complete: unknownServers.length === 0, knownServers, unknownServers };
}

function toPromptDescriptor(prompt: PromptMetadata): PromptDescriptor {
  return {
    server: prompt.serverName,
    name: prompt.originalName,
    ...(prompt.title !== undefined && prompt.title !== "" ? { title: prompt.title } : {}),
    ...(prompt.description !== "" ? { description: prompt.description } : {}),
    arguments: prompt.arguments.map((arg) => ({
      name: arg.name,
      ...(arg.description !== undefined ? { description: arg.description } : {}),
      required: arg.required === true,
    })),
  };
}
