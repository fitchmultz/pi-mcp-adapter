import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestState } from "./test-state.ts";
import type { ServerConnection } from "../server-manager.ts";
import {
  MCP_STATUS_EVENT,
  createMcpStatusSnapshot,
  publishMcpStatusShutdown,
  publishMcpStatusSnapshot,
  type McpStatusEventBus,
} from "../mcp-status.ts";

const states: ReturnType<typeof createTestState>[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.owner.stop();
    await state.manager.closeAll();
  }
  vi.restoreAllMocks();
});

function createState() {
  const state = createTestState({
    config: {
      mcpServers: {
        connected: { command: "node", headers: { Authorization: "secret" } },
        cached: { command: "node" },
        failed: { command: "node" },
        auth: { url: "https://example.invalid" },
        idle: { command: "node" },
        disabled: { command: "node", disabled: true },
      },
    },
    toolMetadata: new Map([
      ["connected", [{ name: "search", originalName: "search", description: "" }]],
      [
        "cached",
        [
          { name: "cached_search", originalName: "cached_search", description: "" },
          {
            name: "read_doc",
            originalName: "read_doc",
            description: "",
            resourceUri: "docs://doc",
          },
        ],
      ],
      ["idle", [{ name: "old_search", originalName: "old_search", description: "" }]],
    ]),
    resourceCounts: new Map([
      ["connected", 2],
      ["cached", 1],
    ]),
    failureTracker: new Map([["failed", Date.now() - 4_000]]),
  });
  states.push(state);
  return state;
}

function createConnection(status: ServerConnection["status"]): ServerConnection {
  return {
    status,
    client: new Client({ name: "status-projection-test", version: "1" }),
    transport: InMemoryTransport.createLinkedPair()[0],
    definition: { command: "node" },
    tools: [],
    resources: [],
    prompts: [],
    inFlight: 0,
    lastUsedAt: Date.now(),
  };
}

describe("MCP status snapshots", () => {
  it("projects every status without connecting or exposing configuration", () => {
    const state = createState();
    const getConnection = vi.spyOn(state.manager, "getConnection").mockImplementation((name) => {
      if (name === "connected") {
        return {
          ...createConnection("connected"),
          tools: [{ name: "search", inputSchema: { type: "object" } }],
          resources: [
            { name: "doc", uri: "file://doc" },
            { name: "other", uri: "file://other" },
          ],
        };
      }
      if (name === "auth") {
        return createConnection("needs-auth");
      }
      return;
    });

    const snapshot = createMcpStatusSnapshot(state);
    expect(snapshot).toMatchObject({
      version: 1,
      totalTools: 3,
      totalResources: 3,
      connectedCount: 1,
      disabledCount: 1,
    });
    expect(snapshot.servers).toEqual(
      expect.arrayContaining([
        {
          name: "connected",
          status: "connected",
          toolCount: 1,
          resourceCount: 2,
          disabled: false,
          catalogKnown: true,
        },
        {
          name: "cached",
          status: "cached",
          toolCount: 1,
          resourceCount: 1,
          disabled: false,
          catalogKnown: true,
        },
        expect.objectContaining({
          name: "failed",
          status: "failed",
          toolCount: 0,
          disabled: false,
        }),
        { name: "auth", status: "needs-auth", toolCount: 0, disabled: false, catalogKnown: false },
        { name: "idle", status: "cached", toolCount: 1, disabled: false, catalogKnown: true },
        { name: "disabled", status: "disabled", toolCount: 0, disabled: true, catalogKnown: false },
      ]),
    );
    const failed = snapshot.servers.find((server) => server.name === "failed");
    expect(failed?.failedAgoSeconds).toBeGreaterThanOrEqual(4);
    expect(failed?.failedAgoSeconds).toBeLessThanOrEqual(5);
    expect(getConnection).toHaveBeenCalled();
    expect(snapshot).not.toHaveProperty("client");
    expect(snapshot).not.toHaveProperty("transport");
    expect(snapshot).not.toHaveProperty("config");
  });

  it("publishes an empty snapshot at shutdown", () => {
    const emit = vi.fn<McpStatusEventBus["emit"]>();
    publishMcpStatusShutdown({ emit });

    expect(emit).toHaveBeenCalledWith(MCP_STATUS_EVENT, {
      version: 1,
      servers: [],
      totalTools: 0,
      totalResources: 0,
      connectedCount: 0,
      disabledCount: 0,
    });
  });

  it("publishes fresh snapshots and isolates event listener failures", () => {
    const state = createState();
    const emitted: unknown[] = [];
    state.statusEvents = {
      emit: vi.fn<McpStatusEventBus["emit"]>((_channel, payload) => {
        emitted.push(payload);
        throw new Error("consumer failed");
      }),
    };

    expect(() => publishMcpStatusSnapshot(state)).not.toThrow();
    publishMcpStatusSnapshot(state);
    expect(state.statusEvents.emit).toHaveBeenCalledWith(MCP_STATUS_EVENT, emitted[0]);
    expect(emitted[0]).not.toBe(emitted[1]);
    const first = emitted[0];
    const second = emitted[1];
    assert(first !== null && typeof first === "object" && "servers" in first);
    assert(second !== null && typeof second === "object" && "servers" in second);
    expect(first.servers).not.toBe(second.servers);
  });
});
