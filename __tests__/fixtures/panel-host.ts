import assert from "node:assert/strict";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { vi } from "vitest";
// The SDK exports this class only as a type. Use the selected host's actual
// implementation rather than claiming a partial object has its private brand.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createTestExtensionContext } from "../test-extension-context.ts";

type Panel = Awaited<ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>>;

/** Exercise a real custom-component factory without starting a terminal. */
export async function createPanelHost(): Promise<ReturnType<typeof bindPanelHost>> {
  return bindPanelHost(await createTestExtensionContext());
}

function bindPanelHost(native: Awaited<ReturnType<typeof createTestExtensionContext>>) {
  const tui = new TuiMainScreen(new ProcessTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {
    // Exercise panel callbacks without drawing to the user's terminal.
  });
  const keybindings = new KeybindingsManager();
  let component: Panel | undefined;
  function custom<T>(factory: Parameters<typeof native.context.ui.custom<T>>[0]): Promise<T> {
    const completed = Promise.withResolvers<T>();
    return Promise.resolve(
      factory(tui, native.context.ui.theme, keybindings, completed.resolve),
    ).then((panel) => {
      component = panel;
      return completed.promise;
    });
  }
  const context = {
    ...native.context,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      ...native.context.ui,
      custom,
      setStatus: vi.fn<typeof native.context.ui.setStatus>(),
      notify: vi.fn<typeof native.context.ui.notify>(),
    },
  } satisfies ExtensionContext;
  return {
    api: native.api,
    context,
    component: () => component,
    input(data: string): void {
      assert(component?.handleInput !== undefined, "Custom panel has no input handler");
      component.handleInput(data);
    },
    async dispose(this: void): Promise<void> {
      component?.dispose?.();
      await native.dispose();
    },
  };
}
