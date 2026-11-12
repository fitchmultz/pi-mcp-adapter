import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";
import { createPromptCommand } from "../prompts.ts";
import { reconstructPromptMetadata } from "../metadata-cache.ts";
import type { McpExtensionState } from "../state.ts";
import { formatPromptCommandName, type PromptMetadata } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/prompts-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

async function createConnectedManager() {
  const manager = new McpServerManager();
  await manager.connect("real", definition);
  managers.push(manager);
  return manager;
}

function buildPromptMetadata(
  manager: McpServerManager,
  prefix: "server" | "none" | "short" = "server",
): PromptMetadata[] {
  const conn = manager.getConnection("real");
  assert.ok(conn, "expected connected prompt server");
  return reconstructPromptMetadata("real", conn.prompts, prefix);
}

function findPrompt(metadata: PromptMetadata[], name: string): PromptMetadata {
  const prompt = metadata.find((entry) => entry.originalName === name);
  assert.ok(prompt, `expected prompt ${name}`);
  return prompt;
}

function buildState(
  manager: McpServerManager,
  promptMetadata: PromptMetadata[],
): McpExtensionState {
  return createTestState({
    manager,
    config: { mcpServers: { real: definition } },
    promptMetadata: new Map([["real", promptMetadata]]),
  });
}

describe("prompts with the real MCP SDK", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.closeAll()));
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

  it("discovers prompts advertised by the server", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);

    expect(metadata.map((p) => p.commandName).sort()).toEqual(
      [
        formatPromptCommandName("brief", "real", "server"),
        formatPromptCommandName("haiku", "real", "server"),
      ].sort(),
    );

    const brief = findPrompt(metadata, "brief");
    expect(brief.arguments).toHaveLength(2);
    expect(brief.arguments[0]).toMatchObject({ name: "topic", required: true });
  });

  it("dispatches a positional argument and forwards the prompt text to pi", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = findPrompt(metadata, "brief");
    const state = buildState(manager, metadata);
    const { context, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, brief);
    await command.handler("mcp", context);

    expect(sendUserMessage).toHaveBeenCalledWith("Give me the brief on mcp for today.");
  });

  it("passes named arguments through to prompts/get", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = findPrompt(metadata, "brief");
    const state = buildState(manager, metadata);
    const { context, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, brief);
    await command.handler('topic="model context protocol" date=2026-01-01', context);

    expect(sendUserMessage).toHaveBeenCalledWith(
      "Give me the brief on model context protocol for 2026-01-01.",
    );
  });

  it("resolves positional arguments after lazy discovery replaces cached arguments", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    const cached: PromptMetadata = {
      serverName: "real",
      originalName: "brief",
      commandName: formatPromptCommandName("brief", "real", "server"),
      description: "Cached brief",
      arguments: [{ name: "oldTopic", required: true }],
    };
    const state = buildState(manager, [cached]);
    const { context, sendUserMessage } = commandHost();

    await createPromptCommand(host.api, () => state, cached).handler("mcp", context);

    expect(sendUserMessage).toHaveBeenCalledWith("Give me the brief on mcp for today.");
  });

  it("does not reject arguments using obsolete cached requirements before discovery", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    const cached: PromptMetadata = {
      serverName: "real",
      originalName: "haiku",
      commandName: formatPromptCommandName("haiku", "real", "server"),
      description: "Cached haiku",
      arguments: [{ name: "obsolete", required: true }],
    };
    const state = buildState(manager, [cached]);
    const { context, notify, sendUserMessage } = commandHost();

    await createPromptCommand(host.api, () => state, cached).handler("", context);

    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Write a haiku"));
    expect(notify).not.toHaveBeenCalled();
  });

  it("preserves multi-turn role attribution", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const haiku = findPrompt(metadata, "haiku");
    const state = buildState(manager, metadata);
    const { context, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, haiku);
    await command.handler("", context);

    const sent = sendUserMessage.mock.calls[0]?.[0];
    assert.equal(typeof sent, "string");
    expect(sent).toContain("[user] Write a haiku about MCP.");
    expect(sent).toContain("[assistant] Bridges of context…");
  });

  it("surfaces prompt server errors as a notify, not a user message", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = findPrompt(metadata, "brief");
    const state = buildState(manager, metadata);
    const getPrompt = vi.spyOn(manager, "getPrompt");
    const { context, notify, sendUserMessage } = commandHost();

    const command = createPromptCommand(host.api, () => state, brief);
    await command.handler("server-error", context);

    expect(getPrompt).toHaveBeenCalledWith("real", "brief", { topic: "server-error" }, undefined);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('MCP prompt "brief" failed:'),
      "error",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Prompt backend unavailable"),
      "error",
    );
  });
});

describe("prompts capability negotiation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.closeAll()));
  });

  it("returns an empty prompt list for servers that omit the capability", async () => {
    // The stock elicitation fixture only advertises tools + resources, so
    // fetchAllPrompts short-circuits without hitting the wire.
    const elicitationFixture = fileURLToPath(
      new URL("./runtime/fixtures/elicitation-server.mjs", import.meta.url),
    );
    const manager = new McpServerManager();
    managers.push(manager);
    await manager.connect("elicit", { command: process.execPath, args: [elicitationFixture] });

    const connection = manager.getConnection("elicit");
    assert.ok(connection, "expected connected server");
    expect(connection.prompts).toEqual([]);
  });
});
