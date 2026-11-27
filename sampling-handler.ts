import type { Api, AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { truncateAtWord } from "./utils.ts";
import { throwIfAborted } from "./abort.ts";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  ProtocolError,
  ProtocolErrorCode,
  type Client,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ModelPreferences,
  type SamplingMessage,
  type SamplingMessageContentBlock,
} from "@modelcontextprotocol/client";

export interface SamplingHandlerOptions {
  serverName: string;
  autoApprove: boolean;
  ui?: Pick<ExtensionUIContext, "confirm">;
  modelRegistry: ModelRegistry;
  getCurrentModel: () => Model<Api> | undefined;
  getSignal: () => AbortSignal | undefined;
}

export type ServerSamplingConfig = Omit<SamplingHandlerOptions, "serverName">;

export function registerSamplingHandler(
  client: Client,
  options: SamplingHandlerOptions,
  own: (run: () => Promise<CreateMessageResult>) => Promise<CreateMessageResult> = (run) => run(),
): void {
  // Own the handler's real promise, not the SDK caller's cancellable response facade.
  client.setRequestHandler("sampling/createMessage", (request) =>
    own(() => handleSamplingRequest(options, request)),
  );
}

export async function handleSamplingRequest(
  options: SamplingHandlerOptions,
  request: CreateMessageRequest,
): Promise<CreateMessageResult> {
  const params = request.params;
  const signal = options.getSignal();
  throwIfAborted(signal);

  validateSamplingFeatures(params);

  const messages = params.messages.map(convertSamplingMessage);
  const model = await resolveSamplingModel(options, params.modelPreferences);
  throwIfAborted(signal);
  await confirmSampling(
    options,
    "Approve MCP sampling request",
    formatRequestApproval(
      options.serverName,
      `${model.provider}/${model.id}`,
      params.systemPrompt,
      messages,
    ),
  );
  throwIfAborted(signal);

  const result = await options.modelRegistry.complete(
    model,
    {
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      messages,
    },
    samplingCompletionOptions(model, params, signal),
  );

  const converted = convertAssistantResult(result);
  throwIfAborted(signal);
  await confirmSampling(
    options,
    "Return MCP sampling response",
    formatResponseApproval(options.serverName, converted),
  );
  return converted;
}

function validateSamplingFeatures(params: CreateMessageRequest["params"]): void {
  if ("task" in params && params.task) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "MCP sampling tasks are not supported",
    );
  }
  if (params.includeContext !== undefined && params.includeContext !== "none") {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "MCP sampling context inclusion is not supported",
    );
  }
  if (params.tools && params.tools.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "MCP sampling tool use is not supported",
    );
  }
  if (params.toolChoice) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "MCP sampling tool choice is not supported",
    );
  }
  if (params.stopSequences && params.stopSequences.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "MCP sampling stop sequences are not supported",
    );
  }
}

/** OpenAI models that reject `temperature` on Responses APIs when `compat.supportsTemperature` is unset. */
const TEMPERATURE_REJECTING_MODEL_IDS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
]);

function modelSupportsTemperature(model: Model<Api>): boolean {
  if (
    model.compat &&
    "supportsTemperature" in model.compat &&
    model.compat.supportsTemperature !== undefined
  ) {
    return model.compat.supportsTemperature;
  }
  return !(
    TEMPERATURE_REJECTING_MODEL_IDS.has(model.id) &&
    (model.api === "openai-responses" ||
      model.api === "azure-openai-responses" ||
      model.api === "openai-codex-responses")
  );
}

function samplingCompletionOptions(
  model: Model<Api>,
  params: CreateMessageRequest["params"],
  signal: AbortSignal | undefined,
): NonNullable<Parameters<ModelRegistry["complete"]>[2]> {
  const supportsTemperature = modelSupportsTemperature(model);
  return {
    maxTokens: params.maxTokens,
    ...(supportsTemperature && params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    ...(signal ? { signal } : {}),
  };
}

function formatRequestApproval(
  serverName: string,
  modelName: string,
  systemPrompt: string | undefined,
  messages: Message[],
): string {
  const lines = [
    `${serverName} wants to sample ${messages.length} message${messages.length === 1 ? "" : "s"} with ${modelName}.`,
  ];
  if (systemPrompt !== undefined && systemPrompt !== "") {
    lines.push(`System: ${truncateAtWord(systemPrompt, 400)}`);
  }
  for (const [index, message] of messages.entries()) {
    lines.push(`${index + 1}. ${message.role}: ${truncateAtWord(messageText(message), 400)}`);
  }
  return lines.join("\n\n");
}

function formatResponseApproval(serverName: string, response: CreateMessageResult): string {
  const text =
    response.content.type === "text" ? response.content.text : `[${response.content.type} content]`;
  return `${serverName} will receive this response from ${response.model}:\n\n${truncateAtWord(text, 1000)}`;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "image") {
        return `[image: ${block.mimeType}]`;
      }
      if (block.type === "thinking") {
        return "[thinking]";
      }
      return `[tool call: ${block.name}]`;
    })
    .join("\n");
}

interface PreferenceBounds {
  readonly minCost: number;
  readonly span: number;
  readonly maxContext: number;
}

function normalizePriority(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function hasActivePriorities(preferences: ModelPreferences | undefined): boolean {
  return (
    normalizePriority(preferences?.costPriority) > 0 ||
    normalizePriority(preferences?.speedPriority) > 0 ||
    normalizePriority(preferences?.intelligencePriority) > 0
  );
}

function modelTotalCost(model: Model<Api>): number {
  const input = Number.isFinite(model.cost.input) ? Math.max(0, model.cost.input) : 0;
  const output = Number.isFinite(model.cost.output) ? Math.max(0, model.cost.output) : 0;
  return input + output;
}

function computePreferenceBounds(models: readonly Model<Api>[]): PreferenceBounds {
  let minCost = Number.POSITIVE_INFINITY;
  let maxCost = 0;
  let maxContext = 1;
  for (const model of models) {
    const cost = modelTotalCost(model);
    if (cost < minCost) {
      minCost = cost;
    }
    if (cost > maxCost) {
      maxCost = cost;
    }
    if (Number.isFinite(model.contextWindow) && model.contextWindow > maxContext) {
      maxContext = model.contextWindow;
    }
  }
  if (!Number.isFinite(minCost)) {
    minCost = 0;
  }
  return { minCost, span: Math.max(0, maxCost - minCost), maxContext };
}

function scoreSamplingModel(input: {
  model: Model<Api>;
  preferences: ModelPreferences;
  bounds: PreferenceBounds;
}): number {
  const { model, preferences, bounds } = input;
  const costPriority = normalizePriority(preferences.costPriority);
  const speedPriority = normalizePriority(preferences.speedPriority);
  const intelligencePriority = normalizePriority(preferences.intelligencePriority);
  const costNorm = bounds.span > 0 ? 1 - (modelTotalCost(model) - bounds.minCost) / bounds.span : 1;
  const speedNorm = (model.reasoning ? 0 : 0.5) + 0.5 * costNorm;
  const ctxNorm = Number.isFinite(model.contextWindow)
    ? Math.max(0, model.contextWindow) / bounds.maxContext
    : 0;
  const intelligenceNorm = (model.reasoning ? 0.5 : 0) + 0.25 * ctxNorm + 0.25 * (1 - costNorm);
  return (
    costPriority * costNorm + speedPriority * speedNorm + intelligencePriority * intelligenceNorm
  );
}

function sortByModelPreferences(
  models: readonly Model<Api>[],
  preferences: ModelPreferences | undefined,
  bounds: PreferenceBounds,
): Model<Api>[] {
  const ordered = [...models];
  if (!preferences || !hasActivePriorities(preferences)) {
    return ordered;
  }
  return ordered.sort(
    (left, right) =>
      scoreSamplingModel({ model: right, preferences, bounds }) -
      scoreSamplingModel({ model: left, preferences, bounds }),
  );
}

function matchesSamplingHint(model: Model<Api>, normalizedHint: string): boolean {
  const searchableNames = [`${model.provider}/${model.id}`, model.id, model.name];
  return searchableNames.some((name) => name.toLowerCase().includes(normalizedHint));
}

function samplingCandidates(
  options: SamplingHandlerOptions,
  modelPreferences: ModelPreferences | undefined,
): Model<Api>[] {
  const candidates: Model<Api>[] = [];
  const availableModels = options.modelRegistry.getAvailable();
  const currentModel = options.getCurrentModel();
  const basePool = currentModel ? [currentModel, ...availableModels] : [...availableModels];
  const bounds = computePreferenceBounds(basePool);

  for (const hint of modelPreferences?.hints ?? []) {
    const normalizedHint = (hint.name ?? "").trim().toLowerCase();
    if (normalizedHint === "") {
      continue;
    }
    const hintMatches = availableModels.filter((model) =>
      matchesSamplingHint(model, normalizedHint),
    );
    for (const model of sortByModelPreferences(hintMatches, modelPreferences, bounds)) {
      addSamplingCandidate(candidates, model);
    }
  }

  for (const model of sortByModelPreferences(basePool, modelPreferences, bounds)) {
    addSamplingCandidate(candidates, model);
  }

  return candidates;
}

async function resolveSamplingModel(
  options: SamplingHandlerOptions,
  modelPreferences: ModelPreferences | undefined,
): Promise<Model<Api>> {
  const candidates = samplingCandidates(options, modelPreferences);
  const errors: string[] = [];
  const signal = options.getSignal();
  for (const model of candidates) {
    throwIfAborted(signal);
    const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
    throwIfAborted(signal);
    if (!auth.ok) {
      errors.push(`${model.provider}/${model.id}: ${auth.error}`);
      continue;
    }
    return model;
  }

  if (errors.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `No configured auth for MCP sampling model. ${errors.join("; ")}`,
    );
  }
  throw new ProtocolError(
    ProtocolErrorCode.InternalError,
    "No Pi model is available for MCP sampling",
  );
}

function addSamplingCandidate(candidates: Model<Api>[], model: Model<Api>): void {
  if (
    !candidates.some(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    )
  ) {
    candidates.push(model);
  }
}

async function confirmSampling(
  options: SamplingHandlerOptions,
  title: string,
  message: string,
): Promise<void> {
  if (options.autoApprove) {
    return;
  }
  if (!options.ui) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      "MCP sampling requires interactive approval. Set settings.samplingAutoApprove to true to allow it without UI.",
    );
  }
  const signal = options.getSignal();
  const approved = await options.ui.confirm(title, message, signal ? { signal } : undefined);
  throwIfAborted(signal);
  if (!approved) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "MCP sampling request was declined");
  }
}

function convertSamplingMessage(message: SamplingMessage): Message {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  if (message.role === "user") {
    return {
      role: "user",
      content: blocks.map(convertUserContent),
      timestamp: Date.now(),
    };
  }

  return {
    role: "assistant",
    content: blocks.map(convertAssistantContent),
    api: "mcp-sampling",
    provider: "mcp",
    model: "sampling-request",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function convertUserContent(block: SamplingMessageContentBlock): TextContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `MCP sampling ${block.type} content is not supported`,
  );
}

function convertAssistantContent(block: SamplingMessageContentBlock): TextContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `MCP sampling assistant ${block.type} content is not supported`,
  );
}

function convertAssistantResult(message: AssistantMessage): CreateMessageResult {
  if (message.stopReason === "error") {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      message.errorMessage ?? "MCP sampling model call failed",
    );
  }
  if (message.stopReason === "aborted") {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      message.errorMessage ?? "MCP sampling model call was aborted",
    );
  }

  const text = message.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "thinking") {
        return;
      }
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `MCP sampling result ${block.type} content is not supported`,
      );
    })
    .filter((value): value is string => value !== undefined)
    .join("\n\n")
    .trim();

  if (text === "") {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "MCP sampling result did not contain text content",
    );
  }

  return {
    role: "assistant",
    content: { type: "text", text },
    model: `${message.provider}/${message.model}`,
    stopReason: mapStopReason(message.stopReason),
  };
}

function mapStopReason(reason: AssistantMessage["stopReason"]): CreateMessageResult["stopReason"] {
  if (reason === "stop") {
    return "endTurn";
  }
  if (reason === "length") {
    return "maxTokens";
  }
  if (reason === "toolUse") {
    return "toolUse";
  }
  return reason;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
