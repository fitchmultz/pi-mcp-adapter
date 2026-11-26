import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import {
  JSONRPCRequestSchema,
  SubscriptionsListenRequestSchema,
  type ServerCapabilitiesSchema,
} from "@modelcontextprotocol/core";
import type { z } from "zod";
import { logger } from "../../logger.ts";
import { loadMetadataCache } from "../../metadata-cache.ts";
import { PRIOR_DISCOVERY_LEGACY_TTL_MS } from "../../prior-discovery.ts";
import { McpServerManager } from "../../server-manager.ts";
import { createActivationFixture } from "../fixtures/strict-activation-boundaries.ts";
import { MachineHttpServer, machineJson, readMachineBody } from "../fixtures/oauth-machine-wire.ts";

interface HttpTestHarness {
  url: string;
  methods: string[];
  mode: "modern" | "legacy";
  toolNames: string[];
  failResourcesList: boolean;
  capabilities: z.infer<typeof ServerCapabilitiesSchema>;
  subscriptionCount: () => number;
  notifyToolsListChanged: () => void;
  dropSubscriptionAbruptly: () => void;
  closeSubscriptionGracefully: () => void;
  close: () => Promise<void>;
}

async function createHttpHarness(options?: {
  capabilities?: z.infer<typeof ServerCapabilitiesSchema>;
  failResourcesList?: boolean;
}): Promise<HttpTestHarness> {
  const methods: string[] = [];
  let mode: "modern" | "legacy" = "modern";
  let toolNames = ["initial_tool"];
  let failResourcesList = options?.failResourcesList === true;
  const capabilities: z.infer<typeof ServerCapabilitiesSchema> = options?.capabilities ?? {
    tools: { listChanged: true },
    resources: {},
    prompts: {},
  };
  let activeStream: ServerResponse | undefined;
  let activeSubId: string | number | undefined;
  let subscriptions = 0;
  let legacyInitialized = false;

  function buildResult(method: string): Record<string, unknown> {
    const complete =
      mode === "modern" ? { resultType: "complete", ttlMs: 1000, cacheScope: "private" } : {};
    switch (method) {
      case "tools/list":
        return {
          ...complete,
          tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
        };
      case "resources/list":
        return { ...complete, resources: [] };
      case "prompts/list":
        return { ...complete, prompts: [] };
      default:
        return {
          ...(mode === "modern" ? { resultType: "complete" } : {}),
          content: [{ type: "text", text: "ok" }],
        };
    }
  }

  function respondToRequest(
    body: z.infer<typeof JSONRPCRequestSchema>,
    response: ServerResponse,
  ): void {
    if (body.method === "server/discover") {
      machineJson(
        response,
        mode === "legacy"
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }
          : {
              jsonrpc: "2.0",
              id: body.id,
              result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities },
            },
      );
      return;
    }
    if (body.method === "initialize") {
      legacyInitialized = false;
      machineJson(response, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities,
          serverInfo: { name: "harness", version: "1.0.0" },
        },
      });
      return;
    }
    if (mode === "legacy" && !legacyInitialized) {
      machineJson(
        response,
        { jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Server not initialized" } },
        400,
      );
      return;
    }
    if (body.method === "subscriptions/listen") {
      const sub = SubscriptionsListenRequestSchema.parse(body);
      subscriptions++;
      activeStream = response;
      activeSubId = body.id;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: sub.params.notifications,
            _meta: { [SUBSCRIPTION_ID_META_KEY]: body.id },
          },
        })}\n\n`,
      );
      return;
    }
    if (body.method === "resources/list" && failResourcesList) {
      machineJson(response, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32603, message: "resources temporarily unavailable" },
      });
      return;
    }
    machineJson(response, { jsonrpc: "2.0", id: body.id, result: buildResult(body.method) });
  }

  const server = new MachineHttpServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const raw: unknown = JSON.parse(await readMachineBody(request));
    if (typeof raw === "object" && raw !== null && !("id" in raw)) {
      if ("method" in raw && raw.method === "notifications/initialized") {
        methods.push("notifications/initialized");
        legacyInitialized = true;
      }
      response.writeHead(202).end();
      return;
    }
    const body = JSONRPCRequestSchema.parse(raw);
    methods.push(body.method);
    respondToRequest(body, response);
  });

  const origin = await server.listen();
  return {
    url: `${origin}/mcp`,
    methods,
    get mode() {
      return mode;
    },
    set mode(next) {
      mode = next;
      legacyInitialized = false;
    },
    get toolNames() {
      return toolNames;
    },
    set toolNames(next) {
      toolNames = next;
    },
    get failResourcesList() {
      return failResourcesList;
    },
    set failResourcesList(next) {
      failResourcesList = next;
    },
    capabilities,
    subscriptionCount: () => subscriptions,
    notifyToolsListChanged: () => {
      assert.ok(activeStream && activeSubId !== undefined, "Expected active subscription stream");
      activeStream.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: activeSubId } },
        })}\n\n`,
      );
    },
    dropSubscriptionAbruptly: () => {
      assert.ok(activeStream, "Expected active subscription stream");
      const current = activeStream;
      activeStream = undefined;
      current.destroy();
    },
    closeSubscriptionGracefully: () => {
      assert.ok(activeStream && activeSubId !== undefined, "Expected active subscription stream");
      const current = activeStream;
      const id = activeSubId;
      activeStream = undefined;
      current.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n\n`,
      );
    },
    close: async () => {
      activeStream?.destroy();
      await server.close();
    },
  };
}

describe("MCP-213 cold-start performance, PriorDiscovery, and subscription resilience", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.restoreAllMocks();
  });

  it("skips redundant server/discover RTT across reconnects and sessions while retaining list_changed", async () => {
    const harness = await createHttpHarness();
    cleanups.push(harness.close);
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = { url: harness.url, auth: false as const };

    const first = await manager.connect("modern-srv", definition);
    expect(first.status).toBe("connected");
    expect(first.priorDiscovery?.kind).toBe("modern");
    expect(harness.methods.filter((method) => method === "server/discover")).toHaveLength(1);
    await expect.poll(harness.subscriptionCount).toBe(1);

    await manager.close("modern-srv");
    const second = await manager.connect("modern-srv", definition);
    expect(second.status).toBe("connected");
    expect(second.priorDiscovery?.kind).toBe("modern");
    expect(harness.methods.filter((method) => method === "server/discover")).toHaveLength(1);
    await expect.poll(harness.subscriptionCount).toBe(2);

    harness.toolNames = ["post_prior_tool"];
    harness.notifyToolsListChanged();
    await expect.poll(() => second.tools.map((tool) => tool.name)).toEqual(["post_prior_tool"]);

    // Verify metadata-cache persistence across fresh initializeMcp sessions.
    const host = await createActivationFixture();
    cleanups.push(() => host.dispose());
    const config = {
      mcpServers: {
        cachedSrv: { url: harness.url, auth: false as const, lifecycle: "eager" as const },
      },
      settings: {},
    };
    const session1 = await host.initialize({ config });
    expect(session1.manager.getConnection("cachedSrv")?.priorDiscovery?.kind).toBe("modern");
    expect(loadMetadataCache()?.servers.cachedSrv?.priorDiscovery?.kind).toBe("modern");
    const discoverAfterSession1 = harness.methods.filter(
      (method) => method === "server/discover",
    ).length;
    await session1.owner.stop("session 1 done");

    const session2 = await host.initialize({ config });
    expect(session2.manager.getConnection("cachedSrv")?.status).toBe("connected");
    expect(harness.methods.filter((method) => method === "server/discover")).toHaveLength(
      discoverAfterSession1,
    );
  });

  it("recovers from stale PriorDiscovery on downgrade, caches legacy, and re-probes after legacy TTL expiry", async () => {
    const harness = await createHttpHarness({ capabilities: { tools: {} } });
    cleanups.push(harness.close);
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());
    const definition = { url: harness.url, auth: false as const };

    const modern = await manager.connect("evolving", definition);
    expect(modern.priorDiscovery?.kind).toBe("modern");
    await manager.close("evolving");

    // Server downgrades to 2025-era legacy: stale modern prior fails on tools/list and recovers fresh.
    harness.mode = "legacy";
    const downgraded = await manager.connect("evolving", definition);
    expect(downgraded.status).toBe("connected");
    expect(downgraded.priorDiscovery?.kind).toBe("legacy");
    const discoversAfterDowngrade = harness.methods.filter(
      (method) => method === "server/discover",
    ).length;
    expect(discoversAfterDowngrade).toBe(2);
    expect(harness.methods.filter((method) => method === "initialize")).toHaveLength(1);

    // Next connect to legacy server skips server/discover completely.
    await manager.close("evolving");
    const cachedLegacy = await manager.connect("evolving", definition);
    expect(cachedLegacy.status).toBe("connected");
    expect(cachedLegacy.priorDiscovery?.kind).toBe("legacy");
    expect(harness.methods.filter((method) => method === "server/discover")).toHaveLength(
      discoversAfterDowngrade,
    );
    expect(harness.methods.filter((method) => method === "initialize")).toHaveLength(2);

    // Expired legacy prior (> 24h) re-probes server/discover and picks up an upgraded modern server.
    await manager.close("evolving");
    harness.mode = "modern";
    manager.invalidatePriorDiscovery("evolving");
    manager.seedPriorDiscovery("evolving", definition, {
      kind: "legacy",
      cachedAt: Date.now() - PRIOR_DISCOVERY_LEGACY_TTL_MS - 1_000,
    });
    const upgraded = await manager.connect("evolving", definition);
    expect(upgraded.priorDiscovery?.kind).toBe("modern");
    expect(harness.methods.filter((method) => method === "server/discover")).toHaveLength(
      discoversAfterDowngrade + 1,
    );
  });

  it(
    "coalesces list_changed bursts via debounceMs and recovers across stable-open remote drops",
    { timeout: 15_000 },
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      cleanups.push(async () => {
        process.off("unhandledRejection", onUnhandled);
      });

      const debugSpy = vi.spyOn(logger, "debug");
      const harness = await createHttpHarness();
      cleanups.push(harness.close);
      const manager = new McpServerManager();
      cleanups.push(() => manager.closeAll());

      const connection = await manager.connect("burst", { url: harness.url, auth: false });
      await expect.poll(harness.subscriptionCount).toBe(1);
      const initialToolsListCalls = harness.methods.filter(
        (method) => method === "tools/list",
      ).length;

      // Emit 5 rapid list_changed notifications; debounceMs (250ms) must coalesce into 1 refresh.
      harness.toolNames = ["debounced_tool"];
      for (let i = 0; i < 5; i++) {
        harness.notifyToolsListChanged();
      }
      await expect
        .poll(() => connection.tools.map((tool) => tool.name))
        .toEqual(["debounced_tool"]);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 350);
      });
      expect(harness.methods.filter((method) => method === "tools/list")).toHaveLength(
        initialToolsListCalls + 1,
      );

      // Unexpected remote closes reset the retry budget after a stable open (>= 1s),
      // so more than 3 independent remote drops over the connection lifetime keep recovering.
      for (let drop = 1; drop <= 3; drop++) {
        harness.dropSubscriptionAbruptly();
        await expect.poll(harness.subscriptionCount, { timeout: 2_500 }).toBe(1 + drop);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100);
      });
      harness.dropSubscriptionAbruptly();
      await expect.poll(harness.subscriptionCount, { timeout: 2_500 }).toBe(5);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("list_changed subscription closed (remote)"),
      );

      harness.toolNames = ["recovered_tool"];
      harness.notifyToolsListChanged();
      await expect
        .poll(() => connection.tools.map((tool) => tool.name))
        .toEqual(["recovered_tool"]);

      // Graceful server close logs debug diagnostic without spurious re-listen.
      harness.closeSubscriptionGracefully();
      await expect
        .poll(() =>
          debugSpy.mock.calls.some(
            ([msg]) =>
              typeof msg === "string" &&
              msg.includes("list_changed subscription closed (graceful)"),
          ),
        )
        .toBe(true);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });
      expect(harness.subscriptionCount()).toBe(5);
      expect(unhandled).toEqual([]);
    },
  );

  it(
    "stops re-listening after bounded retries when a server repeatedly acks and drops immediately",
    { timeout: 15_000 },
    async () => {
      const harness = await createHttpHarness();
      cleanups.push(harness.close);
      const manager = new McpServerManager();
      cleanups.push(() => manager.closeAll());

      await manager.connect("flapping", { url: harness.url, auth: false });
      await expect.poll(harness.subscriptionCount).toBe(1);

      // 3 rapid ack-then-drop cycles exhaust the bounded 3-attempt retry budget (1 initial + 3 re-listens = 4).
      for (let drop = 1; drop <= 3; drop++) {
        harness.dropSubscriptionAbruptly();
        await expect.poll(harness.subscriptionCount, { timeout: 2_500 }).toBe(1 + drop);
      }
      // 4th immediate drop without a stable open window must NOT trigger another re-listen.
      harness.dropSubscriptionAbruptly();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_250);
      });
      expect(harness.subscriptionCount()).toBe(4);
    },
  );

  it("bootstraps uncached directTools servers concurrently without waiting on slow eager servers", async () => {
    const host = await createActivationFixture();
    cleanups.push(() => host.dispose());
    const slowEager = await host.wire();
    const fastDirect = await host.wire();
    slowEager.delay("tools/list");

    const initialization = host.initialize({
      config: {
        mcpServers: {
          slowEager: { ...slowEager.definition, lifecycle: "eager" },
          fastDirect: { ...fastDirect.definition, lifecycle: "lazy", directTools: true },
        },
        settings: {},
      },
    });

    await expect.poll(slowEager.started).toBe(true);
    // fastDirect must complete discovery while slowEager is still blocked on tools/list.
    await expect
      .poll(() =>
        host.ui.notify.mock.calls.some(
          ([message]) =>
            typeof message === "string" && message.includes("tools discovered for fastDirect"),
        ),
      )
      .toBe(true);
    expect(fastDirect.methods).toContain("tools/list");

    slowEager.release();
    const state = await initialization;
    expect(state.toolMetadata.get("fastDirect")).toEqual([
      expect.objectContaining({ originalName: "echo" }),
    ]);
    expect(state.toolMetadata.get("slowEager")).toEqual([
      expect.objectContaining({ originalName: "echo" }),
    ]);
  });

  it("logs non-abort resources/list errors via logger.debug while keeping the server connected", async () => {
    const debugSpy = vi.spyOn(logger, "debug");
    const harness = await createHttpHarness({
      capabilities: { tools: {}, resources: {} },
      failResourcesList: true,
    });
    cleanups.push(harness.close);
    const manager = new McpServerManager();
    cleanups.push(() => manager.closeAll());

    const connection = await manager.connect("res-fail", { url: harness.url, auth: false });
    expect(connection.status).toBe("connected");
    expect(connection.tools.map((tool) => tool.name)).toEqual(["initial_tool"]);
    expect(connection.resources).toEqual([]);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/resources\/list failed:.*resources temporarily unavailable/),
    );
  });
});
