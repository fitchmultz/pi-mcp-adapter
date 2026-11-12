import assert from "node:assert/strict";
import { setImmediate as nextImmediate } from "node:timers/promises";
import {
  initTheme,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { ElicitResultSchema } from "@modelcontextprotocol/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../../index.ts";
import { initializeMcp } from "../../init.ts";
import { createMcpRuntimeOwner } from "../../runtime-owner.ts";
import { getAuthForUrl, updateTokens } from "../../mcp-auth.ts";
import { McpTraceWriter } from "../../mcp-trace.ts";
import { McpOAuthProvider } from "../../mcp-oauth-provider.ts";
import { executeCall } from "../../proxy-modes.ts";
import type { McpConfig } from "../../types.ts";
import { createLifecycleHost, requireValue } from "../fixtures/extension-lifecycle.ts";
import {
  createCallbackHttpFixture,
  elicitationRequest,
  samplingRequest,
  type CallbackFixtureOptions,
} from "./fixtures/callback-http.ts";

vi.mock("open", () => ({
  default: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(() => {
  initTheme();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-callback-lifetime-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function samplingResponse(text = "SYNTHETIC-SAMPLE"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "synthetic",
    model: "synthetic",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function host() {
  const native = await createLifecycleHost();
  cleanups.push(async () => {
    await native.dispose();
    assert.deepEqual(native.errors, []);
  });
  const model: Model<"openai-completions"> = {
    id: "synthetic",
    provider: "synthetic",
    name: "Synthetic local fixture",
    api: "openai-completions",
    baseUrl: "https://synthetic.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  const ui = {
    ...native.runner.getUIContext(),
    setStatus: vi.fn<ExtensionUIContext["setStatus"]>(),
    notify: vi.fn<ExtensionUIContext["notify"]>(),
    confirm: vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true),
    select: vi
      .fn<ExtensionUIContext["select"]>()
      .mockImplementation(async (title) => (title.startsWith("Review") ? "Submit" : "Continue")),
    input: vi.fn<ExtensionUIContext["input"]>().mockResolvedValue("synthetic"),
  };
  const nativeContext = native.runner.createContext();
  vi.spyOn(nativeContext.modelRegistry, "getAvailable").mockReturnValue([model]);
  vi.spyOn(nativeContext.modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true });
  const complete = vi
    .spyOn(nativeContext.modelRegistry, "complete")
    .mockResolvedValue(samplingResponse());
  const ctx: ExtensionContext = {
    ...nativeContext,
    cwd: directory,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    model,
    ui,
  };
  return { ...native, pi: native.api, ctx, ui, complete };
}

async function wire(options: CallbackFixtureOptions = {}) {
  const fixture = await createCallbackHttpFixture(directory, options);
  cleanups.push(fixture.close);
  return fixture;
}

async function runtime(config: McpConfig, suppliedHost?: Awaited<ReturnType<typeof host>>) {
  const h = suppliedHost ?? (await host());
  const owner = createMcpRuntimeOwner();
  const state = await initializeMcp(h.pi, h.ctx, owner, { config });
  cleanups.push(() => owner.stop());
  for (const [name, definition] of Object.entries(config.mcpServers)) {
    await state.manager.connect(name, definition);
  }
  return state;
}

it("joins refresh persistence and reconstructs a new client without replaying calls", async () => {
  const f = await wire({ oauth: true });
  const state = await runtime(f.config);
  f.expire();
  f.delay("token");
  const pending = requireValue(state.manager.getConnection(f.name)).client.callTool({
    name: "echo",
    arguments: {},
  });
  await expect.poll(f.started).toBe(true);
  f.release();
  await pending;
  expect(getAuthForUrl({ serverName: f.name, serverUrl: f.url })?.tokens?.refreshToken).toBe(
    "SYNTHETIC-REFRESH-UPDATED",
  );
  await state.owner.stop();
  const before = f.calls();
  const restored = await runtime(f.config);
  expect(f.calls()).toBe(before);
  expect(f.refreshes()).toBe(1);
  await requireValue(restored.manager.getConnection(f.name)).client.callTool({
    name: "echo",
    arguments: {},
  });
  expect(f.calls()).toBe(before + 1);
  expect(f.refreshes()).toBe(1);
});

it.each(["sampling", "elicitation"] as const)(
  "owns real inbound %s promises with default TUI features without replaying answered requests",
  async (kind) => {
    const f = await wire({ inbound: true });
    const h = await host();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const entered: PromiseWithResolvers<void> = Promise.withResolvers();
    if (kind === "sampling") {
      h.ui.confirm.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return true;
      });
    } else {
      h.ui.select.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return "Continue";
      });
    }
    const state = await runtime(f.config, h);
    cleanups.push(async () => gate.resolve());
    await expect.poll(f.streamReady).toBe(true);
    expect(f.clientCapabilities()).toMatchObject({
      sampling: {},
      elicitation: { form: {}, url: {} },
    });
    const request = f.callback(
      kind === "sampling" ? "sampling/createMessage" : "elicitation/create",
      kind === "sampling" ? samplingRequest : elicitationRequest,
    );
    await entered.promise;
    requireValue(state.manager.getConnection(f.name)).lastUsedAt = 0;
    expect(state.manager.isIdle(f.name, 1)).toBe(false);
    gate.resolve();
    expect(await request.response).not.toHaveProperty("error");
    await requireValue(state.manager.getConnection(f.name)).client.callTool({
      name: "echo",
      arguments: {},
    });
    const before = f.calls();
    await state.owner.stop();
    const restored = await runtime(f.config, await host());
    expect(f.calls()).toBe(before); // ordinary startup discovery, never replay the old tool/callback
    await requireValue(restored.manager.getConnection(f.name)).client.callTool({
      name: "echo",
      arguments: {},
    });
    expect(f.calls()).toBe(before + 1);
  },
);

it("keeps the SDK's callback reply HTTP send owned after the handler itself has returned", async () => {
  const f = await wire({ inbound: true });
  const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  f.delay("callback-reply");
  const request = f.callback("elicitation/create", elicitationRequest);
  const reply = await request.response;
  assert.ok("result" in reply);
  expect(ElicitResultSchema.parse(reply.result).action).toBe("accept");
  expect(f.started()).toBe(true);
  // The form is answered and its promise is done, but the native reply's HTTP/auth work is not.
  const closed = vi.fn<() => void>();
  const closing = state.manager.close(f.name).then(closed);
  await nextImmediate();
  expect(closed).not.toHaveBeenCalled();
  f.release();
  await closing;
});

it("stops the runtime while an elicitation dialog is still open", async () => {
  const f = await wire({ inbound: true });
  const h = await host();
  let dismissed = false;
  // Mirror Pi's dialog behavior: an aborted dialog signal resolves the dialog as dismissed.
  h.ui.select.mockImplementation(async (_title, _choices, opts) => {
    const signal = opts?.signal;
    if (signal === undefined) {
      throw new Error("test dialog expected a bound signal");
    }
    if (signal.aborted) {
      dismissed = true;
      return;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          dismissed = true;
          resolve();
        },
        { once: true },
      );
    });
  });
  const state = await runtime(f.config, h);
  await expect.poll(f.streamReady).toBe(true);
  const request = f.callback("elicitation/create", elicitationRequest);
  await expect.poll(() => h.ui.select.mock.calls.length).toBeGreaterThan(0);
  // Session shutdown must settle the dialog and drain the callback without waiting for
  // an answer that can no longer be delivered.
  await state.owner.stop("session shutdown");
  expect(dismissed).toBe(true);
  request.cancel();
});

it.each(["sampling", "elicitation"] as const)(
  "does not lose a cancelled %s callback tail on transport close",
  async function retainsCancelledCallbackTail(kind) {
    const f = await wire({ inbound: true });
    const h = await host();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const entered: PromiseWithResolvers<void> = Promise.withResolvers();
    const state = await runtime(f.config, h);
    // Cleanup releases the real handler before owner.stop tries to drain it.
    cleanups.push(async () => gate.resolve());
    if (kind === "sampling") {
      h.complete.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return samplingResponse("SYNTHETIC-LATE");
      });
    } else {
      h.ui.select.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return "Decline";
      });
    }
    await expect.poll(f.streamReady).toBe(true);
    const request = f.callback(
      kind === "sampling" ? "sampling/createMessage" : "elicitation/create",
      kind === "sampling" ? samplingRequest : elicitationRequest,
    );
    await entered.promise;
    const transport = requireValue(state.manager.getConnection(f.name)).transport;
    const receive = transport.onmessage;
    let cancellationDispatched = false;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-010: native SDK Transport has only callback slots, not EventTarget listeners.
    transport.onmessage = (message, extra) => {
      receive?.(message, extra);
      if ("method" in message && message.method === "notifications/cancelled") {
        cancellationDispatched = true;
      }
    };
    request.cancel();
    await expect.poll(() => cancellationDispatched).toBe(true);
    // A real SDK roundtrip, not an arbitrary sleep, then checks the still-running handler.
    await requireValue(state.manager.getConnection(f.name)).client.callTool({
      name: "echo",
      arguments: {},
    });
    const closed = vi.fn<() => void>();
    const closing = state.manager.close(f.name).then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    gate.resolve();
    await closing;
  },
);

it.each(["sampling", "elicitation"] as const)(
  "owns a cancelled modern input-required %s handler beyond the tool's abortable facade",
  async (kind) => {
    const f = await wire({ input: kind });
    const h = await host();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const entered: PromiseWithResolvers<void> = Promise.withResolvers();
    const state = await runtime(f.config, h);
    cleanups.push(async () => gate.resolve());
    if (kind === "sampling") {
      h.ui.confirm.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return true;
      });
    } else {
      h.ui.select.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return "Decline";
      });
    }
    const controller = new AbortController();
    const call = executeCall(state, {
      toolName: "echo",
      args: {},
      serverOverride: f.name,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort(new Error("synthetic modern cancellation"));
    expect((await call).details.error).toBe("aborted");
    gate.resolve();
    await state.manager.close(f.name);
    expect(f.calls()).toBe(1); // cancelled input continuation was not dispatched after the late answer
    f.finishInput();
    expect(
      (await executeCall(state, { toolName: "echo", args: {}, serverOverride: f.name })).details
        .error,
    ).toBeUndefined();
    expect(f.calls()).toBe(2);
  },
);

it.each(["beforeExecute", "onToolCall"] as const)(
  "owns the underlying %s callback beyond abortable cancellation",
  async (kind) => {
    const f = await wire();
    const h = await host();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const entered: PromiseWithResolvers<void> = Promise.withResolvers();
    let armed = false;
    const callback = async () => {
      if (!armed) {
        return;
      }
      entered.resolve();
      await gate.promise;
      await writeFile(join(directory, kind + ".persisted"), "SYNTHETIC-CALLBACK-COMPLETED");
    };
    createMcpAdapter({
      config: f.config,
      ...(kind === "beforeExecute"
        ? { beforeExecute: callback }
        : {
            onToolCall: async (event: { phase: string }) => {
              if (event.phase === "after") {
                await callback();
              }
            },
          }),
    })(h.pi);
    cleanups.push(async () => {
      gate.resolve();
      await h.handlers.get("session_shutdown")();
    });
    await h.handlers.get("session_start")({}, h.ctx);
    const tool = h.tool("mcp");
    await tool.execute("connect", { connect: f.name });
    armed = true;
    const controller = new AbortController();
    const operation = tool.execute("call", { tool: "echo", server: f.name }, controller.signal);
    const observed = operation.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(new Error("synthetic cancellation"));
    await observed;
    gate.resolve();
    await expect
      .poll(async () =>
        readFile(join(directory, kind + ".persisted"), "utf8").catch(() => "pending"),
      )
      .toBe("SYNTHETIC-CALLBACK-COMPLETED");
    const prior = f.calls();
    armed = false;
    await tool.execute("next", { tool: "echo", server: f.name });
    expect(f.calls()).toBe(prior + 1);
  },
);

it("refreshes native catalog subscriptions without replaying effects", async () => {
  const f = await wire({ capabilities: { tools: { listChanged: true } } });
  const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  const metadataUpdated = vi.fn<NonNullable<typeof state.onToolMetadataUpdated>>();
  state.onToolMetadataUpdated = metadataUpdated;
  f.delay("tools/list");
  f.notify("notifications/tools/list_changed", {});
  await expect.poll(f.started).toBe(true);
  f.release();
  await expect.poll(() => metadataUpdated).toHaveBeenCalledWith(f.name, "tools-list-changed");
  expect(f.calls()).toBe(0);
});

it("owns initial detached GET token reads beyond connect through final shutdown", async () => {
  const f = await wire({ oauth: true, inbound: true });
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  let entered = false;
  const originalTokens =
    // oxlint-disable-next-line typescript/unbound-method -- QX-016: forward this native method with the actual provider receiver via apply below.
    McpOAuthProvider.prototype.tokens;
  vi.spyOn(McpOAuthProvider.prototype, "tokens").mockImplementation(async function (
    this: McpOAuthProvider,
    ...args
  ) {
    // Native initialized send launches GET synchronously before returning to discovery.
    if (!entered && f.methods.includes("notifications/initialized")) {
      entered = true;
      await gate.promise;
    }
    return originalTokens.apply(this, args);
  });
  const state = await runtime(f.config);
  cleanups.push(async () => gate.resolve());
  expect(entered).toBe(true);
  expect(f.gets()).toBe(0);
  await state.manager.close(f.name);
  const stopped = vi.fn<() => void>();
  const stopping = state.manager.closeAll().then(stopped);
  await nextImmediate();
  expect(stopped).not.toHaveBeenCalled();
  gate.resolve();
  await stopping;
});

it.each([false, true])(
  "joins reconnect auth and post-401 persistence (client_credentials=%s)",
  async (noninteractive) => {
    const f = await wire({ oauth: true, inbound: true });
    if (noninteractive) {
      const oauth = requireValue(f.definition.oauth);
      assert.ok(oauth !== false);
      oauth.grantType = "client_credentials";
    }
    const state = await runtime(f.config);
    await expect.poll(f.streamReady).toBe(true);
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    let entered = false;
    cleanups.push(async () => gate.resolve());
    const originalSaveTokens =
      // oxlint-disable-next-line typescript/unbound-method -- QX-016: forward this native method with the actual provider receiver via apply below.
      McpOAuthProvider.prototype.saveTokens;
    vi.spyOn(McpOAuthProvider.prototype, "saveTokens").mockImplementation(async function (
      this: McpOAuthProvider,
      ...args
    ) {
      entered = true;
      await gate.promise;
      return originalSaveTokens.apply(this, args);
    });
    f.rejectNextGet();
    f.endStream();
    await expect.poll(() => entered).toBe(true);
    expect(f.refreshes()).toBe(1);
    await state.manager.close(f.name);
    const stopped = vi.fn<() => void>();
    const stopping = state.manager.closeAll().then(stopped);
    await nextImmediate();
    expect(stopped).not.toHaveBeenCalled();
    gate.resolve();
    await stopping;
    expect(getAuthForUrl({ serverName: f.name, serverUrl: f.url })?.tokens?.refreshToken).toBe(
      "SYNTHETIC-REFRESH",
    );
  },
);

it("owns a background auth response body after fetch headers have arrived", async () => {
  const f = await wire({ oauth: true, inbound: true });
  const state = await runtime(f.config);
  await expect.poll(f.streamReady).toBe(true);
  const originalJson =
    // oxlint-disable-next-line typescript/unbound-method -- QX-016: forward this native method with the actual Response receiver via call below.
    Response.prototype.json;
  const gate: PromiseWithResolvers<void> = Promise.withResolvers();
  let entered = false;
  cleanups.push(async () => gate.resolve());
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ): Promise<unknown> {
    if (this.url === f.origin + "/token") {
      entered = true;
      await gate.promise;
    }
    const body: unknown = await originalJson.call(this);
    return body;
  });
  f.rejectNextGet();
  f.endStream();
  await expect.poll(() => entered).toBe(true);
  await state.manager.close(f.name);
  const stopped = vi.fn<() => void>();
  const stopping = state.manager.closeAll().then(stopped);
  await nextImmediate();
  expect(stopped).not.toHaveBeenCalled();
  gate.resolve();
  await stopping;
});

it("clears completed URL IDs only after the last actual completion notification", async () => {
  const f = await wire({ inbound: true });
  const h = await host();
  h.ui.select.mockResolvedValue("Open");
  await runtime(f.config, h);
  await expect.poll(f.streamReady).toBe(true);
  for (const id of ["first", "second"]) {
    const request = f.callback("elicitation/create", {
      mode: "url",
      message: "Synthetic browser request",
      elicitationId: id,
      url: f.origin + "/continue",
    });
    const reply = await request.response;
    assert.ok("result" in reply);
    expect(ElicitResultSchema.parse(reply.result).action).toBe("accept");
  }
  f.notify("notifications/elicitation/complete", { elicitationId: "first" });
  await expect
    .poll(() => h.ui.notify.mock.calls.filter(([text]) => text.includes("completed")).length)
    .toBe(1);
  f.notify("notifications/elicitation/complete", { elicitationId: "second" });
  await expect
    .poll(() => h.ui.notify.mock.calls.filter(([text]) => text.includes("completed")).length)
    .toBe(2);
});

it("reconstructs implicit OAuth challenge caches on a fresh runtime without replay", async () => {
  const f = await wire({ oauth: true });
  delete f.definition.auth;
  const saved = requireValue(
    requireValue(getAuthForUrl({ serverName: f.name, serverUrl: f.url })).tokens,
  );
  updateTokens({ serverName: f.name, serverUrl: f.url }, { ...saved, scope: "synthetic.read" });
  const state = await runtime(f.config);
  expect(f.unauthorized()).toBe(1);
  await state.owner.stop();
  await runtime(f.config);
  expect(f.unauthorized()).toBe(2);
  expect(f.calls()).toBe(0);
  expect(f.refreshes()).toBe(0);
  expect(getAuthForUrl({ serverName: f.name, serverUrl: f.url })?.tokens).toMatchObject({
    issuer: f.origin,
    scope: "synthetic.read",
  });
});

it("does not couple optional trace path failures to clean shutdown", async () => {
  const f = await wire();
  const parent = join(directory, "not-a-directory");
  await writeFile(parent, "fixture");
  requireValue(f.config.settings).trace = { enabled: true, file: join(parent, "trace.jsonl") };
  const state = await runtime(f.config);
  await requireValue(state.manager.getConnection(f.name)).client.callTool({
    name: "echo",
    arguments: {},
  });
  await expect(state.owner.stop()).resolves.toBeUndefined();
});

it("retains failed native disposal until an explicit close really retries cleanup", async () => {
  const f = await wire();
  const state = await runtime(f.config);
  const transport = requireValue(state.manager.getConnection(f.name)).transport;
  const close = vi
    .spyOn(transport, "close")
    .mockRejectedValueOnce(new Error("synthetic close failure"));
  await expect(state.manager.close(f.name)).rejects.toThrow("cleanup failed");
  await state.manager.connect(f.name, f.definition);
  await expect(state.manager.close(f.name)).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
});

it("makes trace persistence failures observable only at strict persistence boundaries", async () => {
  const failure = new Error("synthetic disk failure");
  const writer = new McpTraceWriter({
    filePath: join(directory, "trace-fail"),
    writeFile: async () => {
      throw failure;
    },
  });
  await expect(writer.flush()).resolves.toBeUndefined();
  await expect(writer.flush(true)).rejects.toBe(failure);
});
