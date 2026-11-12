import type { McpExtensionState, CompletedUiSession } from "./state.ts";
import type { ProxyToolResult } from "./proxy-result.ts";
import { parseUiPromptHandoff, type UiSessionMessages } from "./types.ts";
import { materializeUiMessages, uiMessages } from "./ui-message-history.ts";
import { DEFAULT_MCP_DETAILS_MAX_BYTES } from "./mcp-output-contracts.ts";
import {
  resolveMcpOutputGuardOptions,
  saveMcpOutputStream,
  formatMcpResultReference,
} from "./mcp-output-guard.ts";

async function* section(heading: string, lines: AsyncIterable<string>): AsyncGenerator<string> {
  let shown = false;
  for await (const line of lines) {
    if (!shown) {
      yield `\n\n### ${heading}:`;
      shown = true;
    }
    yield `\n- ${line}`;
  }
}
async function* plainPrompts(messages: UiSessionMessages): AsyncGenerator<string> {
  for await (const prompt of textMessages(messages, "prompts")) {
    if (!parseUiPromptHandoff(prompt)) {
      yield prompt;
    }
  }
}
async function* formattedIntents(messages: UiSessionMessages): AsyncGenerator<string> {
  for await (const intent of intentMessages(messages)) {
    yield `${intent.intent}${intent.params ? ` (${JSON.stringify(intent.params)})` : ""}`;
  }
  for await (const prompt of textMessages(messages, "prompts")) {
    const handoff = parseUiPromptHandoff(prompt);
    if (handoff) {
      yield `${handoff.intent} (${JSON.stringify(handoff.params)})`;
    }
  }
}
async function* uiSessionText(session: CompletedUiSession): AsyncGenerator<string> {
  yield `\n## ${session.serverName} / ${session.toolName} (${session.completedAt.toLocaleTimeString()}, ${session.reason})`;
  yield* section("Prompts", plainPrompts(session.messages));
  yield* section("Intents", formattedIntents(session.messages));
  if (session.messages.contexts.length > 0) {
    yield "\n\n### Context updates:";
    for (const context of session.messages.contexts) {
      yield `\n- ${context.summary}${context.truncated ? " (truncated)" : ""}`;
    }
  }
  yield* section("Notifications", textMessages(session.messages, "notifications"));
}
async function* textMessages(
  messages: UiSessionMessages,
  category: "prompts" | "notifications",
): AsyncGenerator<string> {
  for await (const value of uiMessages(messages, category)) {
    if (typeof value !== "string") {
      throw new TypeError("UI text history contains a non-text message");
    }
    yield value;
  }
}
async function* intentMessages(
  messages: UiSessionMessages,
): AsyncGenerator<UiSessionMessages["intents"][number]> {
  for await (const value of uiMessages(messages, "intents")) {
    if (typeof value === "string") {
      throw new TypeError("UI intent history contains a text message");
    }
    yield value;
  }
}

function inlineSection(heading: string, lines: string[]): string[] {
  return lines.length > 0 ? [`\n### ${heading}:`, ...lines.map((line) => `- ${line}`)] : [];
}
function inlineSessionText(session: CompletedUiSession): string[] {
  const { messages } = session;
  const prompts = messages.prompts.filter((prompt) => parseUiPromptHandoff(prompt) === undefined);
  const intents = [
    ...messages.intents,
    ...messages.prompts
      .map((prompt) => parseUiPromptHandoff(prompt))
      .filter((handoff) => handoff !== undefined),
  ];
  return [
    `\n## ${session.serverName} / ${session.toolName} (${session.completedAt.toLocaleTimeString()}, ${session.reason})`,
    ...inlineSection("Prompts", prompts),
    ...inlineSection(
      "Intents",
      intents.map(
        (intent) => `${intent.intent}${intent.params ? ` (${JSON.stringify(intent.params)})` : ""}`,
      ),
    ),
    ...inlineSection(
      "Context updates",
      messages.contexts.map(
        (context) => `${context.summary}${context.truncated ? " (truncated)" : ""}`,
      ),
    ),
    ...inlineSection("Notifications", messages.notifications),
  ];
}
function renderInlineSessions(
  sessions: CompletedUiSession[],
  warnings: (string | undefined)[],
): ProxyToolResult {
  const output: string[] = [];
  output.push(
    `UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`,
  );

  const allPrompts: string[] = [];
  const allIntents = sessions.flatMap((session) => session.messages.intents);
  const allContexts = sessions.flatMap((session) => session.messages.contexts);
  const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> =
    [];

  for (const session of sessions) {
    output.push(...inlineSessionText(session));
    for (const prompt of session.messages.prompts) {
      allPrompts.push(prompt);
      const handoff = parseUiPromptHandoff(prompt);
      if (handoff) {
        parsedHandoffs.push(handoff);
      }
    }
  }

  const count = sessions.length;
  return {
    content: [
      {
        type: "text" as const,
        text:
          output.join("\n") +
          (warnings.length > 0 ? `\nHistory persistence warning: ${warnings.join("; ")}` : ""),
      },
    ],
    details: {
      sessions: count,
      prompts: allPrompts,
      intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
      contexts: allContexts,
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}
const deliveries = new WeakMap<McpExtensionState, Promise<ProxyToolResult>>();

export async function executeUiMessages(state: McpExtensionState): Promise<ProxyToolResult> {
  const previous = deliveries.get(state);
  const deliver = () => new UiMessageDelivery(state).execute();
  const promise = previous ? previous.then(deliver, deliver) : deliver();
  deliveries.set(state, promise);
  try {
    return await promise;
  } finally {
    if (deliveries.get(state) === promise) {
      deliveries.delete(state);
    }
  }
}
class UiMessageDelivery {
  private readonly pending: CompletedUiSession[];
  private readonly warnings: (string | undefined)[];
  private readonly state: McpExtensionState;
  constructor(state: McpExtensionState) {
    this.state = state;
    this.pending = [...state.completedUiSessions];
    this.warnings = this.pending.flatMap((session) =>
      (session.messages.historyError ?? "").length > 0 ? [session.messages.historyError] : [],
    );
  }
  private drain(): void {
    this.state.completedUiSessions = this.state.completedUiSessions.filter(
      (session) => !this.pending.includes(session),
    );
  }
  private async paged(): Promise<ProxyToolResult> {
    const { pending, state, warnings } = this;
    async function* output() {
      yield `UI Session Messages (${pending.length} sessions):\n`;
      for (const session of pending) {
        yield* uiSessionText(session);
      }
    }
    const artifact = await saveMcpOutputStream(output(), state.outputDirectory);
    if (artifact.path === undefined || artifact.path.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `UI messages remain available; retrieval could not be saved: ${String(artifact.error)}`,
          },
        ],
        isError: true,
        details: { error: "ui_history_delivery_failed", cleared: false },
      };
    }
    // Newly completed sessions during I/O are not part of this drain.
    this.drain();
    return {
      content: [
        {
          type: "text",
          text: `UI Session Messages (${pending.length} sessions). ${formatMcpResultReference(artifact.path)}${warnings.length > 0 ? `\nHistory persistence warning: ${warnings.join("; ")}` : ""}`,
        },
      ],
      details: {
        sessions: pending.length,
        resultRef: artifact.path,
        historyRefs: pending.flatMap((session) =>
          (session.messages.historyRef ?? "").length > 0 ? [session.messages.historyRef] : [],
        ),
        cleared: true,
      },
    };
  }

  async execute(): Promise<ProxyToolResult> {
    const { state, pending, warnings } = this;
    const options = resolveMcpOutputGuardOptions(state.config.settings, state.outputDirectory);
    // Bound both inline output and details. Large retrieval streams; it never flattens all events.
    const size = pending.reduce(
      (bytes, session) =>
        bytes +
        (session.messages.historyBytes ?? 0) +
        Buffer.byteLength(JSON.stringify(session.messages)),
      0,
    );
    const large =
      size > Math.min(options.maxBytes, options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES);
    if (large) {
      return this.paged();
    }
    let sessions: CompletedUiSession[];
    try {
      sessions = await Promise.all(
        pending.map(async (session) =>
          Object.assign({}, session, { messages: await materializeUiMessages(session.messages) }),
        ),
      );
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `UI messages remain available; history could not be read: ${String(error)}`,
          },
        ],
        isError: true,
        details: { error: "ui_history_delivery_failed", cleared: false },
      };
    }

    if (sessions.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No UI session messages available." }],
        details: { sessions: 0 },
      };
    }

    const inline = renderInlineSessions(sessions, warnings);
    const text = inline.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    if (
      Buffer.byteLength(JSON.stringify(inline.details)) >
        (options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES) ||
      Buffer.byteLength(text) > options.maxBytes ||
      text.split("\n").length > options.maxLines
    ) {
      return this.paged();
    }
    this.drain();
    return inline;
  }
}
