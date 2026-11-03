import type { McpExtensionState } from "./state.ts";
import type { UiSessionRequest } from "./ui-session-contracts.ts";
import {
  createUiModelContextUpdate,
  extractUiPromptText,
  type UiMessageParams,
  type UiModelContextParams,
} from "./types.ts";
import { logger } from "./logger.ts";

/** Converts accepted app messages into the existing Pi handoff and notification flow. */
export class UiSessionEvents {
  private readonly state: McpExtensionState;
  private readonly request: UiSessionRequest;
  private readonly log: ReturnType<typeof logger.child>;

  constructor(state: McpExtensionState, request: UiSessionRequest) {
    this.state = state;
    this.request = request;
    this.log = logger.child({
      component: "UiSession",
      server: request.serverName,
      tool: request.toolName,
    });
  }

  message(params: UiMessageParams): void {
    const prompt = extractUiPromptText(params);
    if (prompt !== undefined && prompt !== "") {
      this.prompt(prompt);
      return;
    }
    if (params.type === "intent" || Boolean(params.intent)) {
      this.intent(params);
      return;
    }
    if (
      (params.type === "notify" || Boolean(params.message)) &&
      params.message !== undefined &&
      params.message !== ""
    ) {
      this.state.ui?.notify(`[${this.request.serverName}] ${params.message}`, "info");
    }
  }

  context(params: UiModelContextParams): void {
    const update = createUiModelContextUpdate(params);
    this.log.debug("Model context update from UI", {
      hasContent: Boolean(params.content),
      hasStructured: Boolean(params.structuredContent),
      hasUpdate: Boolean(update),
    });
    if (update && this.state.sendMessage) {
      this.state.sendMessage(
        {
          customType: "mcp-ui-context",
          content: [
            {
              type: "text",
              text: `User submitted model context from ${this.request.serverName} UI:\n${update.summary}`,
            },
          ],
          display: "UI Context submitted",
          details: {
            server: this.request.serverName,
            tool: this.request.toolName,
            context: update,
          },
        },
        { triggerTurn: true },
      );
    }
  }

  private prompt(prompt: string): void {
    if (this.state.sendMessage) {
      this.state.sendMessage(
        {
          customType: "mcp-ui-prompt",
          content: [
            {
              type: "text",
              text: `User sent prompt from ${this.request.serverName} UI: "${prompt}"`,
            },
          ],
          display: `💬 UI Prompt: ${prompt}`,
          details: { server: this.request.serverName, tool: this.request.toolName, prompt },
        },
        { triggerTurn: true },
      );
      this.log.debug("Triggered agent turn for UI prompt", { prompt: prompt.slice(0, 50) });
    }
  }

  private intent(params: UiMessageParams): void {
    const intent = params.intent ?? "";
    if (intent === "" || !this.state.sendMessage) {
      return;
    }
    const intentParams = params.params;
    const paramsStr = intentParams ? ` ${JSON.stringify(intentParams)}` : "";
    this.state.sendMessage(
      {
        customType: "mcp-ui-intent",
        content: [
          {
            type: "text",
            text: `User triggered intent from ${this.request.serverName} UI: ${intent}${paramsStr}`,
          },
        ],
        display: `🎯 UI Intent: ${intent}`,
        details: {
          server: this.request.serverName,
          tool: this.request.toolName,
          intent,
          params: intentParams,
        },
      },
      { triggerTurn: true },
    );
    this.log.debug("Triggered agent turn for UI intent", { intent });
  }
}
