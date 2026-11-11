import { describe, it, expect, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { connectSSE } from "./fixtures/strict-ui-boundaries-http.ts";
import { McpServerManager } from "../server-manager.ts";
import { startUiServer, type UiServerOptions, type UiServerHandle } from "../ui-server.ts";
import { ConsentManager } from "../consent-manager.ts";
import {
  UI_STREAM_HOST_CONTEXT_KEY,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  SERVER_STREAM_RESULT_PATCH_METHOD,
  getVisualizationStreamEnvelope,
  getUiStreamHostContext,
  serverStreamResultPatchNotificationSchema,
} from "../ui-stream-types.ts";
import { UiBoundaryWire, connectUiBoundaryWire } from "./fixtures/strict-ui-boundaries-wire.ts";
import type { UiResourceContent } from "../types.ts";
import { createTestState } from "./test-state.ts";
import { maybeStartUiSession, type UiSessionRequest } from "../ui-session.ts";

function createMockResource(): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test</h1>",
    mimeType: "text/html",
    meta: { permissions: {} },
  };
}

function createServerOptions(overrides: Partial<UiServerOptions> = {}): UiServerOptions {
  return {
    serverName: "test-server",
    toolName: "test_tool",
    toolArgs: { key: "value" },
    resource: createMockResource(),
    manager: new McpServerManager(),
    consentManager: new ConsentManager(),
    ...overrides,
  };
}

describe("UI Streaming", () => {
  describe("getUiStreamHostContext", () => {
    it("returns undefined for missing host context", () => {
      for (const context of [undefined, {}]) {
        expect(getUiStreamHostContext(context)).toBeUndefined();
      }
    });

    it("returns undefined for invalid stream context", () => {
      expect(getUiStreamHostContext({ [UI_STREAM_HOST_CONTEXT_KEY]: "invalid" })).toBeUndefined();
      expect(
        getUiStreamHostContext({ [UI_STREAM_HOST_CONTEXT_KEY]: { mode: "invalid" } }),
      ).toBeUndefined();
    });

    it("parses valid eager stream context", () => {
      const context = getUiStreamHostContext({
        [UI_STREAM_HOST_CONTEXT_KEY]: {
          mode: "eager",
          streamId: "abc-123",
          intermediateResultPatches: false,
          partialInput: false,
        },
      });
      expect(context).toEqual({
        mode: "eager",
        streamId: "abc-123",
        intermediateResultPatches: false,
        partialInput: false,
      });
    });

    it("parses valid stream-first context", () => {
      const context = getUiStreamHostContext({
        [UI_STREAM_HOST_CONTEXT_KEY]: {
          mode: "stream-first",
          streamId: "xyz-789",
          intermediateResultPatches: true,
          partialInput: false,
        },
      });
      expect(context).toEqual({
        mode: "stream-first",
        streamId: "xyz-789",
        intermediateResultPatches: true,
        partialInput: false,
      });
    });
  });

  describe("getVisualizationStreamEnvelope", () => {
    it("returns undefined for non-object input", () => {
      for (const value of [undefined, null, "string", []]) {
        expect(getVisualizationStreamEnvelope(value)).toBeUndefined();
      }
    });

    it("returns undefined when envelope key is missing", () => {
      expect(getVisualizationStreamEnvelope({})).toBeUndefined();
      expect(getVisualizationStreamEnvelope({ other: "data" })).toBeUndefined();
    });

    it("returns undefined for invalid envelope", () => {
      expect(
        getVisualizationStreamEnvelope({
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: { streamId: "abc" }, // missing required fields
        }),
      ).toBeUndefined();
    });

    it("parses valid envelope", () => {
      const envelope = getVisualizationStreamEnvelope({
        [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
          streamId: "stream-1",
          sequence: 0,
          frameType: "patch",
          phase: "shell",
          status: "ok",
        },
      });
      expect(envelope).toEqual({
        streamId: "stream-1",
        sequence: 0,
        frameType: "patch",
        phase: "shell",
        status: "ok",
      });
    });

    it("parses envelope with optional fields", () => {
      const envelope = getVisualizationStreamEnvelope({
        [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
          streamId: "stream-2",
          sequence: 5,
          frameType: "checkpoint",
          phase: "detail",
          status: "ok",
          message: "Checkpoint ready",
          spec: { kind: "mermaid" },
          checkpoint: { kind: "mermaid", code: "graph LR" },
        },
      });
      expect(envelope?.message).toBe("Checkpoint ready");
      expect(envelope?.spec).toEqual({ kind: "mermaid" });
      expect(envelope?.checkpoint).toEqual({ kind: "mermaid", code: "graph LR" });
    });
  });

  describe("McpServerManager stream listeners", () => {
    const peers: Array<{ wire: UiBoundaryWire; manager: McpServerManager }> = [];
    afterEach(async () => {
      for (const peer of peers) {
        await peer.manager.closeAll();
        await peer.wire.close();
      }
      peers.length = 0;
    });
    async function attachNotificationHandler(serverName = "test-server") {
      const wire = new UiBoundaryWire();
      const manager = await connectUiBoundaryWire(wire, serverName);
      peers.push({ wire, manager });
      return {
        manager,
        handleNotification: (notification: Parameters<UiBoundaryWire["notify"]>[0]) =>
          wire.notify(notification),
      };
    }

    it("routes notifications to the matching listener", async () => {
      const { manager, handleNotification } = await attachNotificationHandler("server-a");
      const listener = vi.fn<Parameters<McpServerManager["registerUiStreamListener"]>[1]>();

      manager.registerUiStreamListener("token-123", listener);
      const notification: Parameters<UiBoundaryWire["notify"]>[0] = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-123",
          result: { content: [{ type: "text", text: "patch" }] },
        },
      };

      await handleNotification(notification);

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      expect(listener).toHaveBeenCalledWith("server-a", notification.params);
    });

    it("does not call removed listeners", async () => {
      const { manager, handleNotification } = await attachNotificationHandler();
      const listener = vi.fn<Parameters<McpServerManager["registerUiStreamListener"]>[1]>();
      const delivered = vi.fn<Parameters<McpServerManager["registerUiStreamListener"]>[1]>();
      manager.registerUiStreamListener("barrier", delivered);

      manager.registerUiStreamListener("token-456", listener);
      manager.removeUiStreamListener("token-456");

      await handleNotification({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-456",
          result: { content: [{ type: "text", text: "patch" }] },
        },
      });

      await handleNotification({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: { streamToken: "barrier", result: { content: [] } },
      });
      await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps multiple listeners isolated by stream token", async () => {
      const { manager, handleNotification } = await attachNotificationHandler("server-b");
      const listener1 = vi.fn<Parameters<McpServerManager["registerUiStreamListener"]>[1]>();
      const listener2 = vi.fn<Parameters<McpServerManager["registerUiStreamListener"]>[1]>();

      manager.registerUiStreamListener("token-1", listener1);
      manager.registerUiStreamListener("token-2", listener2);

      await handleNotification({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-2",
          result: { content: [{ type: "text", text: "patch-2" }] },
        },
      });

      await vi.waitFor(() => expect(listener2).toHaveBeenCalledOnce());
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledWith("server-b", {
        streamToken: "token-2",
        result: { content: [{ type: "text", text: "patch-2" }] },
      });
    });
  });

  describe("UiServer SSE streaming", () => {
    let handle: UiServerHandle | null = null;

    afterEach(() => {
      if (handle) {
        handle.close("test-cleanup");
        handle = null;
      }
    });

    it("sends result-patch events with stream envelope", async () => {
      handle = await startUiServer(
        createServerOptions({
          hostContext: {
            [UI_STREAM_HOST_CONTEXT_KEY]: {
              mode: "stream-first",
              streamId: "test-stream",
              intermediateResultPatches: true,
              partialInput: false,
            },
          },
        }),
      );

      const events: Array<{ name: string; data: unknown; id?: string | undefined }> = [];
      const sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, data, id) => events.push({ name, data, id }),
      );

      // Send a result patch
      handle.sendResultPatch({
        content: [{ type: "text", text: "Streaming..." }],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "test-stream",
            sequence: 1,
            frameType: "patch",
            phase: "shell",
            status: "ok",
            message: "Building shell",
          },
        },
      });

      // Wait for event propagation
      await delay(50);
      sse.close();

      const patchEvents = events.filter((e) => e.name === "result-patch");
      expect(patchEvents).toHaveLength(1);

      const firstPatch = patchEvents[0];
      assert(firstPatch);
      assert(
        firstPatch.data !== null &&
          typeof firstPatch.data === "object" &&
          "structuredContent" in firstPatch.data,
      );
      const envelope = getVisualizationStreamEnvelope(firstPatch.data.structuredContent);
      expect(envelope?.frameType).toBe("patch");
      expect(envelope?.phase).toBe("shell");
    });

    it("assigns sequential event IDs", async () => {
      handle = await startUiServer(createServerOptions());

      const eventIds: string[] = [];
      const sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (_name, _data, id) => {
          if (id !== undefined && id !== "") {
            eventIds.push(id);
          }
        },
      );

      handle.sendResultPatch({ content: [] });
      handle.sendResultPatch({ content: [] });
      handle.sendResultPatch({ content: [] });

      await delay(50);
      sse.close();

      const ids = eventIds.map(Number).filter((n) => !Number.isNaN(n));
      expect(ids).toHaveLength(3);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? Number.NaN);
      }
    });

    it("replays events from Last-Event-ID", async () => {
      handle = await startUiServer(createServerOptions());

      // First connection to send some events
      const firstEvents: Array<{ name: string; id?: string | undefined }> = [];
      const sse1 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, _data, id) => firstEvents.push({ name, id }),
      );

      handle.sendResultPatch({ content: [{ type: "text", text: "patch-1" }] });
      handle.sendResultPatch({ content: [{ type: "text", text: "patch-2" }] });
      handle.sendResultPatch({ content: [{ type: "text", text: "patch-3" }] });

      await delay(50);
      sse1.close();

      // Get the ID of the first patch event
      const patchEvents = firstEvents.filter((e) => e.name === "result-patch");
      expect(patchEvents.length).toBe(3);
      const firstPatchId = patchEvents[0]?.id;
      expect(firstPatchId).toBeDefined();
      assert(firstPatchId !== undefined);

      // Second connection with Last-Event-ID should replay from that point
      const replayedEvents: Array<{ name: string; id?: string | undefined }> = [];
      const sse2 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, _data, id) => replayedEvents.push({ name, id }),
        { "Last-Event-ID": firstPatchId },
      );

      await delay(50);
      sse2.close();

      // Should replay events AFTER the provided ID
      const replayedPatches = replayedEvents.filter((e) => e.name === "result-patch");
      expect(replayedPatches.length).toBe(2); // patch-2 and patch-3
    });

    it("replays from latest checkpoint for fresh connections", async () => {
      handle = await startUiServer(createServerOptions());

      // Send patches and a checkpoint
      const sse1 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        () => {
          /* Initial connection only establishes the replay log. */
        },
      );

      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
            status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1",
            sequence: 1,
            frameType: "checkpoint",
            phase: "detail",
            status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "s1",
            sequence: 2,
            frameType: "patch",
            phase: "detail",
            status: "ok",
          },
        },
      });

      await delay(50);
      sse1.close();

      // Fresh connection (no Last-Event-ID) should start from checkpoint
      const freshEvents: Array<{ data: unknown }> = [];
      const sse2 = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (_name, data) => freshEvents.push({ data }),
      );

      await delay(50);
      sse2.close();

      // Should have replayed checkpoint and subsequent patches
      const envelopes = freshEvents
        .map(({ data }) => {
          assert(data !== null && typeof data === "object" && "structuredContent" in data);
          return getVisualizationStreamEnvelope(data.structuredContent);
        })
        .filter((envelope) => envelope !== undefined);

      expect(envelopes).toHaveLength(2);
      expect(envelopes.map((envelope) => envelope.frameType)).toEqual(["checkpoint", "patch"]);
    });

    it("tracks stream summary", async () => {
      handle = await startUiServer(
        createServerOptions({
          hostContext: {
            [UI_STREAM_HOST_CONTEXT_KEY]: {
              mode: "stream-first",
              streamId: "summary-test",
              intermediateResultPatches: true,
              partialInput: false,
            },
          },
        }),
      );

      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test",
            sequence: 0,
            frameType: "patch",
            phase: "shell",
            status: "ok",
          },
        },
      });
      handle.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test",
            sequence: 1,
            frameType: "patch",
            phase: "structure",
            status: "ok",
          },
        },
      });
      handle.sendToolResult({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: "summary-test",
            sequence: 2,
            frameType: "final",
            phase: "settled",
            status: "ok",
            message: "Complete",
          },
        },
      });

      const summary = handle.getStreamSummary();
      expect(summary).toBeDefined();
      expect(summary?.streamId).toBe("summary-test");
      expect(summary?.mode).toBe("stream-first");
      expect(summary?.frames).toBe(3);
      expect(summary?.phases).toContain("shell");
      expect(summary?.phases).toContain("structure");
      expect(summary?.phases).toContain("settled");
      expect(summary?.finalStatus).toBe("ok");
      expect(summary?.lastMessage).toBe("Complete");
    });
  });

  it("delivers opaque native notifications through fresh and reused session streams in order", async () => {
    vi.stubEnv("MCP_UI_VIEWER", "none");
    const wire = new UiBoundaryWire();
    const manager = await connectUiBoundaryWire(wire);
    const state = createTestState({
      manager,
      config: { mcpServers: { "test-server": wire.definition() }, settings: {} },
    });
    const events: Array<{ name: string; data: unknown }> = [];
    let sse: Awaited<ReturnType<typeof connectSSE>> | undefined;
    try {
      const request = {
        serverName: "test-server",
        toolName: "some_tool",
        toolArgs: { graph: "fresh" },
        uiResourceUri: "ui://test/widget",
        streamMode: "stream-first",
      } satisfies UiSessionRequest;
      const fresh = await maybeStartUiSession(state, request);
      assert(fresh);
      assert(fresh.streamId !== undefined && fresh.streamId !== "");
      assert(fresh.streamToken !== undefined && fresh.streamToken !== "");
      const handle = state.uiServer;
      assert(handle);
      sse = await connectSSE(
        `http://localhost:${handle.port}/events?session=${handle.sessionToken}`,
        (name, data) => {
          events.push({ name, data });
        },
      );
      const opaque = { content: [{ type: "vendor-block", data: { accepted: true } }] };
      await wire.notify({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: { streamToken: fresh.streamToken, result: opaque },
      });
      await expect.poll(() => events.length).toBe(1);
      expect(events[0]).toEqual({
        name: "result-patch",
        data: {
          ...opaque,
          structuredContent: {
            [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
              frameType: "final",
              phase: "settled",
              status: "ok",
              streamId: fresh.streamId,
              sequence: 1,
            },
          },
        },
      });
      const reused = await maybeStartUiSession(state, {
        ...request,
        toolArgs: { graph: "reused" },
      });
      assert(reused);
      assert(reused.streamId !== undefined && reused.streamId !== "");
      assert(reused.streamToken !== undefined && reused.streamToken !== "");
      expect(reused.reused).toBe(true);
      expect(state.uiServer).toBe(handle);
      await wire.notify({
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: reused.streamToken,
          result: { structuredContent: { selected: "node" } },
        },
      });
      await expect.poll(() => events.length).toBe(3);
      expect(events[2]).toEqual({
        name: "result-patch",
        data: {
          structuredContent: {
            selected: "node",
            [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
              frameType: "final",
              phase: "settled",
              status: "ok",
              streamId: reused.streamId,
              sequence: 1,
            },
          },
        },
      });
      reused.close("call-complete");
      expect(reused.isActive()).toBe(false);
      expect(fresh.isActive()).toBe(true);
      expect(
        (await fetch(`http://localhost:${handle.port}/health?session=${handle.sessionToken}`))
          .status,
      ).toBe(200);
      const sendResult = fresh.sendToolResult;
      sendResult({ content: [{ type: "text", text: "settled" }] });
      await expect.poll(() => events.length).toBe(4);
      expect(events.map((entry) => entry.name)).toEqual([
        "result-patch",
        "tool-input",
        "result-patch",
        "tool-result",
      ]);
      // A server that labels its result frame "patch" must not leave the stream unterminated.
      fresh.sendResultPatch({
        content: [],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: fresh.streamId,
            sequence: 3,
            frameType: "patch",
            phase: "detail",
            status: "ok",
          },
        },
      });
      fresh.sendToolResult({
        content: [{ type: "text", text: "settled" }],
        structuredContent: {
          [UI_STREAM_STRUCTURED_CONTENT_KEY]: {
            streamId: fresh.streamId,
            sequence: 4,
            frameType: "patch",
            phase: "detail",
            status: "ok",
          },
        },
      });
      await expect.poll(() => events.length).toBe(6);
      const terminal = events[5];
      assert(terminal !== undefined);
      assert(
        terminal.data !== null &&
          typeof terminal.data === "object" &&
          "structuredContent" in terminal.data,
      );
      expect(getVisualizationStreamEnvelope(terminal.data.structuredContent)).toMatchObject({
        frameType: "final",
        phase: "detail",
        sequence: 4,
      });
      const close = handle.close;
      close("stream-finished");
      expect(state.completedUiSessions[0]?.stream).toMatchObject({
        streamId: fresh.streamId,
        mode: "stream-first",
        frames: 5,
      });
    } finally {
      sse?.close();
      state.uiServer?.close("test-cleanup");
      await manager.closeAll();
      await wire.close();
      vi.unstubAllEnvs();
    }
  });

  describe("Server stream result patch notification schema", () => {
    it("validates correct notification format", () => {
      const notification: Parameters<UiBoundaryWire["notify"]>[0] = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          streamToken: "token-123",
          result: {
            content: [{ type: "text", text: "test" }],
            structuredContent: { data: "value" },
          },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(true);
    });

    it("rejects notification with wrong method", () => {
      const notification = {
        method: "wrong/method",
        params: {
          streamToken: "token-123",
          result: { content: [] },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(false);
    });

    it("rejects notification with missing streamToken", () => {
      const notification = {
        method: SERVER_STREAM_RESULT_PATCH_METHOD,
        params: {
          result: { content: [] },
        },
      };

      const parsed = serverStreamResultPatchNotificationSchema.safeParse(notification);
      expect(parsed.success).toBe(false);
    });
  });
});
