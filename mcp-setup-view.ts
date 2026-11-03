import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ImportKind } from "./types.ts";
import type { McpDiscoverySummary } from "./config.ts";
import type {
  Action,
  SetupPanelCallbacks,
  SetupPanelOptions,
  Screen,
} from "./mcp-setup-contract.ts";
import { getSetupActions, getDetectedPaths } from "./mcp-setup-actions.ts";
import { SetupPreview, wrapSetupText as wrapText } from "./mcp-setup-preview.ts";
interface SetupTheme {
  border: string;
  title: string;
  selected: string;
  hint: string;
  success: string;
  warning: string;
  muted: string;
}

const DEFAULT_THEME: SetupTheme = {
  border: "2",
  title: "36",
  selected: "32",
  hint: "2",
  success: "32",
  warning: "33",
  muted: "2;3",
};

const MIN_PANEL_WIDTH = 24;
const COMPACT_WIDTH = 60;
const COMPACT_ACTION_ROWS = 7;
const DESKTOP_PREVIEW_WIDTH = 74;

function fg(code: string, text: string): string {
  return code.length > 0 ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export interface SetupViewState {
  discovery: McpDiscoverySummary;
  callbacks: SetupPanelCallbacks;
  options: SetupPanelOptions;
  screen: Screen;
  actionCursor: number;
  importCursor: number;
  pathCursor: number;
  selectedImports: ReadonlySet<ImportKind>;
  notice: { text: string; tone: "success" | "warning" | "muted" } | null;
}

export class SetupView {
  private readonly t = DEFAULT_THEME;
  private readonly preview: SetupPreview;
  private readonly state: SetupViewState;
  constructor(state: SetupViewState) {
    this.state = state;
    this.preview = new SetupPreview(state);
  }
  render(width: number): string[] {
    const panelW = Math.max(MIN_PANEL_WIDTH, width);
    const innerW = panelW - 2;
    const contentW = this.contentWidth(innerW);
    const lines: string[] = [];
    const border = fg(this.t.border, "─".repeat(innerW));
    lines.push(`┌${border}┐`);
    lines.push(this.padLine(fg(this.t.title, "MCP setup"), innerW));
    for (const line of wrapText(this.discoverySummaryLine(), contentW)) {
      lines.push(this.padLine(line, innerW));
    }
    for (const line of wrapText(this.secondarySummaryLine(), contentW)) {
      lines.push(this.padLine(fg(this.t.muted, line), innerW));
    }
    lines.push(this.padLine("", innerW));

    if (this.state.notice) {
      const tones = { success: this.t.success, warning: this.t.warning, muted: this.t.hint };
      const tone = tones[this.state.notice.tone];
      for (const line of wrapText(this.state.notice.text, contentW)) {
        lines.push(this.padLine(fg(tone, line), innerW));
      }
      lines.push(this.padLine("", innerW));
    }

    lines.push(`├${border}┤`);

    if (this.state.screen === "imports") {
      lines.push(...this.renderImports(innerW));
    } else if (this.state.screen === "paths") {
      lines.push(...this.renderPaths(innerW));
    } else {
      lines.push(...this.renderActions(innerW));
    }

    lines.push(`└${border}┘`);
    return lines;
  }

  private renderActions(innerW: number): string[] {
    const lines: string[] = [];
    const actions = getSetupActions(this.state.discovery, this.state.screen);
    const compact = innerW < COMPACT_WIDTH;
    const { start, end } = compact
      ? this.visibleActionRange(actions.length)
      : { start: 0, end: actions.length };

    if (start > 0) {
      lines.push(this.padLine(fg(this.t.muted, `… ${start} more above`), innerW));
    }
    lines.push(...this.renderActionRows({ actions, start, end, innerW }));
    if (end < actions.length) {
      lines.push(this.padLine(fg(this.t.muted, `… ${actions.length - end} more below`), innerW));
    }
    lines.push(this.padLine("", innerW));

    const preview = this.previewOrError(
      (width) => this.preview.getActionPreview(actions[this.state.actionCursor], width),
      innerW,
    );
    for (const line of preview) {
      lines.push(this.padLine(line, innerW));
    }
    lines.push(this.padLine("", innerW));
    const hint = compact
      ? "Enter select · Esc back"
      : "Enter selects, Esc goes back, Ctrl+C closes.";
    lines.push(this.padLine(fg(this.t.muted, hint), innerW));
    return lines;
  }

  private renderActionRows(input: {
    actions: Action[];
    start: number;
    end: number;
    innerW: number;
  }): string[] {
    const { actions, start, end, innerW } = input;
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      const action = actions[index];
      if (!action) {
        continue;
      }
      if (
        action.id === "add-known-server" &&
        (index === start || actions[index - 1]?.id !== "add-known-server")
      ) {
        lines.push(this.padLine(fg(this.t.title, "Add a known server"), innerW));
      }
      const selected = index === this.state.actionCursor;
      const cursor = selected ? fg(this.t.selected, "›") : " ";
      lines.push(
        this.padLine(
          `${cursor} ${truncateToWidth(action.label, this.contentWidth(innerW) - 2)}`,
          innerW,
        ),
      );
    }

    return lines;
  }

  private renderImports(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(
      this.padLine(
        "Select compatibility imports. Space toggles, Enter saves, Esc goes back.",
        innerW,
      ),
    );
    lines.push(this.padLine("", innerW));
    for (let index = 0; index < this.state.discovery.imports.length; index++) {
      const entry = this.state.discovery.imports[index];
      if (!entry) {
        continue;
      }
      const selected = this.state.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
      const cursor = index === this.state.importCursor ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${selected} ${entry.kind}  ${entry.path}`, innerW));
    }
    lines.push(this.padLine("", innerW));
    const selected = this.state.discovery.imports
      .filter((entry) => this.state.selectedImports.has(entry.kind))
      .map((entry) => entry.kind);
    for (const line of this.previewOrError(
      (width) =>
        this.preview.formatWritePreview(
          "Compatibility import write preview",
          this.state.callbacks.previewImports(selected),
          [],
          width,
        ),
      innerW,
    )) {
      lines.push(this.padLine(line, innerW));
    }
    return lines;
  }

  private renderPaths(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(
      this.padLine("Select a detected config path to open. Enter opens it, Esc goes back.", innerW),
    );
    lines.push(this.padLine("", innerW));
    const paths = getDetectedPaths(this.state.discovery);
    for (let index = 0; index < paths.length; index++) {
      const cursor = index === this.state.pathCursor ? fg(this.t.selected, "›") : " ";
      const path = paths[index];
      if (path !== undefined) {
        lines.push(this.padLine(`${cursor} ${path}`, innerW));
      }
    }
    return lines;
  }

  private discoverySummaryLine(): string {
    if (!this.state.discovery.hasAnyConfig) {
      return fg(
        this.t.warning,
        this.state.options.onboardingState.setupCompleted
          ? "No MCP servers are active right now."
          : "No MCP config is active yet.",
      );
    }

    if (
      this.state.discovery.totalServerCount === 0 &&
      (this.state.discovery.imports.length > 0 ||
        Boolean(this.state.discovery.repoPrompt.executablePath))
    ) {
      return fg(
        this.t.warning,
        "Pi found MCP-related setup options, but none are active in Pi yet.",
      );
    }

    const shared = this.state.discovery.sources.filter(
      (source) => source.kind === "shared" && source.serverCount > 0,
    ).length;
    const piOwned = this.state.discovery.sources.filter(
      (source) => source.kind === "pi" && source.serverCount > 0,
    ).length;
    return fg(
      this.t.hint,
      `Detected ${this.state.discovery.totalServerCount} configured servers across ${shared} shared and ${piOwned} Pi-owned source${shared + piOwned === 1 ? "" : "s"}.`,
    );
  }

  private secondarySummaryLine(): string {
    const hostNote =
      this.state.discovery.hostConfigs.length > 0
        ? ` Host discovery is ${this.state.discovery.hostConfigDiscovery}; ${this.state.discovery.hostConfigs.length} host source${this.state.discovery.hostConfigs.length === 1 ? "" : "s"} detected.`
        : "";
    const conflictNote =
      this.state.discovery.conflicts.length > 0
        ? ` ${this.state.discovery.conflicts.length} same-name conflict${this.state.discovery.conflicts.length === 1 ? "" : "s"} reported.`
        : "";
    if (!this.state.discovery.hasAnyConfig) {
      return `Create a shared .mcp.json, adopt host imports, or quick-add RepoPrompt from this screen.${hostNote}${conflictNote}`;
    }
    if (this.state.discovery.totalServerCount === 0 && this.state.discovery.imports.length > 0) {
      return `Detected ${this.state.discovery.imports.length} compatibility import source${this.state.discovery.imports.length === 1 ? "" : "s"}. Adopt them into Pi or inspect the underlying files.${hostNote}${conflictNote}`;
    }
    return `Shared MCP files are preferred. Pi-owned files are only for compatibility imports and adapter-specific overrides.${hostNote}${conflictNote}`;
  }

  private visibleActionRange(total: number): { start: number; end: number } {
    if (total <= COMPACT_ACTION_ROWS) {
      return { start: 0, end: total };
    }
    const half = Math.floor(COMPACT_ACTION_ROWS / 2);
    const start = Math.min(
      Math.max(0, this.state.actionCursor - half),
      Math.max(0, total - COMPACT_ACTION_ROWS),
    );
    return { start, end: Math.min(total, start + COMPACT_ACTION_ROWS) };
  }

  private contentWidth(innerW: number): number {
    return Math.max(8, innerW - 4);
  }

  private previewWidth(innerW: number): number {
    return Math.max(12, Math.min(DESKTOP_PREVIEW_WIDTH, this.contentWidth(innerW)));
  }

  private previewOrError(preview: (width: number) => string[], innerW: number): string[] {
    const width = this.previewWidth(innerW);
    try {
      return preview(width);
    } catch (error) {
      return this.preview.formatPreview(
        [`Cannot preview write: ${error instanceof Error ? error.message : String(error)}`],
        width,
      );
    }
  }

  private padLine(text: string, innerW: number): string {
    const inset = 2;
    const contentW = Math.max(0, innerW - inset * 2);
    const fitted = truncateToWidth(text, contentW, "…", true);
    const plainWidth = visibleWidth(fitted);
    const padding = Math.max(0, contentW - plainWidth);
    return `│${" ".repeat(inset)}${fitted}${" ".repeat(padding)}${" ".repeat(inset)}│`;
  }
}
