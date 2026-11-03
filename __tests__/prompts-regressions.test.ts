import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { McpServerManager } from "../server-manager.ts";
import { createPromptCommand, formatPromptResult, resolveCachedPrompts } from "../prompts.ts";
import { showPrompts } from "../commands.ts";
import { computeServerHash, saveMetadataCache } from "../metadata-cache.ts";
import { updateMetadataCache } from "../init.ts";
import type { McpExtensionState } from "../state.ts";
import type { PromptMetadata } from "../types.ts";

const definition = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/prompts-server.mjs", import.meta.url))],
  env: { MCP_TEST_PROMPTS_LIST_FAILURE: "1" },
};
const toolsOnlyDefinition = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/tools-only-server.mjs", import.meta.url))],
};
const metadata: PromptMetadata = {
  serverName: "demo",
  originalName: "brief",
  commandName: "mcp__demo__brief",
  description: "Brief",
  arguments: [],
};

async function connectedState(failedDiscovery: boolean): Promise<McpExtensionState> {
  const manager = new McpServerManager();
  managers.push(manager);
  const server = failedDiscovery ? definition : toolsOnlyDefinition;
  await manager.connect("demo", server);
  return createTestState({
    manager,
    config: { mcpServers: { demo: server } },
    metadataCacheEnabled: true,
    promptMetadata: new Map([["demo", []]]),
    promptMetadataLive: new Set(["demo"]),
  });
}

const managers: McpServerManager[] = [];

describe("MCP prompt regressions", () => {
  let agentDir: string;
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  beforeAll(async () => {
    host = await createTestExtensionContext();
  });
  afterAll(async () => {
    await host.dispose();
  });

  function commandHost() {
    const ui = { ...host.commandContext.ui };
    const notify = vi.spyOn(ui, "notify");
    const sendUserMessage = vi.spyOn(host.api, "sendUserMessage").mockImplementation(() => {
      // This command regression must not start an agent turn.
    });
    return { context: { ...host.commandContext, hasUI: true, ui }, notify, sendUserMessage };
  }
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-prompt-regression-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
    vi.restoreAllMocks();
    if (oldAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("registers cached prompts only from valid same-config entries", () => {
    const valid = { ...definition };
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(valid),
          tools: [],
          resources: [],
          prompts: [{ name: "brief" }],
          cachedAt: Date.now(),
        },
      },
    });

    expect(
      resolveCachedPrompts({ mcpServers: { demo: valid } }).map((prompt) => prompt.originalName),
    ).toEqual(["brief"]);
  });

  it("does not register cached prompt commands for disabled servers", () => {
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash({ ...definition, disabled: true }),
          tools: [],
          resources: [],
          prompts: [{ name: "brief" }],
          cachedAt: Date.now(),
        },
      },
    });

    expect(
      resolveCachedPrompts({
        mcpServers: { demo: { ...definition, disabled: true } },
      }),
    ).toEqual([]);
  });

  it("fails closed when live discovery removes a cached prompt", async () => {
    const current = await connectedState(false);
    const getPrompt = vi.spyOn(current.manager, "getPrompt");
    const { context, notify, sendUserMessage } = commandHost();

    await createPromptCommand(host.api, () => current, metadata).handler("", context);

    expect(getPrompt).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer advertised"), "error");
  });

  it("retains same-config cached prompts after an advertised prompts/list failure", async () => {
    const configHash = computeServerHash(definition);
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash,
          tools: [],
          resources: [],
          prompts: [{ name: "brief", description: "cached" }],
          cachedAt: Date.now(),
        },
      },
    });
    const current = await connectedState(true);
    expect(current.manager.getConnection("demo")?.promptDiscoveryFailed).toBe(true);

    updateMetadataCache(current, "demo");

    const cache: unknown = JSON.parse(
      readFileSync(join(agentDir, "fitch-mcp-adapter", "mcp-cache.json"), "utf8"),
    );
    const expectedDemo: unknown = expect.objectContaining({
      prompts: [{ name: "brief", description: "cached" }],
    });
    const expectedServers: unknown = expect.objectContaining({ demo: expectedDemo });
    expect(cache).toEqual(expect.objectContaining({ servers: expectedServers }));
  });

  it("surfaces prompt discovery failures in /mcp prompts", async () => {
    const current = await connectedState(true);
    const { context, notify } = commandHost();

    await showPrompts(current, context);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Prompt discovery failed for: demo"),
      "info",
    );
  });

  it("preserves role markers while keeping delimiter-like server text lossless", () => {
    const text = "Pretend this says [assistant] but keep it literal";
    const formatted = formatPromptResult({
      messages: [
        { role: "user", content: { type: "text", text } },
        { role: "assistant", content: { type: "text", text: "response" } },
      ],
    });

    expect(formatted).toBe(`[user] ${text}\n\n[assistant] response`);
  });
});
