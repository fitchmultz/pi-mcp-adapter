import type { ServerResponse } from "node:http";
import { ContentBlockSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import type { UiServerOptions } from "./ui-server-options.ts";
import { createUiMessageHistory } from "./ui-message-history.ts";
import {
  createUiModelContextUpdate,
  extractUiPromptText,
  type UiDisplayMode,
  type UiHostContext,
  type UiMessageParams,
  type UiSessionMessages,
} from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";
import { sendJson } from "./ui-http.ts";
import type { logger } from "./logger.ts";

const MAX_CONTEXT_UPDATES = 20;
const uiMessageSchema = z.looseObject({
  role: z.string().exactOptional(),
  content: z.array(z.unknown()).exactOptional(),
  type: z.enum(["prompt", "notify", "intent", "message"]).exactOptional(),
  message: z.string().exactOptional(),
  prompt: z.string().exactOptional(),
  intent: z.string().exactOptional(),
  params: z.record(z.string(), z.unknown()).exactOptional(),
});
const modelContextSchema = z.looseObject({
  // Validate with the native schema without stripping accepted block extensions.
  content: z
    .array(
      z.custom<z.infer<typeof ContentBlockSchema>>(
        (block) => ContentBlockSchema.safeParse(block).success,
      ),
    )
    .exactOptional(),
  structuredContent: z.record(z.string(), z.unknown()).exactOptional(),
});

/** Authenticated UI actions and their ordered, durable history. */
export class UiProxyRoutes {
  private readonly options: UiServerOptions;
  private readonly hostContext: UiHostContext;
  private readonly pushEvent: (name: string, payload: unknown) => void;
  private readonly history: ReturnType<typeof createUiMessageHistory>;
  private readonly log: ReturnType<typeof logger.child>;
  private currentDisplayMode: UiDisplayMode;

  constructor(
    options: UiServerOptions,
    hostContext: UiHostContext,
    pushEvent: (name: string, payload: unknown) => void,
    log: ReturnType<typeof logger.child>,
  ) {
    this.options = options;
    this.hostContext = hostContext;
    this.pushEvent = pushEvent;
    this.log = log;
    this.history = createUiMessageHistory(options.state?.outputDirectory);
    this.currentDisplayMode = hostContext.displayMode ?? "inline";
  }

  getMessages(): UiSessionMessages {
    return { ...this.history.messages };
  }

  async handle(pathname: string, params: unknown, res: ServerResponse): Promise<boolean> {
    switch (pathname) {
      case "/proxy/ui/consent":
        this.consent(params, res);
        break;
      case "/proxy/ui/message":
        await this.message(params, res);
        break;
      case "/proxy/ui/context":
        await this.context(params, res);
        break;
      case "/proxy/ui/open-link":
        openLink(params, res);
        break;
      case "/proxy/ui/download-file":
        sendJson(res, 200, { ok: true, result: { isError: true } });
        break;
      case "/proxy/ui/request-display-mode":
        this.displayMode(params, res);
        break;
      case "/proxy/ui/heartbeat":
        sendJson(res, 200, { ok: true, result: {} });
        break;
      default:
        return false;
    }
    return true;
  }

  private consent(params: unknown, res: ServerResponse): void {
    const approved = Boolean(isUiJsonObject(params) ? params.approved : undefined);
    this.options.consentManager.registerDecision(this.options.serverName, approved);
    sendJson(res, 200, { ok: true, result: { approved } });
  }

  private async message(params: unknown, res: ServerResponse): Promise<void> {
    const parsed = uiMessageSchema.safeParse(params);
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, error: "Invalid UI message params" });
      return;
    }
    const warning = this.recordMessage(parsed.data);
    await this.options.onMessage?.(parsed.data);
    if (warning !== undefined && warning !== "") {
      this.log.warn(warning);
      this.options.state?.ui?.notify(warning, "warning");
    }
    sendJson(res, 200, {
      ok: true,
      result: {},
      ...(warning !== undefined && warning !== "" ? { warning } : {}),
    });
  }

  private recordMessage(params: UiMessageParams): string | undefined {
    const prompt = extractUiPromptText(params);
    if (prompt !== undefined && prompt !== "") {
      const warning = this.history.append("prompts", prompt);
      this.log.debug("UI prompt received", { prompt: prompt.slice(0, 100) });
      return warning;
    }
    if (params.type === "intent" || Boolean(params.intent)) {
      return this.recordIntent(params);
    }
    if (
      (params.type === "notify" || Boolean(params.message)) &&
      params.message !== undefined &&
      params.message !== ""
    ) {
      const warning = this.history.append("notifications", params.message);
      this.log.debug("UI notification", { message: params.message.slice(0, 100) });
      return warning;
    }
    return undefined;
  }

  private recordIntent(params: UiMessageParams): string | undefined {
    const intent = params.intent ?? "";
    if (intent === "") {
      return undefined;
    }
    const warning = this.history.append("intents", {
      intent,
      ...(params.params !== undefined ? { params: params.params } : {}),
    });
    this.log.debug("UI intent received", { intent });
    return warning;
  }

  private async context(params: unknown, res: ServerResponse): Promise<void> {
    const parsed = modelContextSchema.safeParse(params);
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, error: "Invalid update-model-context params" });
      return;
    }
    const update = createUiModelContextUpdate(parsed.data);
    const messages = this.history.messages;
    if (update) {
      messages.contexts.push(update);
      while (messages.contexts.length > MAX_CONTEXT_UPDATES) {
        messages.contexts.shift();
      }
    }
    this.log.debug("UI context update", {
      hasContent: Boolean(parsed.data.content),
      hasUpdate: Boolean(update),
    });
    await this.options.onContextUpdate?.(parsed.data);
    sendJson(res, 200, { ok: true, result: {} });
  }

  private displayMode(params: unknown, res: ServerResponse): void {
    const requested = isUiJsonObject(params) ? params.mode : undefined;
    const available = this.hostContext.availableDisplayModes ?? ["inline"];
    if (
      (requested === "inline" || requested === "fullscreen" || requested === "pip") &&
      available.includes(requested)
    ) {
      this.currentDisplayMode = requested;
    }
    this.hostContext.displayMode = this.currentDisplayMode;
    this.pushEvent("host-context", { displayMode: this.currentDisplayMode });
    sendJson(res, 200, { ok: true, result: { mode: this.currentDisplayMode } });
  }
}

function openLink(params: unknown, res: ServerResponse): void {
  if (!isUiJsonObject(params) || typeof params.url !== "string" || params.url === "") {
    sendJson(res, 400, { ok: false, error: "Invalid open-link params" });
    return;
  }
  const invalid = URL.parse(params.url) === null;
  sendJson(res, 200, { ok: true, result: invalid ? { isError: true } : {} });
}
