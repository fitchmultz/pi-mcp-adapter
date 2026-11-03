import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type open from "open";
import type * as ClientModule from "@modelcontextprotocol/client";
import {
  Client,
  UrlElicitationRequiredError,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { McpServerManager } from "../../server-manager.ts";
import { logger } from "../../logger.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { requireValue } from "../fixtures/extension-lifecycle.ts";
import {
  createCallbackHttpFixture,
  elicitationRequest,
  samplingRequest,
} from "./fixtures/callback-http.ts";

const captures = vi.hoisted(() => {
  const clientOptions: (ClientOptions | undefined)[] = [];
  return { clientOptions, open: vi.fn<typeof open>() };
});
vi.mock("open", () => ({ default: captures.open }));
vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const sdk = await importOriginal<typeof ClientModule>();
  class CapturedClient extends sdk.Client {
    constructor(...args: ConstructorParameters<typeof sdk.Client>) {
      super(...args);
      captures.clientOptions.push(args[1]);
    }
  }
  return { ...sdk, Client: CapturedClient };
});

let directory: string;
let native: Awaited<ReturnType<typeof createTestExtensionContext>>;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-manager-config-")));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  captures.clientOptions.length = 0;
  captures.open.mockReset().mockImplementation(async () => new ChildProcess());
  native = await createTestExtensionContext();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await native.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function manager(cwd?: string): McpServerManager {
  const instance = new McpServerManager(cwd);
  cleanups.push(() => instance.closeAll());
  return instance;
}
async function wire() {
  const fixture = await createCallbackHttpFixture(directory, {
    legacy: true,
    inbound: true,
    capabilities: { tools: {}, resources: {} },
  });
  cleanups.push(fixture.close);
  return fixture;
}
function sampling(instance: McpServerManager): void {
  const registry = native.context.modelRegistry;
  const model = requireValue(registry.getAll()[0]);
  vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
  vi.spyOn(registry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true });
  vi.spyOn(registry, "complete").mockResolvedValue({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic response" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  });
  instance.setSamplingConfig({
    autoApprove: true,
    modelRegistry: registry,
    getCurrentModel: () => model,
    getSignal: vi.fn<() => AbortSignal | undefined>(),
  });
}
function ui() {
  return {
    ...native.context.ui,
    select: vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Open"),
    notify: vi.fn<ExtensionUIContext["notify"]>(),
  };
}
function options(index = 0): ClientOptions {
  return requireValue(captures.clientOptions[index]);
}
function stdio(cwd?: string) {
  return {
    command: process.execPath,
    args: [join(import.meta.dirname, "fixtures/manager-cwd-server.ts")],
    ...(cwd !== undefined ? { cwd } : {}),
  };
}
async function observedCwd(instance: McpServerManager, name: string) {
  return await requireValue(instance.getConnection(name)).client.callTool({
    name: "cwd",
    arguments: {},
  });
}

describe("McpServerManager configuration", () => {
  it("advertises sampling and registers the handler before connecting", async () => {
    const fixture = await wire();
    const instance = manager();
    sampling(instance);
    const handlers = vi.spyOn(Client.prototype, "setRequestHandler");
    const connect = vi.spyOn(Client.prototype, "connect");
    await instance.connect("demo", fixture.definition);
    expect(fixture.clientCapabilities()).toMatchObject({ sampling: {} });
    expect(
      handlers.mock.calls.filter(([method]) => method === "sampling/createMessage"),
    ).toHaveLength(1);
    const index = handlers.mock.calls.findIndex(([method]) => method === "sampling/createMessage");
    expect(requireValue(handlers.mock.invocationCallOrder[index])).toBeLessThan(
      requireValue(connect.mock.invocationCallOrder[0]),
    );
    await expect.poll(fixture.streamReady).toBe(true);
    const reply = await fixture.callback("sampling/createMessage", samplingRequest).response;
    expect(reply).toMatchObject({
      result: { content: { type: "text", text: "Synthetic response" } },
    });
  });

  it("advertises elicitation capabilities and registers the handler before connecting", async () => {
    const fixture = await wire();
    const instance = manager();
    instance.setElicitationConfig({ allowUrl: true, ui: native.context.ui });
    const handlers = vi.spyOn(Client.prototype, "setRequestHandler");
    const connect = vi.spyOn(Client.prototype, "connect");
    await instance.connect("demo", fixture.definition);
    expect(fixture.clientCapabilities()).toMatchObject({ elicitation: { form: {}, url: {} } });
    expect(handlers.mock.calls.filter(([method]) => method === "elicitation/create")).toHaveLength(
      1,
    );
    const index = handlers.mock.calls.findIndex(([method]) => method === "elicitation/create");
    expect(requireValue(handlers.mock.invocationCallOrder[index])).toBeLessThan(
      requireValue(connect.mock.invocationCallOrder[0]),
    );
    await expect.poll(fixture.streamReady).toBe(true);
    const reply = await fixture.callback("elicitation/create", elicitationRequest).response;
    expect(reply).toMatchObject({ result: { action: "cancel" } });
  });

  it("advertises form-only elicitation when URL navigation is unavailable", async () => {
    const fixture = await wire();
    const instance = manager();
    instance.setElicitationConfig({ allowUrl: false, ui: ui() });
    await instance.connect("demo", fixture.definition);
    expect(fixture.clientCapabilities()).toMatchObject({ elicitation: { form: {} } });
    expect(fixture.clientCapabilities()).not.toHaveProperty("elicitation.url");
  });

  it("notifies only when a known URL elicitation completes", async () => {
    const fixture = await wire();
    const instance = manager();
    const controls = ui();
    instance.setElicitationConfig({ allowUrl: true, ui: controls });
    await instance.connect("demo", fixture.definition);
    await expect.poll(fixture.streamReady).toBe(true);
    const reply = await fixture.callback("elicitation/create", {
      mode: "url",
      message: "Connect",
      elicitationId: "known-id",
      url: "https://example.com/connect",
    }).response;
    expect(reply).toMatchObject({ result: { action: "accept" } });
    fixture.notify("notifications/elicitation/complete", { elicitationId: "unknown-id" });
    fixture.notify("notifications/elicitation/complete", { elicitationId: "known-id" });
    fixture.notify("notifications/elicitation/complete", { elicitationId: "known-id" });
    // The following request's reply proves all preceding notifications were dispatched.
    await fixture.callback("ping", {}).response;
    expect(controls.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(controls.notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.",
      "info",
    );
    expect(controls.notify).toHaveBeenCalledTimes(2);
  });

  it("handles every URL in a URL-required error", async () => {
    const instance = manager();
    instance.setElicitationConfig({ allowUrl: true, ui: ui() });
    const result = await instance.handleUrlElicitationRequired(
      "demo",
      new UrlElicitationRequiredError([
        { mode: "url", message: "First", elicitationId: "one", url: "https://example.com/one" },
        { mode: "url", message: "Second", elicitationId: "two", url: "https://example.com/two" },
      ]),
    );
    expect(result).toBe("accept");
    expect(captures.open).toHaveBeenNthCalledWith(1, "https://example.com/one");
    expect(captures.open).toHaveBeenNthCalledWith(2, "https://example.com/two");
  });

  it("advertises sampling and elicitation together", async () => {
    const fixture = await wire();
    const instance = manager();
    sampling(instance);
    instance.setElicitationConfig({ allowUrl: true, ui: ui() });
    const handlers = vi.spyOn(Client.prototype, "setRequestHandler");
    await instance.connect("demo", fixture.definition);
    expect(fixture.clientCapabilities()).toMatchObject({
      sampling: {},
      elicitation: { form: {}, url: {} },
    });
    expect(
      handlers.mock.calls.filter(([method]) => method === "sampling/createMessage"),
    ).toHaveLength(1);
    expect(handlers.mock.calls.filter(([method]) => method === "elicitation/create")).toHaveLength(
      1,
    );
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const fixture = await wire();
    const instance = manager();
    const handlers = vi.spyOn(Client.prototype, "setRequestHandler");
    await instance.connect("demo", fixture.definition);
    expect(options()).not.toHaveProperty("capabilities");
    expect(fixture.clientCapabilities()).not.toHaveProperty("sampling");
    expect(options().listChanged?.tools?.onChanged).toBeTypeOf("function");
    expect(options().listChanged?.resources?.onChanged).toBeTypeOf("function");
    expect(
      handlers.mock.calls.filter(
        ([method]) => method === "sampling/createMessage" || method === "elicitation/create",
      ),
    ).toHaveLength(0);
  });

  it("refreshes cached lists and ignores notifications from replaced clients", async () => {
    const fixture = await wire();
    const instance = manager();
    const metadataChanged = vi.fn<(name: string, reason: string) => void>();
    instance.setMetadataListChangedListener(metadataChanged);
    await instance.connect("demo", fixture.definition);
    const old = requireValue(options().listChanged);
    await instance.close("demo");
    await instance.connect("demo", fixture.definition);
    const fresh = requireValue(options(1).listChanged);
    const initial = requireValue(instance.getConnection("demo"));
    const initialTools = initial.tools;
    const initialResources = initial.resources;
    const freshTools = [
      { name: "fresh_tool", description: "Fresh tool", inputSchema: { type: "object" as const } },
    ];
    const freshResources = [{ uri: "file://fresh", name: "Fresh resource" }];
    requireValue(old.tools?.onChanged)(null, [
      { name: "stale_tool", inputSchema: { type: "object" } },
    ]);
    requireValue(old.resources?.onChanged)(null, [{ uri: "file://stale", name: "Stale resource" }]);
    expect(instance.getConnection("demo")?.tools).toBe(initialTools);
    expect(instance.getConnection("demo")?.resources).toBe(initialResources);
    expect(metadataChanged).not.toHaveBeenCalled();
    requireValue(fresh.tools?.onChanged)(null, freshTools);
    requireValue(fresh.resources?.onChanged)(null, freshResources);
    expect(instance.getConnection("demo")?.tools).toEqual(freshTools);
    expect(instance.getConnection("demo")?.resources).toEqual(freshResources);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "tools-list-changed");
    expect(metadataChanged).toHaveBeenCalledWith("demo", "resources-list-changed");
  });

  it("logs list-change callback errors without replacing cached metadata", async () => {
    const fixture = await wire();
    const instance = manager();
    await instance.connect("demo", fixture.definition);
    const callbacks = requireValue(options().listChanged);
    const initial = requireValue(instance.getConnection("demo"));
    const tools = initial.tools;
    const resources = initial.resources;
    const debug = vi.spyOn(logger, "debug");
    const error = new Error("refresh failed");
    requireValue(callbacks.tools?.onChanged)(error, null);
    requireValue(callbacks.resources?.onChanged)(error, null);
    expect(instance.getConnection("demo")?.tools).toBe(tools);
    expect(instance.getConnection("demo")?.resources).toBe(resources);
    expect(debug).toHaveBeenCalledWith(
      "MCP: tools/list_changed refresh failed for demo: refresh failed",
    );
    expect(debug).toHaveBeenCalledWith(
      "MCP: resources/list_changed refresh failed for demo: refresh failed",
    );
  });

  it("expands environment variables and tilde in stdio cwd", async () => {
    vi.stubEnv("MCP_TEST_CWD", directory);
    await mkdir(join(directory, "nested"));
    const envManager = manager();
    await envManager.connect("env-cwd", stdio("${MCP_TEST_CWD}/nested"));
    const homeManager = manager();
    await homeManager.connect("home-cwd", stdio("~/nested"));
    expect(await observedCwd(envManager, "env-cwd")).toMatchObject({
      content: [{ type: "text", text: join(directory, "nested") }],
    });
    expect(await observedCwd(homeManager, "home-cwd")).toMatchObject({
      content: [{ type: "text", text: join(homedir(), "nested") }],
    });
  });

  it("uses the session cwd for stdio servers without an explicit cwd", async () => {
    const cwd = join(directory, "session");
    await mkdir(cwd);
    const instance = manager(cwd);
    await instance.connect("session-cwd", stdio());
    expect(await observedCwd(instance, "session-cwd")).toMatchObject({
      content: [{ type: "text", text: cwd }],
    });
  });

  it("prefers an explicit stdio cwd over the session cwd", async () => {
    const cwd = join(directory, "server");
    await mkdir(cwd);
    const instance = manager(join(directory, "session"));
    await instance.connect("explicit-cwd", stdio(cwd));
    expect(await observedCwd(instance, "explicit-cwd")).toMatchObject({
      content: [{ type: "text", text: cwd }],
    });
  });

  it.each([
    ["global", undefined, 2500],
    ["per-server", 5000, 5000],
  ] as const)(
    "applies the %s timeout to connect and discovery requests",
    async (scope, requestTimeoutMs, expected) => {
      const fixture = await wire();
      const instance = manager();
      instance.setDefaultRequestTimeoutMs(2500);
      const connect = vi.spyOn(Client.prototype, "connect");
      const tools = vi.spyOn(Client.prototype, "listTools");
      const resources = vi.spyOn(Client.prototype, "listResources");
      const definition = { ...fixture.definition };
      delete definition.requestTimeoutMs;
      if (requestTimeoutMs !== undefined) {
        definition.requestTimeoutMs = requestTimeoutMs;
      }
      await instance.connect("demo", definition);
      const connection = requireValue(instance.getConnection("demo"));
      const signal: unknown = expect.any(AbortSignal);
      expect(connect, scope).toHaveBeenCalledWith(connection.transport, { timeout: expected });
      expect(tools).toHaveBeenCalledWith(undefined, {
        timeout: expected,
        cacheMode: "refresh",
        signal,
      });
      expect(resources).toHaveBeenCalledWith(undefined, {
        timeout: expected,
        cacheMode: "refresh",
        signal,
      });
    },
  );

  it("builds request options from global and per-server timeouts", async () => {
    const fixture = await wire();
    const instance = manager();
    instance.setDefaultRequestTimeoutMs(2500);
    await instance.connect("demo", { ...fixture.definition, requestTimeoutMs: 5000 });
    await instance.connect("sdk-default", { ...fixture.definition, requestTimeoutMs: 0 });
    const signal = new AbortController().signal;
    expect(instance.getRequestOptions("demo", signal)).toEqual({ signal, timeout: 5000 });
    expect(instance.getRequestOptions("missing", signal)).toEqual({ signal, timeout: 2500 });
    expect(instance.getRequestOptions("missing")).toEqual({ timeout: 2500 });
    expect(instance.getRequestOptions("sdk-default")).toBeUndefined();
    instance.setDefaultRequestTimeoutMs(0);
    expect(instance.getRequestOptions("missing")).toBeUndefined();
  });
});
