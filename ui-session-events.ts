import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState, PendingUiModelContext } from "./state.ts";
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

function formatUiModelContextMessage(entry: PendingUiModelContext): UiModelContextMessage {
  return {
    customType: "mcp-ui-context",
    content: `Context from the ${entry.serverName} MCP app:\n${entry.context.summary}`,
    display: false,
    details: { server: entry.serverName, tool: entry.toolName, context: entry.context },
  };
}

export function takeUiModelContextMessage(
  handle: UiServerHandle | null | undefined,
  retained?: PendingUiModelContext,
): UiModelContextMessage | undefined {
  const context = handle?.takeModelContext();
  if (handle && context) {
    return formatUiModelContextMessage({
      serverName: handle.serverName,
      toolName: handle.toolName,
      context,
    });
  }
  return retained ? formatUiModelContextMessage(retained) : undefined;
}

export function consumeStateUiModelContext(
  state: McpExtensionState | null,
): { message: UiModelContextMessage } | undefined {
  const currentState = state;
  if (!currentState) {
    return undefined;
  }
  const message = takeUiModelContextMessage(
    currentState.uiServer,
    currentState.pendingUiModelContext,
  );
  if (!message) {
    return undefined;
  }
  currentState.pendingUiModelContext = undefined;
  return { message };
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
    const context = takeUiModelContextMessage(handle, this.state.pendingUiModelContext);
    if (context) {
      this.state.pendingUiModelContext = undefined;
    }
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
