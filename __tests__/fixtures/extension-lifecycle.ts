import assert from "node:assert/strict";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionError,
  ExtensionUIContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { createTestExtensionContext } from "../test-extension-context.ts";

type ContextOverrides = Partial<Omit<ExtensionCommandContext, "ui">> & {
  ui?: Partial<ExtensionUIContext>;
};

export function requireValue<T>(value: T | undefined | null): T {
  assert(value !== undefined && value !== null);
  return value;
}

/** Native registrations and session history, with controlled host context values. */
export async function createLifecycleHost(): Promise<ReturnType<typeof bindLifecycleHost>> {
  return bindLifecycleHost(await createTestExtensionContext("builtin"));
}

function bindLifecycleHost(fixture: Awaited<ReturnType<typeof createTestExtensionContext>>) {
  const api = fixture.api;
  const spies = {
    registerTool: vi.spyOn(api, "registerTool"),
    registerCommand: vi.spyOn(api, "registerCommand"),
    appendEntry: vi.spyOn(api, "appendEntry"),
    getFlag: vi.spyOn(api, "getFlag"),
  };
  api.setActiveTools(["bash"]);
  const errors: ExtensionError[] = [];
  fixture.runner.onError((error) => {
    errors.push(error);
  });
  let overrides: ContextOverrides = {};
  const nativeContext = fixture.runner.createContext.bind(fixture.runner);
  vi.spyOn(fixture.runner, "createContext").mockImplementation((): ExtensionContext => ({
    ...nativeContext(),
    cwd: process.cwd(),
    ...overrides,
    ui: { ...fixture.runner.getUIContext(), ...overrides.ui },
  }));

  const handlers = {
    get(event: "session_start" | "session_shutdown") {
      assert(fixture.runner.hasHandlers(event), `Missing native ${event} registration`);
      return async (
        payload: { reason?: SessionStartEvent["reason"] } = {},
        context: ContextOverrides = {},
      ) => {
        overrides = context;
        switch (event) {
          case "session_start":
            await fixture.runner.emit({
              type: "session_start",
              reason: payload.reason ?? "startup",
            });
            break;
          case "session_shutdown":
            await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
            break;
        }
      };
    },
  };

  function tool(name: string) {
    const definition = requireValue(fixture.runner.getToolDefinition(name));
    return {
      ...definition,
      execute(callId: string, parameters: Record<string, unknown>, signal?: AbortSignal) {
        return definition.execute(
          callId,
          parameters,
          signal,
          undefined,
          fixture.runner.createToolContext(callId, signal),
        );
      },
    };
  }

  function command(name: string) {
    const definition = requireValue(fixture.runner.getCommand(name));
    return {
      ...definition,
      async getArgumentCompletions(prefix: string) {
        return requireValue(definition.getArgumentCompletions)(prefix);
      },
      async handler(args: string, context: ContextOverrides = {}) {
        overrides = context;
        await definition.handler(args, {
          ...fixture.runner.createCommandContext(),
          ...context,
          ui: { ...fixture.runner.getUIContext(), ...context.ui },
        });
      },
    };
  }

  return {
    api,
    spies,
    handlers,
    tool,
    command,
    errors,
    runner: fixture.runner,
    // Native emit reports a string to the host. This focused callback boundary retains
    // the original AggregateError so the cleanup test can check every nested cause.
    async shutdownCallback(this: void): Promise<void> {
      const callbacks = fixture.resourceLoader
        .getExtensions()
        .extensions.flatMap((extension) => extension.handlers.get("session_shutdown") ?? []);
      assert.equal(callbacks.length, 1);
      await requireValue(callbacks[0])(
        { type: "session_shutdown", reason: "quit" },
        fixture.runner.createContext(),
      );
    },
    async dispose(): Promise<void> {
      try {
        await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        await fixture.dispose();
      }
    },
  };
}
