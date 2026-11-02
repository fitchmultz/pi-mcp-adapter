import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Client, InMemoryTransport, type GetPromptResult } from "@modelcontextprotocol/client";
import {
  createPromptCommand,
  formatPromptResult,
  parsePromptArgs,
  resolvePromptArgs,
} from "../prompts.ts";
import type { McpExtensionState } from "../state.ts";
import { formatPromptCommandName, sanitizePromptName, type PromptMetadata } from "../types.ts";
import type { McpServerManager, ServerConnection } from "../server-manager.ts";

function meta(overrides: Partial<PromptMetadata> = {}): PromptMetadata {
  return {
    serverName: "demo",
    originalName: "brief",
    commandName: "mcp__demo__brief",
    description: "Daily brief",
    arguments: [
      { name: "topic", required: true, description: "Topic" },
      { name: "date", required: false },
    ],
    ...overrides,
  };
}

function baseState(promptMetadata: Map<string, PromptMetadata[]>): {
  state: McpExtensionState;
  connection: ServerConnection;
  getConnection: MockInstance<McpServerManager["getConnection"]>;
  getPrompt: MockInstance<McpServerManager["getPrompt"]>;
} {
  const state = createTestState({
    config: { mcpServers: { demo: { command: "demo" } } },
    promptMetadata,
  });
  const connection: ServerConnection = {
    client: new Client({ name: "prompt-test", version: "1" }),
    transport: new InMemoryTransport(),
    definition: { command: "demo" },
    status: "connected",
    tools: [],
    resources: [],
    prompts: [
      {
        name: "brief",
        arguments: [
          { name: "topic", required: true },
          { name: "date", required: false },
        ],
      },
    ],
    lastUsedAt: Date.now(),
    inFlight: 0,
  };
  const getConnection = vi.spyOn(state.manager, "getConnection").mockReturnValue(connection);
  const getPrompt = vi.spyOn(state.manager, "getPrompt");
  return { state, connection, getConnection, getPrompt };
}

describe("prompt command naming", () => {
  it("mirrors Claude Code's mcp__<server>__<prompt> convention", () => {
    expect(formatPromptCommandName("plan", "agent-board", "server")).toBe("mcp__agent_board__plan");
  });

  it("honors the toolPrefix short mode", () => {
    expect(formatPromptCommandName("plan", "agent-board-mcp", "short")).toBe(
      "mcp__agent_board__plan",
    );
  });

  it("falls back to the server name when toolPrefix is 'none'", () => {
    expect(formatPromptCommandName("plan", "agent-board", "none")).toBe("mcp__agent_board__plan");
  });

  it("sanitizes prompt names with unusual characters", () => {
    expect(sanitizePromptName("weekly.report")).toBe("weekly_report");
    expect(sanitizePromptName("with spaces & symbols")).toBe("with_spaces_symbols");
    expect(sanitizePromptName("123-start")).toBe("_123-start");
    expect(sanitizePromptName("---")).toBe("prompt");
  });
});

describe("parsePromptArgs", () => {
  it("splits positional args on whitespace", () => {
    expect(parsePromptArgs("today weather")).toEqual({
      positional: ["today", "weather"],
      named: {},
    });
  });

  it("preserves double-quoted phrases", () => {
    expect(parsePromptArgs('"important tasks" today')).toEqual({
      positional: ["important tasks", "today"],
      named: {},
    });
  });

  it("recognizes key=value tokens as named args", () => {
    expect(parsePromptArgs("topic=demo date=today")).toEqual({
      positional: [],
      named: { topic: "demo", date: "today" },
    });
  });

  it("allows quoted values in key=value tokens", () => {
    expect(parsePromptArgs('topic="demo of the day" date=today')).toEqual({
      positional: [],
      named: { topic: "demo of the day", date: "today" },
    });
  });

  it("mixes positional and named", () => {
    expect(parsePromptArgs("today topic=demo")).toEqual({
      positional: ["today"],
      named: { topic: "demo" },
    });
  });
});

describe("resolvePromptArgs", () => {
  it("returns positional args mapped by declared order", () => {
    const result = resolvePromptArgs(meta(), { positional: ["ai", "today"], named: {} });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ topic: "ai", date: "today" });
  });

  it("prefers named args over positional when both are provided", () => {
    const result = resolvePromptArgs(meta(), {
      positional: ["fallback"],
      named: { topic: "ai" },
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ topic: "ai", date: "fallback" });
  });

  it("rejects missing required args with a usage hint", () => {
    const result = resolvePromptArgs(meta(), { positional: [], named: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required argument");
    expect(result.error).toContain("Usage: /mcp__demo__brief <topic> [date]");
  });

  it("allows undeclared named args through for permissive server schemas", () => {
    const result = resolvePromptArgs(meta({ arguments: [] }), {
      positional: [],
      named: { extra: "value" },
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ extra: "value" });
  });
});

describe("formatPromptResult", () => {
  it("returns a single user message verbatim", () => {
    const result: GetPromptResult = {
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
    };
    expect(formatPromptResult(result)).toBe("Hello");
  });

  it("preserves role attribution for multi-turn prompts", () => {
    const result: GetPromptResult = {
      messages: [
        { role: "user", content: { type: "text", text: "Hi" } },
        { role: "assistant", content: { type: "text", text: "Hello" } },
      ],
    };
    expect(formatPromptResult(result)).toBe("[user] Hi\n\n[assistant] Hello");
  });

  it("summarizes embedded resource content", () => {
    const result: GetPromptResult = {
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "file:///readme.md", text: "# Title" },
          },
        },
      ],
    };
    expect(formatPromptResult(result)).toContain("[resource file:///readme.md]");
    expect(formatPromptResult(result)).toContain("# Title");
  });

  it("returns an empty string when no message has extractable text", () => {
    const result: GetPromptResult = {
      messages: [
        {
          role: "user",
          content: {
            type: "image",
            data: "b64",
            mimeType: "image/png",
          },
        },
      ],
    };
    // Images still produce a placeholder marker so the model sees the intent.
    expect(formatPromptResult(result)).toBe("[image image/png (embedded)]");
  });
});

describe("createPromptCommand handler", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await host.dispose();
  });

  function commandHost() {
    const ui = { ...host.commandContext.ui };
    const notify = vi.spyOn(ui, "notify");
    const sendUserMessage = vi.spyOn(host.api, "sendUserMessage").mockImplementation(() => {
      // Avoid starting an agent turn in this command test.
    });
    return { context: { ...host.commandContext, hasUI: true, ui }, notify, sendUserMessage };
  }

  it("sends the resolved prompt text as a user message", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const { state, getPrompt } = baseState(promptMetadata);
    getPrompt.mockResolvedValue({
      messages: [{ role: "user", content: { type: "text", text: "Brief for ai" } }],
    });
    const { context, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, meta());
    await command.handler("ai", context);

    expect(getPrompt).toHaveBeenCalledWith("demo", "brief", { topic: "ai" }, undefined);
    expect(sendUserMessage).toHaveBeenCalledWith("Brief for ai");
  });

  it("shows a usage error when required args are missing", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const { state } = baseState(promptMetadata);
    const { context, notify, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, meta());
    await command.handler("", context);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Missing required argument"),
      "error",
    );
  });

  it("surfaces MCP server errors without sending a user message", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const { state, getPrompt } = baseState(promptMetadata);
    getPrompt.mockRejectedValue(new Error("Prompt not found"));
    const { context, notify, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, meta());
    await command.handler("ai", context);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Prompt not found"), "error");
  });

  it("prompts users to authenticate when the server needs auth", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const { state, connection, getConnection } = baseState(promptMetadata);
    getConnection.mockReturnValue({ ...connection, status: "needs-auth" });
    const { context, notify, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, meta());
    await command.handler("ai", context);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("needs authentication"), "error");
  });

  it("warns when the prompt returns no textual content", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const { state, getPrompt } = baseState(promptMetadata);
    getPrompt.mockResolvedValue({ messages: [] });
    const { context, notify, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, meta());
    await command.handler("ai", context);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no text content"), "warning");
  });
});
