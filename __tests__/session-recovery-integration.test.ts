import assert from "node:assert/strict";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { ServerConnection } from "../server-manager.ts";
import { executeCall } from "../proxy-modes.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { withSessionRecovery } from "../session-recovery.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { firstText } from "./fixtures/proxy-runtime.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  machineResult,
  readMachineBody,
} from "./fixtures/oauth-machine-wire.ts";

let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
beforeAll(async () => {
  host = await createTestExtensionContext();
});
afterAll(async () => {
  await host.dispose();
});

async function recoveryFixture(kind: "terminated" | "uninitialized", repeat = false) {
  let sessions = 0;
  const toolCallSessionIds: string[] = [];
  const http = new MachineHttpServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    if (message.method === "initialize") {
      response.setHeader("Mcp-Session-Id", `session-${++sessions}`);
    }
    if (message.method === "tools/call") {
      const session = request.headers["mcp-session-id"];
      toolCallSessionIds.push(Array.isArray(session) ? (session[0] ?? "") : (session ?? ""));
      if (toolCallSessionIds.length === 1 || repeat) {
        if (kind === "terminated") {
          machineJson(response, { error: "Session not found" }, 404);
        } else {
          machineJson(
            response,
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "Bad Request: Server not initialized" },
            },
            400,
          );
        }
        return;
      }
      machineJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: false, content: [{ type: "text", text: "ok" }] },
      });
      return;
    }
    const result =
      message.method === "tools/list"
        ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] }
        : machineResult(message.method, "stale-session", "ok");
    machineJson(response, { jsonrpc: "2.0", id: message.id, result });
  });
  const origin = await http.listen();
  const definition = { url: `${origin}/mcp`, protocolVersion: "legacy" as const };
  const state = createTestState({ config: { settings: {}, mcpServers: { demo: definition } } });
  onTestFinished(async () => {
    await state.owner.stop();
    await state.manager.closeAll();
    await http.close();
    vi.restoreAllMocks();
  });
  const stale = await state.manager.connect("demo", definition);
  const staleCall = vi.spyOn(stale.client, "callTool");
  let freshCall: MockInstance<Client["callTool"]> | undefined;
  const original = state.manager.reconnect.bind(state.manager);
  const reconnect = vi
    .spyOn(state.manager, "reconnect")
    .mockImplementation(async (name, entry, previous, signal) => {
      const fresh = await original(name, entry, previous, signal);
      freshCall = vi.spyOn(fresh.client, "callTool");
      return fresh;
    });
  return {
    state,
    toolCallSessionIds,
    stale,
    staleCall,
    reconnect,
    freshCall: () => {
      assert.ok(freshCall);
      return freshCall;
    },
  };
}

async function directCall(
  state: ReturnType<typeof createTestState>,
  args: Record<string, unknown>,
) {
  return createDirectToolExecutor(
    () => state,
    () => null,
    {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    },
  )("id", args, undefined, undefined, host.runner.createToolContext("id", state.owner.signal));
}
function assertOneRecovery(fixture: Awaited<ReturnType<typeof recoveryFixture>>): void {
  expect(fixture.staleCall).toHaveBeenCalledTimes(1);
  expect(fixture.freshCall()).toHaveBeenCalledTimes(1);
  expect(fixture.reconnect).toHaveBeenCalledTimes(1);
}
function assertRecoveryArguments(fixture: Awaited<ReturnType<typeof recoveryFixture>>): void {
  const signal: unknown = expect.any(AbortSignal);
  expect(fixture.reconnect).toHaveBeenCalledWith(
    "demo",
    fixture.state.config.mcpServers.demo,
    fixture.stale,
    signal,
  );
}

describe("session recovery — Streamable HTTP wire path", () => {
  it("recovers a JSON-RPC server-not-initialized response from the SDK transport", async () => {
    const fixture = await recoveryFixture("uninitialized");
    const result = await withSessionRecovery(
      { manager: fixture.state.manager, config: fixture.state.config },
      "demo",
      (connection: ServerConnection) =>
        connection.client.callTool({ name: "search", arguments: {} }),
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(fixture.toolCallSessionIds.length).toBe(2);
    expect(fixture.toolCallSessionIds).toHaveLength(2);
    expect(fixture.toolCallSessionIds[0]).not.toBe(fixture.toolCallSessionIds[1]);
  });
});

describe("session recovery — proxy path (proxy-modes.ts executeCall)", () => {
  it.each([
    {
      label: "recovers a terminated Streamable HTTP session transparently mid tool-call",
      kind: "terminated" as const,
    },
    {
      label: "recovers a server-not-initialized MCP error transparently mid tool-call",
      kind: "uninitialized" as const,
    },
  ])("$label", async ({ kind }) => {
    const fixture = await recoveryFixture(kind);
    const result = await executeCall(fixture.state, {
      toolName: "demo_search",
      args: { q: "hello" },
      serverOverride: "demo",
    });
    assertOneRecovery(fixture);
    assertRecoveryArguments(fixture);
    expect(firstText(result)).toContain("ok");
  });
  it.each([
    {
      label:
        "gives up after one reconnect attempt: a second server-not-initialized MCP error propagates as call_failed",
      kind: "uninitialized" as const,
    },
    {
      label:
        "gives up after one reconnect attempt: a second terminated session propagates as call_failed",
      kind: "terminated" as const,
    },
  ])("$label", async ({ kind }) => {
    const fixture = await recoveryFixture(kind, true);
    const result = await executeCall(fixture.state, {
      toolName: "demo_search",
      args: {},
      serverOverride: "demo",
    });
    assertOneRecovery(fixture);
    expect(result.details).toMatchObject({ mode: "call", error: "call_failed" });
  });
});

describe("session recovery — direct-tools path (direct-tools.ts createDirectToolExecutor)", () => {
  it.each([
    {
      label: "recovers a terminated Streamable HTTP session transparently for a direct tool call",
      kind: "terminated" as const,
    },
    {
      label: "recovers a server-not-initialized MCP error transparently for a direct tool call",
      kind: "uninitialized" as const,
    },
  ])("$label", async ({ kind }) => {
    const fixture = await recoveryFixture(kind);
    const result = await directCall(fixture.state, { q: "hello" });
    assertOneRecovery(fixture);
    assertRecoveryArguments(fixture);
    expect(firstText(result)).toContain("ok");
  });
  it("gives up after one reconnect attempt: a second terminated session propagates as call_failed", async () => {
    const fixture = await recoveryFixture("terminated", true);
    const result = await directCall(fixture.state, {});
    assertOneRecovery(fixture);
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
  });
});
