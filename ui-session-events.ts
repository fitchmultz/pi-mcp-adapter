import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { UiSessionRequest } from "./ui-session-contracts.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import {
  extractUiPromptText,
  isUiIntentMessage,
  type UiMessageParams,
} from "./ui-message-types.ts";

type UiModelContextMessage = NonNullable<BeforeAgentStartEventResult["message"]> & {
  content: string;
};

export function takeUiModelContextMessage(
  handle: UiServerHandle | null | undefined,
): UiModelContextMessage | undefined {
  const context = handle?.takeModelContext();
  if (!handle || !context) {
    return;
  }
  return {
    customType: "mcp-ui-context",
    content: `Context from the ${handle.serverName} MCP app:\n${context.summary}`,
    display: false,
    details: { server: handle.serverName, tool: handle.toolName, context },
  };
}

/** App chat requests and notifications; legacy intents only go to UI history. */
export class UiSessionEvents {
  private readonly state: McpExtensionState;
  private readonly request: UiSessionRequest;

  constructor(state: McpExtensionState, request: UiSessionRequest) {
    this.state = state;
    this.request = request;
  }

  message(params: UiMessageParams, handle: UiServerHandle | undefined): void {
    const prompt = extractUiPromptText(params);
    if (prompt !== undefined && prompt !== "") {
      this.prompt(prompt, handle);
      return;
    }
    if (isUiIntentMessage(params)) {
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

  private prompt(prompt: string, handle: UiServerHandle | undefined): void {
    if (!this.state.sendMessage) {
      return;
    }
    // Carry context with the request even when Pi queues it during a run.
    const context = takeUiModelContextMessage(handle);
    const request = `Chat request from the ${this.request.serverName} MCP app (not verified as user input):\n${prompt}`;
    this.state.sendMessage(
      {
        customType: "mcp-ui-prompt",
        content: [
          {
            type: "text",
            text: context ? `${request}\n\n${context.content}` : request,
          },
        ],
        display: `App chat request: ${prompt}`,
        details: {
          server: this.request.serverName,
          tool: this.request.toolName,
          prompt,
        },
      },
      { triggerTurn: true },
    );
  }
}
