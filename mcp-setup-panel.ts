import {
  matchesKey,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
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
import { COMPACT_ACTION_ROWS, SetupView } from "./mcp-setup-view.ts";
export type { SetupPanelCallbacks, SetupPanelOptions } from "./mcp-setup-contract.ts";

interface McpSetupPanelInput {
  discovery: McpDiscoverySummary;
  callbacks: SetupPanelCallbacks;
  options: SetupPanelOptions;
  tui: Pick<TUI, "requestRender">;
  done: () => void;
}

type SetupCursor = "actionCursor" | "importCursor" | "pathCursor";

export class McpSetupPanel implements Component {
  private screen: Screen;
  private actionCursor = 0;
  private importCursor = 0;
  private pathCursor = 0;
  private renderedItems: { screen: Screen; itemRows: ReadonlyMap<number, number> } | undefined;
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      return this.handleWheel(event.wheelDelta);
    }

    if (
      this.busy ||
      this.renderedItems?.screen !== this.screen ||
      event.button !== "left" ||
      (event.type !== "press" && event.type !== "click")
    ) {
      return undefined;
    }
    const index = this.renderedItems.itemRows.get(event.y);
    if (index === undefined) {
      return undefined;
    }
    this.resetInactivityTimeout();
    if (event.type === "press") {
      // Pi dispatches a component click after the component handles the press.
      return { handled: true, render: false };
    }
    return { handled: true, focus: true, render: this.selectItem(this.activeList().cursor, index) };
  }

  private handleWheel(wheelDelta: number | undefined): TuiMouseEventResult {
    this.resetInactivityTimeout();
    if (this.busy || wheelDelta === undefined || wheelDelta === 0) {
      return { handled: true, render: false };
    }
    const { cursor, count } = this.activeList();
    const delta = wheelDelta < 0 ? -1 : 1;
    const index = Math.max(0, Math.min(count - 1, this[cursor] + delta));
    return { handled: true, render: this.selectItem(cursor, index) };
  }

  private activeList(): { cursor: SetupCursor; count: number } {
    if (this.screen === "imports") {
      return { cursor: "importCursor", count: this.discovery.imports.length };
    }
    if (this.screen === "paths") {
      return { cursor: "pathCursor", count: getDetectedPaths(this.discovery).length };
    }
    return { cursor: "actionCursor", count: getSetupActions(this.discovery, this.screen).length };
  }

  private selectItem(cursor: SetupCursor, index: number): boolean {
    const changed = this[cursor] !== index;
    this[cursor] = index;
    return changed;
  }

  private handleActionInput(data: string): void {
    const actions = getSetupActions(this.discovery, this.screen);
    const moved = this.moveListCursor(data, this.actionCursor, actions.length, COMPACT_ACTION_ROWS);
    if (moved !== undefined) {
      this.actionCursor = moved;
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
    const moved = this.moveListCursor(
      data,
      this.importCursor,
      imports.length,
      Math.max(1, imports.length - 1),
    );
    if (moved !== undefined) {
      this.importCursor = moved;
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
    const moved = this.moveListCursor(
      data,
      this.pathCursor,
      paths.length,
      Math.max(1, paths.length - 1),
    );
    if (moved !== undefined) {
      this.pathCursor = moved;
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

  private moveListCursor(
    data: string,
    cursor: number,
    count: number,
    pageSize: number,
  ): number | undefined {
    if (this.keys.selectUp(data)) {
      return Math.max(0, cursor - 1);
    }
    if (this.keys.selectDown(data)) {
      return Math.min(count - 1, cursor + 1);
    }
    return this.keys.selectPage(data, cursor, count, pageSize);
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
    const { lines, itemRows } = new SetupView({
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
    this.renderedItems = { screen: this.screen, itemRows };
    return lines;
  }

  invalidate(): void {
    // The hit targets are replaced along with the lines on the next render.
  }

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpSetupPanel(input: McpSetupPanelInput): McpSetupPanel {
  return new McpSetupPanel(input);
}
