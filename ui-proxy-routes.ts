import type { ServerResponse } from "node:http";
import type { UiServerOptions } from "./ui-server-options.ts";
import { resolveUiToolConsent } from "./consent-manager.ts";
import { createUiMessageHistory } from "./ui-message-history.ts";
import { isUiMessageParams, isUiModelContextParams } from "./ui-message-schema.ts";
import {
  createUiModelContextUpdate,
  extractUiPromptText,
  isUiIntentMessage,
  type UiDisplayMode,
  type UiHostContext,
  type UiMessageParams,
  type UiModelContextUpdate,
  type UiSessionMessages,
} from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";
import { sendJson } from "./ui-http.ts";
import { isSafeOpenLinkUrl } from "./ui-link-url.ts";
import type { logger } from "./logger.ts";

const MAX_CONTEXT_UPDATES = 20;
const MAX_HOST_ERROR_CHARS = 500;

/** Authenticated UI actions and their ordered, durable history. */
export class UiProxyRoutes {
  private readonly options: UiServerOptions;
  private readonly hostContext: UiHostContext;
  private readonly pushEvent: (name: string, payload: unknown) => void;
  private readonly history: ReturnType<typeof createUiMessageHistory>;
  private readonly log: ReturnType<typeof logger.child>;
  private currentDisplayMode: UiDisplayMode;
  private pendingModelContext: UiModelContextUpdate | undefined;
  private latestHostError: string | undefined;

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
    const messages = this.history.messages;
    return {
      ...messages,
      prompts: [...messages.prompts],
      intents: [...messages.intents],
      notifications: [...messages.notifications],
      contexts: [...messages.contexts],
    };
  }

  takeModelContext(): UiModelContextUpdate | undefined {
    const update = this.pendingModelContext;
    this.pendingModelContext = undefined;
    return update;
  }

  getHostError(): string | undefined {
    return this.latestHostError;
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
        this.context(params, res);
        break;
      case "/proxy/ui/error":
        this.hostError(params, res);
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
    const consentPolicy = resolveUiToolConsent(this.options.config, this.options.serverName);
    if (consentPolicy === "never") {
      sendJson(res, 403, {
        ok: false,
        error: `Tool calls from UI are denied by configuration for "${this.options.serverName}"`,
      });
      return;
    }
    if (consentPolicy === "always") {
      sendJson(res, 200, { ok: true, result: { approved: true } });
      return;
    }
    const approved = Boolean(isUiJsonObject(params) ? params.approved : undefined);
    this.options.consentManager.registerDecision(this.options.serverName, approved);
    sendJson(res, 200, { ok: true, result: { approved } });
  }

  private async message(params: unknown, res: ServerResponse): Promise<void> {
    if (!isUiMessageParams(params)) {
      sendJson(res, 400, { ok: false, error: "Invalid UI message params" });
      return;
    }
    const warning = this.recordMessage(params);
    await this.options.onMessage?.(params);
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
    if (isUiIntentMessage(params)) {
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

  private context(params: unknown, res: ServerResponse): void {
    if (!isUiModelContextParams(params)) {
      sendJson(res, 400, { ok: false, error: "Invalid update-model-context params" });
      return;
    }
    const update = createUiModelContextUpdate(params);
    this.pendingModelContext = update;
    if (this.options.state) {
      this.options.state.pendingUiModelContext = undefined;
    }
    const messages = this.history.messages;
    if (update) {
      messages.contexts.push(update);
      while (messages.contexts.length > MAX_CONTEXT_UPDATES) {
        messages.contexts.shift();
      }
    }
    this.log.debug("UI context update", {
      hasContent: Boolean(params.content),
      hasUpdate: Boolean(update),
    });
    sendJson(res, 200, { ok: true, result: {} });
  }

  private hostError(params: unknown, res: ServerResponse): void {
    if (!isUiJsonObject(params) || typeof params.message !== "string") {
      sendJson(res, 400, { ok: false, error: "Invalid UI error params" });
      return;
    }
    const message = params.message.trim().slice(0, MAX_HOST_ERROR_CHARS);
    if (message === "") {
      sendJson(res, 400, { ok: false, error: "Invalid UI error params" });
      return;
    }
    this.latestHostError = message;
    const warning = this.history.append("notifications", `UI host error: ${message}`);
    this.log.warn("UI host error reported", { message });
    this.options.state?.ui?.notify(
      `MCP UI error for ${this.options.toolName} (${this.options.serverName}): ${message}`,
      "warning",
    );
    this.options.onError?.(message);
    sendJson(res, 200, {
      ok: true,
      result: {},
      ...(warning !== undefined && warning !== "" ? { warning } : {}),
    });
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
  sendJson(res, 200, {
    ok: true,
    result: isSafeOpenLinkUrl(params.url) ? {} : { isError: true },
  });
}
