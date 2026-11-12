import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CreateMessageRequest, ModelPreferences } from "@modelcontextprotocol/client";
import type { SamplingHandlerOptions } from "../../sampling-handler.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";

const mocks = {
  complete: vi.fn<SamplingHandlerOptions["modelRegistry"]["complete"]>(),
};
let native: Awaited<ReturnType<typeof createTestExtensionContext>>;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
  provider: "anthropic",
  id: "claude-sonnet",
  api: "anthropic-messages",
  name: "Claude Sonnet",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  reasoning: false,
  cost: usage.cost,
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"anthropic-messages">;

const opus = {
  ...model,
  id: "claude-opus",
  name: "Claude Opus",
} satisfies Model<"anthropic-messages">;

const haiku = {
  ...model,
  id: "claude-haiku",
  name: "Claude Haiku",
} satisfies Model<"anthropic-messages">;

const geminiFlash = {
  ...model,
  provider: "google",
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  name: "Gemini 2.5 Flash",
  baseUrl: "https://generativelanguage.googleapis.com",
} satisfies Model<"google-generative-ai">;

type SamplingTestOptions = Omit<SamplingHandlerOptions, "modelRegistry" | "ui"> & {
  ui?: Pick<ExtensionUIContext, "confirm"> | undefined;
  modelRegistry: Pick<
    SamplingHandlerOptions["modelRegistry"],
    "getAvailable" | "getApiKeyAndHeaders"
  >;
};

function createOptions(overrides: Partial<SamplingTestOptions> = {}): SamplingHandlerOptions {
  const { modelRegistry: registryOverride, ui, ...rest } = overrides;
  const modelRegistry = native.context.modelRegistry;
  vi.spyOn(modelRegistry, "getAvailable").mockImplementation(
    () => registryOverride?.getAvailable() ?? [model],
  );
  vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async (...args) => {
    if (registryOverride !== undefined) {
      return await registryOverride.getApiKeyAndHeaders(...args);
    }
    return { ok: true, apiKey: "key", headers: { authorization: null, "x-test": "1" } };
  });
  return {
    serverName: "i18n",
    autoApprove: true,
    modelRegistry,
    getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(),
    getSignal: vi.fn<SamplingHandlerOptions["getSignal"]>(),
    ...(ui !== undefined ? { ui: { ...native.context.ui, ...ui } } : {}),
    ...rest,
  };
}

async function runBasicSampling(
  overrides: Partial<SamplingTestOptions>,
  modelPreferences?: ModelPreferences,
): Promise<void> {
  const { handleSamplingRequest } = await import("../../sampling-handler.ts");
  await handleSamplingRequest(
    createOptions(overrides),
    createSamplingRequest({
      ...(modelPreferences ? { modelPreferences } : {}),
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      maxTokens: 50,
    }),
  );
}

function createSamplingRequest(params: CreateMessageRequest["params"]): CreateMessageRequest {
  return { method: "sampling/createMessage", params };
}

describe("sampling handler", () => {
  beforeEach(async () => {
    native = await createTestExtensionContext();
    vi.spyOn(native.context.modelRegistry, "complete").mockImplementation(mocks.complete);
    mocks.complete.mockReset().mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "Bonjour" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage,
      stopReason: "stop",
      timestamp: 1,
    });
  });

  afterEach(async () => {
    await native.dispose();
    vi.restoreAllMocks();
  });

  it("converts approved MCP sampling requests through Pi's model runtime", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");
    const result = await handleSamplingRequest(
      createOptions(),
      createSamplingRequest({
        systemPrompt: "Translate tersely.",
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        maxTokens: 50,
        temperature: 0.2,
        metadata: { locale: "fr" },
      }),
    );

    const timestamp: unknown = expect.any(Number);
    expect(mocks.complete).toHaveBeenCalledWith(
      model,
      {
        systemPrompt: "Translate tersely.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            timestamp,
          },
        ],
      },
      {
        maxTokens: 50,
        temperature: 0.2,
        metadata: { locale: "fr" },
        signal: undefined,
      },
    );
    expect(result).toEqual({
      role: "assistant",
      content: { type: "text", text: "Bonjour" },
      model: "anthropic/claude-sonnet",
      stopReason: "endTurn",
    });
  });

  it.each(["openai-responses", "openai-codex-responses"] as const)(
    "omits Astra's rejected temperature in nested %s sampling",
    async (api) => {
      const { handleSamplingRequest } = await import("../../sampling-handler.ts");
      const astra = { ...model, provider: "openai", id: "gpt-6-astra", api };
      await handleSamplingRequest(
        createOptions({ getCurrentModel: () => astra }),
        createSamplingRequest({
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
          maxTokens: 50,
          temperature: 0.2,
        }),
      );
      expect(requireValue(mocks.complete.mock.calls[0])[2]).not.toHaveProperty("temperature");
      expect(requireValue(mocks.complete.mock.calls[0])[2]).toHaveProperty("maxTokens", 50);
    },
  );

  it("requires UI approval unless auto-approve is enabled", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");

    await expect(
      handleSamplingRequest(
        createOptions({ autoApprove: false, ui: undefined }),
        createSamplingRequest({ messages: [], maxTokens: 50 }),
      ),
    ).rejects.toThrow("MCP sampling requires interactive approval");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("asks for approval with inspectable request and response content", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");
    const ui = { confirm: vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true) };

    await handleSamplingRequest(
      createOptions({ autoApprove: false, ui }),
      createSamplingRequest({
        systemPrompt: "Translate tersely.",
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        maxTokens: 50,
      }),
    );

    expect(ui.confirm).toHaveBeenCalledTimes(2);
    expect(requireValue(ui.confirm.mock.calls[0])[0]).toBe("Approve MCP sampling request");
    expect(requireValue(ui.confirm.mock.calls[0])[1]).toContain("System: Translate tersely.");
    expect(requireValue(ui.confirm.mock.calls[0])[1]).toContain("1. user: Hello");
    expect(requireValue(ui.confirm.mock.calls[1])[0]).toBe("Return MCP sampling response");
    expect(requireValue(ui.confirm.mock.calls[1])[1]).toContain("Bonjour");
  });

  it("dismisses the approval dialog when the turn aborts and surfaces the abort reason", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");
    const controller = new AbortController();
    const reason = new Error("turn cancelled");
    reason.name = "AbortError";
    let dismissed = false;
    // Mirror Pi's dialog behavior: an aborted dialog signal resolves confirm as not approved.
    const confirm = vi.fn<Pick<ExtensionUIContext, "confirm">["confirm"]>(
      async (_title, _message, opts) => {
        const signal = opts?.signal;
        if (signal === undefined) {
          throw new Error("test dialog expected a bound signal");
        }
        if (signal.aborted) {
          dismissed = true;
          return false;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              dismissed = true;
              resolve();
            },
            { once: true },
          );
        });
        return false;
      },
    );

    const pending = handleSamplingRequest(
      createOptions({
        autoApprove: false,
        ui: { confirm },
        getSignal: () => controller.signal,
      }),
      createSamplingRequest({
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        maxTokens: 50,
      }),
    );
    await expect.poll(() => confirm.mock.calls.length).toBeGreaterThan(0);
    expect(confirm.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(dismissed).toBe(true);
  });

  it("uses model preference hints before the current conversation model", async () => {
    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            haiku,
            opus,
          ]),
          getApiKeyAndHeaders: vi.fn<
            SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
          >(async () => ({ ok: true as const, apiKey: "key" })),
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: "haiku" }] },
    );

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(haiku);
  });

  it("matches model preference hints case-insensitively after trimming", async () => {
    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            haiku,
            opus,
          ]),
          getApiKeyAndHeaders: vi.fn<
            SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
          >(async () => ({ ok: true as const, apiKey: "key" })),
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: " HAIKU " }] },
    );

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(haiku);
  });

  it("matches model preference hints against display names", async () => {
    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            geminiFlash,
            opus,
          ]),
          getApiKeyAndHeaders: vi.fn<
            SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
          >(async () => ({ ok: true as const, apiKey: "key" })),
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: "2.5 Flash" }] },
    );

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(geminiFlash);
  });

  it("matches model preference hints against provider/id", async () => {
    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            geminiFlash,
            opus,
          ]),
          getApiKeyAndHeaders: vi.fn<
            SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
          >(async () => ({ ok: true as const, apiKey: "key" })),
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: "google/gemini" }] },
    );

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(geminiFlash);
  });

  it("preserves preference order across multiple model hints", async () => {
    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            haiku,
            geminiFlash,
            opus,
          ]),
          getApiKeyAndHeaders: vi.fn<
            SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
          >(async () => ({ ok: true as const, apiKey: "key" })),
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: "gemini" }, { name: "haiku" }] },
    );

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(geminiFlash);
  });

  it("falls back when hinted models do not have configured auth", async () => {
    const getApiKeyAndHeaders = vi.fn<
      SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]
    >(async (candidate: Model<Api>) => {
      if (candidate.id === "claude-haiku") {
        return { ok: false as const, error: "missing key" };
      }
      return { ok: true as const, apiKey: "key" };
    });

    await runBasicSampling(
      {
        modelRegistry: {
          getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [
            haiku,
            opus,
          ]),
          getApiKeyAndHeaders,
        },
        getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
      },
      { hints: [{ name: "haiku" }] },
    );

    expect(getApiKeyAndHeaders).toHaveBeenNthCalledWith(1, haiku);
    expect(getApiKeyAndHeaders).toHaveBeenNthCalledWith(2, opus);
    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(opus);
  });

  it("preserves current-model-first selection when no hints are provided", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn<SamplingHandlerOptions["modelRegistry"]["getAvailable"]>(() => [haiku]),
        getApiKeyAndHeaders: vi.fn<SamplingHandlerOptions["modelRegistry"]["getApiKeyAndHeaders"]>(
          async () => ({ ok: true as const, apiKey: "key" }),
        ),
      },
      getCurrentModel: vi.fn<SamplingHandlerOptions["getCurrentModel"]>(() => opus),
    });

    expect(requireValue(mocks.complete.mock.calls[0])[0]).toBe(opus);
  });

  it("rejects unsupported sampling features loudly", async () => {
    const { handleSamplingRequest } = await import("../../sampling-handler.ts");

    await expect(
      handleSamplingRequest(
        createOptions(),
        createSamplingRequest({
          messages: [
            { role: "user", content: { type: "image", data: "abc", mimeType: "image/png" } },
          ],
          maxTokens: 50,
        }),
      ),
    ).rejects.toThrow("MCP sampling image content is not supported");

    await expect(
      handleSamplingRequest(
        createOptions(),
        createSamplingRequest({
          messages: [
            { role: "user", content: { type: "audio", data: "abc", mimeType: "audio/wav" } },
          ],
          maxTokens: 50,
        }),
      ),
    ).rejects.toThrow("MCP sampling audio content is not supported");

    await expect(
      handleSamplingRequest(
        createOptions(),
        createSamplingRequest({
          messages: [],
          maxTokens: 50,
          includeContext: "thisServer",
        }),
      ),
    ).rejects.toThrow("MCP sampling context inclusion is not supported");

    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
