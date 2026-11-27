import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Client, InMemoryTransport, ProtocolErrorCode } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  handleSamplingRequest as HandleSamplingRequest,
  SamplingHandlerOptions,
} from "../../sampling-handler.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";

type SamplingRequest = Parameters<typeof HandleSamplingRequest>[1];
type SamplingPreferences = NonNullable<SamplingRequest["params"]["modelPreferences"]>;

const mocks = {
  complete: vi.fn<SamplingHandlerOptions["modelRegistry"]["complete"]>(),
};
let native: Awaited<ReturnType<typeof createTestExtensionContext>>;

const baseCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const cheapFastModel = {
  provider: "anthropic",
  id: "claude-haiku-fast",
  api: "anthropic-messages",
  name: "Claude Haiku Fast",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  reasoning: false,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

const smartReasoningModel = {
  ...cheapFastModel,
  id: "claude-opus-smart",
  name: "Claude Opus Smart",
  reasoning: true,
  cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 16384,
} satisfies Model<"anthropic-messages">;

const midModel = {
  ...cheapFastModel,
  id: "claude-sonnet-mid",
  name: "Claude Sonnet Mid",
  reasoning: false,
  cost: baseCost,
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"anthropic-messages">;

function makeOptions(available: Model<Api>[], current?: Model<Api>): SamplingHandlerOptions {
  const modelRegistry = native.context.modelRegistry;
  vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(available);
  vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
    ok: true,
    apiKey: "test-key",
  });
  return {
    serverName: "prefs-test",
    autoApprove: true,
    modelRegistry,
    getCurrentModel: () => current,
    getSignal: () => native.context.signal,
  };
}

function samplingRequest(overrides: Partial<SamplingRequest["params"]> = {}): SamplingRequest {
  return {
    method: "sampling/createMessage",
    params: {
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      maxTokens: 32,
      ...overrides,
    },
  };
}

async function expectModelForPreferences(
  models: Model<Api>[],
  modelPreferences: SamplingPreferences,
  current?: Model<Api>,
) {
  const { handleSamplingRequest } = await import("../../sampling-handler.ts");
  await handleSamplingRequest(makeOptions(models, current), samplingRequest({ modelPreferences }));
  return requireValue(mocks.complete.mock.calls.at(-1))[0];
}

describe("MCP sampling preferences and ProtocolError boundaries", () => {
  beforeEach(async () => {
    native = await createTestExtensionContext();
    vi.spyOn(native.context.modelRegistry, "complete").mockImplementation(mocks.complete);
    mocks.complete.mockReset().mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-mid",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await native.dispose();
  });

  it("scores candidate models by costPriority, speedPriority, and intelligencePriority", async () => {
    const pool = [midModel, smartReasoningModel, cheapFastModel];

    expect(await expectModelForPreferences(pool, { costPriority: 1 }, smartReasoningModel)).toBe(
      cheapFastModel,
    );
    expect(await expectModelForPreferences(pool, { speedPriority: 1 }, smartReasoningModel)).toBe(
      cheapFastModel,
    );
    expect(await expectModelForPreferences(pool, { intelligencePriority: 1 }, cheapFastModel)).toBe(
      smartReasoningModel,
    );
  });

  it("orders hinted matches using modelPreferences priorities before unhinted models", async () => {
    const pool = [smartReasoningModel, cheapFastModel, midModel];
    const selected = await expectModelForPreferences(pool, {
      hints: [{ name: "claude" }],
      intelligencePriority: 1,
    });
    expect(selected).toBe(smartReasoningModel);
  });

  it("throws ProtocolError with standard JSON-RPC codes over a real MCP server wire", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");
    const server = new McpServer(
      { name: "sampling-wire", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.registerTool("sample_tools", { inputSchema: z.object({}) }, async (_args, ctx) => {
      try {
        await ctx.mcpReq.send({
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: "hi" } }],
            maxTokens: 16,
            tools: [{ name: "unused", inputSchema: { type: "object", properties: {} } }],
          },
        });
        return { content: [{ type: "text" as const, text: "unexpected" }] };
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "code" in error ? error.code : null;
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }] };
      }
    });

    const client = new Client(
      { name: "sampling-client", version: "1.0.0" },
      { capabilities: { sampling: {} } },
    );
    client.setRequestHandler("sampling/createMessage", (req) =>
      handleSamplingRequest(makeOptions([midModel], midModel), req),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const outcome = await client.callTool({ name: "sample_tools", arguments: {} });
      const text = outcome.content.find((item) => item.type === "text")?.text ?? "{}";
      const parsed = z
        .object({ code: z.number().nullable(), message: z.string() })
        .parse(JSON.parse(text));
      expect(parsed.code).toBe(ProtocolErrorCode.InvalidParams);
      expect(parsed.message).toContain("MCP sampling tool use is not supported");

      await expect(handleSamplingRequest(makeOptions([]), samplingRequest())).rejects.toMatchObject(
        { code: ProtocolErrorCode.InternalError },
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
