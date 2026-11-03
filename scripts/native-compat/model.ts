import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";

export type FixtureModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export type FixtureCall = Pick<ToolCall, "name" | "arguments">;

export function fixtureProvider(url: string): ProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: url,
    apiKey: "synthetic",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
  };
}

export function fixtureStream(
  model: FixtureModel,
  call: FixtureCall | undefined,
  id: string,
): AssistantMessageEventStream {
  const reason = call === undefined ? "stop" : "toolUse";
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content:
      call === undefined ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id, ...call }],
    stopReason: reason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
    stream.end();
  });
  return stream;
}
