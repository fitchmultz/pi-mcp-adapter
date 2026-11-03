import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { createPanelKeys, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import type { McpDiscoverySummary } from "./config.ts";
import type {
  Action,
  Screen,
  SetupPanelCallbacks,
  SetupPanelOptions,
} from "./mcp-setup-contract.ts";
import { getSetupActions, getDetectedPaths } from "./mcp-setup-actions.ts";
import { SetupView } from "./mcp-setup-view.ts";
export type { SetupPanelCallbacks, SetupPanelOptions } from "./mcp-setup-contract.ts";

interface McpSetupPanelInput {
  discovery: McpDiscoverySummary;
  callbacks: SetupPanelCallbacks;
  options: SetupPanelOptions;
  tui: Pick<TUI, "requestRender">;
  done: () => void;
}

export class McpSetupPanel implements Component {
  private screen: Screen;
  private actionCursor = 0;
  private importCursor = 0;
  private pathCursor = 0;
  private readonly selectedImports = new Set<ImportKind>();
  private busy = false;
  private notice: { text: string; tone: "success" | "warning" | "muted" } | null = null;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly keys: PanelKeys;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;

  private readonly discovery: McpDiscoverySummary;
  private readonly callbacks: SetupPanelCallbacks;
  private readonly options: SetupPanelOptions;
  private readonly done: () => void;

  constructor(input: McpSetupPanelInput) {
    const { discovery, callbacks, options, tui, done } = input;
    this.discovery = discovery;
    this.callbacks = callbacks;
    this.options = options;
    this.done = done;
    this.tui = tui;
    this.keys = createPanelKeys(options.keybindings);
    this.screen = options.mode;
    for (const entry of discovery.imports) {
      this.selectedImports.add(entry.kind);
    }
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done();
    }, McpSetupPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private getSelectedAction(): Action | undefined {
    const actions = getSetupActions(this.discovery, this.screen);
    return actions[this.actionCursor];
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    if (!this.busy) {
      this.notice = null;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.screen === "imports" || this.screen === "paths") {
        this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
        this.tui.requestRender();
        return;
      }
      this.cleanup();
      this.done();
      return;
    }

    if (this.busy) {
      return;
    }

    if (this.screen === "imports") {
      this.handleImportsInput(data);
      return;
    }
    if (this.screen === "paths") {
      this.handlePathsInput(data);
      return;
    }

    this.handleActionInput(data);
  }

  private handleActionInput(data: string): void {
    const actions = getSetupActions(this.discovery, this.screen);
    if (this.keys.selectUp(data)) {
      this.actionCursor = Math.max(0, this.actionCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.actionCursor = Math.min(actions.length - 1, this.actionCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = this.getSelectedAction();
      if (selected) {
        this.runAction(selected).catch((error: unknown) => this.reportError(error));
      }
    }
  }

  private handleImportsInput(data: string): void {
    const imports = this.discovery.imports;
    if (this.keys.selectUp(data)) {
      this.importCursor = Math.max(0, this.importCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.importCursor = Math.min(imports.length - 1, this.importCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      const current = imports[this.importCursor];
      if (!current) {
        return;
      }
      if (this.selectedImports.has(current.kind)) {
        this.selectedImports.delete(current.kind);
      } else {
        this.selectedImports.add(current.kind);
      }
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      this.applySelectedImports().catch((error: unknown) => this.reportError(error));
    }
  }

  private handlePathsInput(data: string): void {
    const paths = getDetectedPaths(this.discovery);
    if (this.keys.selectUp(data)) {
      this.pathCursor = Math.max(0, this.pathCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.pathCursor = Math.min(paths.length - 1, this.pathCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = paths[this.pathCursor];
      if (selected === undefined || selected.length === 0) {
        return;
      }
      this.runBusy(async () => {
        await this.callbacks.openPath(selected);
        this.notice = { text: `Opened ${selected}`, tone: "success" };
      }).catch((error: unknown) => this.reportError(error));
    }
  }

  private async runAction(action: Action): Promise<void> {
    if (action.id === "run-setup") {
      this.screen = "setup";
      this.actionCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "adopt-imports") {
      this.screen = "imports";
      this.importCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "open-paths") {
      this.screen = "paths";
      this.pathCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "scaffold-project") {
      await this.runBusy(async () => {
        const result = await this.callbacks.scaffoldProjectConfig();
        this.callbacks.markSetupCompleted();
        this.notice = {
          text: `Wrote starter config to ${result.path}. Pi will reload after this panel closes.`,
          tone: "success",
        };
      });
      return;
    }
    if (action.id === "add-repoprompt") {
      await this.runBusy(async () => {
        const result = await this.callbacks.addRepoPrompt();
        this.callbacks.markSetupCompleted();
        this.notice = {
          text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`,
          tone: "success",
        };
      });
      return;
    }
    if (action.id === "add-known-server" && action.preset) {
      const preset = action.preset;
      await this.runBusy(async () => {
        const result = await this.callbacks.addKnownServer(preset);
        this.callbacks.markSetupCompleted();
        this.notice = {
          text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`,
          tone: "success",
        };
      });
      return;
    }
    if (action.id === "close") {
      this.cleanup();
      this.done();
      return;
    }

    this.notice = {
      text: "Review the details below. Press Enter on an action with a side effect to apply it.",
      tone: "muted",
    };
    this.tui.requestRender();
  }

  private async applySelectedImports(): Promise<void> {
    const selected = this.discovery.imports
      .filter((entry) => this.selectedImports.has(entry.kind))
      .map((entry) => entry.kind);
    if (selected.length === 0) {
      this.notice = { text: "Select at least one compatibility import first.", tone: "warning" };
      this.tui.requestRender();
      return;
    }

    await this.runBusy(async () => {
      const result = await this.callbacks.adoptImports(selected);
      this.callbacks.markSetupCompleted();
      this.notice =
        result.added.length > 0
          ? {
              text: `Added ${result.added.join(", ")} to ${result.path}. Pi will reload after this panel closes.`,
              tone: "success",
            }
          : { text: `No changes needed in ${result.path}.`, tone: "muted" };
      this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
      this.actionCursor = 0;
    });
  }

  private reportError(error: unknown): void {
    this.notice = { text: error instanceof Error ? error.message : String(error), tone: "warning" };
    this.tui.requestRender();
  }

  private async runBusy(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.notice = { text: "Working...", tone: "muted" };
    this.tui.requestRender();
    try {
      await fn();
    } catch (error) {
      this.notice = {
        text: error instanceof Error ? error.message : String(error),
        tone: "warning",
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    return new SetupView({
      discovery: this.discovery,
      callbacks: this.callbacks,
      options: this.options,
      screen: this.screen,
      actionCursor: this.actionCursor,
      importCursor: this.importCursor,
      pathCursor: this.pathCursor,
      selectedImports: this.selectedImports,
      notice: this.notice,
    }).render(width);
  }

  invalidate(): void {
    // Every render derives its lines from current state; there is no cached layout.
  }

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpSetupPanel(input: McpSetupPanelInput): McpSetupPanel {
  return new McpSetupPanel(input);
}
