import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../config.ts";
import { McpServerManager } from "../server-manager.ts";
import { createActivationFixture } from "./fixtures/strict-activation-boundaries.ts";
import { elicitationRequest } from "./runtime/fixtures/callback-http.ts";

let host: Awaited<ReturnType<typeof createActivationFixture>>;
beforeEach(async () => {
  host = await createActivationFixture();
});
afterEach(async () => {
  await host.dispose();
});

describe("initializeMcp elicitation config", () => {
  it("uses an isolated programmatic config without reading flags or files", async () => {
    const config = {
      mcpServers: {},
      settings: { sampling: false },
    };
    const getFlag = vi.spyOn(host.api, "getFlag");
    const loadMcpConfig = vi.spyOn(configModule, "loadMcpConfig");
    host.runner.setUIContext(undefined, "print");
    const state = await host.initialize({ config });

    expect(getFlag).not.toHaveBeenCalled();
    expect(loadMcpConfig).not.toHaveBeenCalled();
    expect(state.config).toEqual(config);
    expect(state.config).not.toBe(config);
    expect(state.programmaticConfig).toBe(true);
  });

  it("enables form and URL elicitation in TUI mode", async () => {
    const elicitation = vi.spyOn(McpServerManager.prototype, "setElicitationConfig");
    const wire = await host.wire({ legacy: true, inbound: true });
    const state = await host.initialize({
      config: {
        mcpServers: {
          demo: { ...wire.definition, lifecycle: "eager" },
          cwd: {
            command: process.execPath,
            args: [join(import.meta.dirname, "runtime/fixtures/manager-cwd-server.ts")],
            lifecycle: "eager",
          },
        },
      },
    });

    expect(elicitation).toHaveBeenCalledWith({ ui: state.ui, allowUrl: true });
    expect(wire.clientCapabilities()).toMatchObject({ elicitation: { form: {}, url: {} } });
    await expect.poll(wire.streamReady).toBe(true);
    expect(await wire.callback("elicitation/create", elicitationRequest).response).toMatchObject({
      result: { action: "cancel" },
    });
    const connection = state.manager.getConnection("cwd");
    assert(connection !== undefined);
    const cwd = await connection.client.callTool({ name: "cwd", arguments: {} });
    expect(cwd.content).toEqual([{ type: "text", text: await realpath(host.context.cwd) }]);
  });

  it("binds the owned oauthDir import path to the active context cwd", async () => {
    const authStorage = vi.spyOn(McpServerManager.prototype, "setAuthStorageOptions");
    const directory = join(host.directory, ".pi", "fitch-mcp-adapter");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "mcp.json"),
      JSON.stringify({ mcpServers: {}, settings: { oauthDir: ".pi/oauth" } }),
    );

    const state = await host.initialize();

    expect(authStorage).toHaveBeenCalledWith({
      baseDir: join(host.context.cwd, ".pi/oauth/fitch-mcp-adapter"),
    });
    expect(state.authStorageOptions).toEqual({
      baseDir: join(host.context.cwd, ".pi/oauth/fitch-mcp-adapter"),
    });
  });

  it("keeps RPC elicitation form-only so the backend never opens a browser", async () => {
    host.runner.setUIContext(host.ui, "rpc");
    const elicitation = vi.spyOn(McpServerManager.prototype, "setElicitationConfig");
    const wire = await host.wire({ legacy: true, inbound: true });
    const state = await host.initialize({
      config: { mcpServers: { demo: { ...wire.definition, lifecycle: "eager" } } },
    });

    expect(elicitation).toHaveBeenCalledWith({ ui: state.ui, allowUrl: false });
    expect(wire.clientCapabilities()).toMatchObject({ elicitation: { form: {} } });
    expect(wire.clientCapabilities()).not.toHaveProperty("elicitation.url");
    await expect.poll(wire.streamReady).toBe(true);
    expect(await wire.callback("elicitation/create", elicitationRequest).response).toMatchObject({
      result: { action: "cancel" },
    });
  });

  it("keeps sampling bound to the current model and turn signal while the runtime is active", async () => {
    const [first, second] = host.context.modelRegistry.getAll();
    assert(first !== undefined && second !== undefined);
    const model = vi.spyOn(host.context, "model", "get").mockReturnValue(first);
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    const signal = vi.spyOn(host.context, "signal", "get").mockReturnValue(firstSignal.signal);
    const sampling = vi.spyOn(McpServerManager.prototype, "setSamplingConfig");
    const state = await host.initialize({ config: { mcpServers: {} } });
    const callbacks = sampling.mock.calls[0]?.[0];
    assert(callbacks !== undefined);

    model.mockReturnValue(second);
    signal.mockReturnValue(secondSignal.signal);
    expect(callbacks.getCurrentModel()).toEqual(second);
    const activeSignal = callbacks.getSignal();
    assert(activeSignal !== undefined);
    expect(activeSignal.aborted).toBe(false);
    secondSignal.abort(new Error("turn cancelled"));
    expect(activeSignal.aborted).toBe(true);

    await state.owner.stop("reload");
    expect(callbacks.getCurrentModel()).toBeUndefined();
    expect(callbacks.getSignal()?.aborted).toBe(true);
  });

  it("does not enable elicitation without UI or when disabled", async () => {
    const elicitation = vi.spyOn(McpServerManager.prototype, "setElicitationConfig");
    const wire = await host.wire({ legacy: true });
    const config = { mcpServers: { demo: { ...wire.definition, lifecycle: "eager" as const } } };
    host.runner.setUIContext(undefined, "print");
    const headless = await host.initialize({ config });
    expect(elicitation).not.toHaveBeenCalled();
    expect(wire.clientCapabilities()).not.toHaveProperty("elicitation");
    await headless.owner.stop("headless check complete");

    host.runner.setUIContext(host.ui, "tui");
    await host.initialize({ config: { ...config, settings: { elicitation: false } } });
    expect(elicitation).not.toHaveBeenCalled();
    expect(wire.clientCapabilities()).not.toHaveProperty("elicitation");
  });
});
