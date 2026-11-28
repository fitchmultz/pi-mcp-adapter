import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ServerState, ToolState, VisibleItem } from "./mcp-panel-model.ts";
import {
  createPanelStyler,
  sanitizeDisplayText,
  sanitizeRowContent,
  type PanelStyler,
  type PanelThemeInput,
} from "./mcp-panel-text.ts";
import { formatTokenCount } from "./tool-metadata.ts";

export const PANEL_PAGE_SIZE = 12;

export interface PanelViewState {
  servers: readonly ServerState[];
  visibleItems: readonly VisibleItem[];
  cursorIndex: number;
  noticeLines: readonly string[];
  authOnly: boolean;
  descSearchActive: boolean;
  descQuery: string;
  nameQuery: string;
  importNotice: string | null;
  authNotice: string | null;
  authInFlight: string | null;
  confirmingDiscard: boolean;
  discardSelected: number;
  dirty: boolean;
  theme?: PanelThemeInput;
}

class PanelLayout {
  readonly innerW: number;
  private readonly s: PanelStyler;
  constructor(width: number, styler: PanelStyler) {
    this.innerW = width - 2;
    this.s = styler;
  }
  row(content: string): string {
    return (
      this.s.border("│") +
      truncateToWidth(" " + sanitizeRowContent(content), this.innerW, "…", true) +
      this.s.border("│")
    );
  }
  emptyRow(): string {
    return this.s.border("│") + " ".repeat(this.innerW) + this.s.border("│");
  }
  divider(): string {
    return this.s.border("├" + "─".repeat(this.innerW) + "┤");
  }
  title(text: string): string {
    const borderLen = this.innerW - visibleWidth(text);
    const left = Math.floor(borderLen / 2);
    return (
      this.s.border("╭" + "─".repeat(left)) +
      this.s.title(text) +
      this.s.border("─".repeat(borderLen - left) + "╮")
    );
  }
  bottom(): string {
    return this.s.border("╰" + "─".repeat(this.innerW) + "╯");
  }
}
export class PanelView {
  private readonly s: PanelStyler;
  private readonly state: PanelViewState;
  private readonly itemRows = new Map<number, number>();
  constructor(state: PanelViewState) {
    this.state = state;
    this.s = createPanelStyler(state.theme);
  }

  render(width: number): { lines: string[]; itemRows: ReadonlyMap<number, number> } {
    const layout = new PanelLayout(width, this.s);
    const lines = this.renderHeader(layout);
    this.renderBody(layout, lines);
    lines.push(...this.renderFooter(layout), layout.bottom());
    return { lines, itemRows: this.itemRows };
  }

  private renderHeader(layout: PanelLayout): string[] {
    const lines = [
      layout.title(this.state.authOnly ? " MCP OAuth " : " MCP Servers "),
      layout.emptyRow(),
    ];
    const cursor = this.s.selected("│");
    const searchIcon = this.s.border("◎");
    if (this.state.descSearchActive) {
      lines.push(
        layout.row(`${searchIcon}  ${this.s.needsAuth("desc:")} ${this.state.descQuery}${cursor}`),
      );
    } else if (this.state.nameQuery.length > 0) {
      lines.push(layout.row(`${searchIcon}  ${this.state.nameQuery}${cursor}`));
    } else {
      lines.push(layout.row(`${searchIcon}  ${this.s.placeholder(this.s.italic("search..."))}`));
    }
    lines.push(layout.emptyRow());
    if (this.state.noticeLines.length > 0) {
      for (const notice of this.state.noticeLines) {
        lines.push(layout.row(this.s.hint(this.s.italic(sanitizeDisplayText(notice)))));
      }
      lines.push(layout.emptyRow());
    }
    lines.push(layout.divider());
    return lines;
  }

  private renderBody(layout: PanelLayout, lines: string[]): void {
    if (this.state.servers.length === 0) {
      const message = this.state.authOnly
        ? "No OAuth-capable MCP servers configured."
        : "No MCP servers configured.";
      lines.push(
        layout.emptyRow(),
        layout.row(this.s.hint(this.s.italic(message))),
        layout.emptyRow(),
      );
      return;
    }
    const total = this.state.visibleItems.length;
    const start = Math.max(
      0,
      Math.min(this.state.cursorIndex - Math.floor(PANEL_PAGE_SIZE / 2), total - PANEL_PAGE_SIZE),
    );
    const end = Math.min(start + PANEL_PAGE_SIZE, total);
    lines.push(layout.emptyRow());
    for (let index = start; index < end; index++) {
      const item = this.state.visibleItems[index];
      if (item) {
        const itemLines = this.renderItem(item, index === this.state.cursorIndex, layout);
        if (itemLines.length > 0) {
          this.itemRows.set(lines.length, index);
          lines.push(...itemLines);
        }
      }
    }
    lines.push(layout.emptyRow());
    if (total > PANEL_PAGE_SIZE) {
      const progress = Math.round(((this.state.cursorIndex + 1) / total) * 10);
      lines.push(
        layout.row(
          `${this.s.progressBar(progress, 10)}  ${this.s.hint(`${this.state.cursorIndex + 1}/${total}`)}`,
        ),
        layout.emptyRow(),
      );
    }
    for (const notice of [this.state.importNotice, this.state.authNotice]) {
      if ((notice ?? "").length > 0) {
        lines.push(
          layout.row(this.s.needsAuth(this.s.italic(sanitizeDisplayText(notice)))),
          layout.emptyRow(),
        );
      }
    }
  }

  private renderItem(item: VisibleItem, selected: boolean, layout: PanelLayout): string[] {
    const server = this.state.servers[item.serverIndex];
    if (!server) {
      return [];
    }
    if (item.type === "server") {
      return this.renderServerDetails(server, selected, layout);
    }
    const tool = item.toolIndex === undefined ? undefined : server.tools[item.toolIndex];
    return tool ? [layout.row(this.renderToolRow(tool, selected, layout.innerW))] : [];
  }

  private renderServerDetails(
    server: ServerState,
    selected: boolean,
    layout: PanelLayout,
  ): string[] {
    const lines = [layout.row(this.renderServerRow(server, selected))];
    if (selected && !this.state.authOnly && server.resourceCount > 0) {
      lines.push(layout.row(this.s.hint("    Resources: mcp actions resources / read-resource")));
    }
    if (
      selected &&
      server.connectionStatus === "failed" &&
      (server.failureMessage ?? "").length > 0
    ) {
      for (const line of this.wrapText(
        sanitizeDisplayText(server.failureMessage),
        layout.innerW - 6,
      )) {
        lines.push(layout.row(`    ${this.s.cancel(line)}`));
      }
    }
    return lines;
  }

  private renderFooter(layout: PanelLayout): string[] {
    const lines = [layout.divider(), layout.emptyRow()];
    if (this.state.confirmingDiscard) {
      const discard =
        this.state.discardSelected === 0
          ? this.s.inverse(this.s.bold(this.s.cancel("  Discard  ")))
          : this.s.hint("  Discard  ");
      const keep =
        this.state.discardSelected === 1
          ? this.s.inverse(this.s.bold(this.s.confirm("  Keep & Close  ")))
          : this.s.hint("  Keep & Close  ");
      lines.push(layout.row(`Discard unsaved changes?  ${discard}   ${keep}`));
    } else if (this.state.authOnly) {
      lines.push(layout.row(this.s.description("select a server to authenticate")));
    } else {
      lines.push(
        layout.row(this.renderStatistics()),
        layout.row(this.s.hint("Pins load at startup; the rest load through tool_search.")),
      );
    }
    lines.push(layout.emptyRow(), ...this.renderHints(layout));
    return lines;
  }

  private renderStatistics(): string {
    const allTools = this.state.servers.flatMap((server) => server.tools);
    const direct = allTools.filter((tool) => tool.isDirect);
    const directTokens = direct.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
    const totalTokens = allTools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
    let stats: string;
    if (direct.length > 0) {
      stats = `${direct.length} pinned (~${formatTokenCount(directTokens)} tok) / ${allTools.length} total (~${formatTokenCount(totalTokens)} tok)`;
    } else if (allTools.length > 0) {
      stats = `no pinned tools (~${formatTokenCount(totalTokens)} tok total)`;
    } else {
      stats = "no pinned tools";
    }
    return this.s.description(stats + (this.state.dirty ? this.s.needsAuth("  (unsaved)") : ""));
  }

  private renderHints(layout: PanelLayout): string[] {
    const hints = this.state.authOnly
      ? [
          this.s.italic("↑↓") + " navigate",
          this.s.italic("⏎") + " auth",
          this.s.italic("ctrl+a") + " auth",
          this.s.italic("esc") + " clear/close",
          this.s.italic("ctrl+c") + " quit",
        ]
      : [
          this.s.italic("↑↓") + " navigate",
          this.s.italic("space") + " pin/unpin",
          this.s.italic("⏎") + " expand/auth",
          this.s.italic("ctrl+a") + " auth",
          this.s.italic("ctrl+r") + " reconnect",
          ...(this.selectedServerHasFailureMessage()
            ? [this.s.italic("ctrl+y") + " copy error"]
            : []),
          this.s.italic("?") + " desc search",
          this.s.italic("ctrl+s") + " save",
          this.s.italic("esc") + " clear/close",
          this.s.italic("ctrl+c") + " quit",
        ];
    const lines: string[] = [];
    let current = "";
    let currentWidth = 0;
    for (const hint of hints) {
      const width = visibleWidth(hint);
      const needed = currentWidth === 0 ? width : 2 + width;
      if (currentWidth > 0 && currentWidth + needed > layout.innerW - 2) {
        lines.push(layout.row(this.s.hint(current)));
        current = hint;
        currentWidth = width;
      } else {
        current += (currentWidth > 0 ? "  " : "") + hint;
        currentWidth += needed;
      }
    }
    if (current.length > 0) {
      lines.push(layout.row(this.s.hint(current)));
    }
    return lines;
  }

  private renderUncachedServerRow(
    prefix: string,
    server: ServerState,
    labels: { nameStr: string; importLabel: string; statusLabel: string },
  ): string {
    const locked = server.connectionStatus === "disabled";
    const suffix = locked ? "" : `  ${this.s.description("(undiscovered)")}`;
    return `${prefix}   ${labels.nameStr}${labels.importLabel}${labels.statusLabel}${suffix}`;
  }

  private renderServerRow(server: ServerState, isCursor: boolean): string {
    const expandIcon = server.expanded ? "▾" : "▸";
    let prefix = this.s.border("·");
    if (isCursor) {
      prefix = this.s.selected(expandIcon);
    } else if (server.expanded) {
      prefix = this.s.border(expandIcon);
    }

    const serverName = sanitizeDisplayText(server.name);
    const importKind = sanitizeDisplayText(server.importKind ?? "import");
    const nameStr = isCursor ? this.s.bold(this.s.selected(serverName)) : serverName;
    const importLabel = server.source === "import" ? this.s.description(` (${importKind})`) : "";
    const statusLabel = this.renderConnectionStatus(server);

    if (!server.hasCachedData && !this.state.authOnly) {
      return this.renderUncachedServerRow(prefix, server, { nameStr, importLabel, statusLabel });
    }

    const directCount = server.tools.filter((tool) => tool.isDirect).length;
    const totalCount = server.tools.length;
    const toggleIcon = this.serverToggleIcon(server, totalCount, directCount);

    const toolInfo = this.serverToolInfo(server, totalCount, directCount);

    return `${prefix} ${toggleIcon} ${nameStr}${importLabel}${statusLabel}  ${toolInfo}`;
  }

  private serverToggleIcon(server: ServerState, total: number, direct: number): string {
    if (server.connectionStatus === "disabled") {
      return this.s.description("⊘");
    }
    if (direct === total && total > 0) {
      return this.s.direct("●");
    }
    return direct > 0 ? this.s.needsAuth("◐") : this.s.description("○");
  }

  private serverToolInfo(server: ServerState, totalCount: number, directCount: number): string {
    if (this.state.authOnly) {
      return "";
    }
    const resources =
      server.resourceCount > 0
        ? `, ${server.resourceCount} resource${server.resourceCount === 1 ? "" : "s"}`
        : "";
    const totalTokens = server.tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
    const directTokens = server.tools
      .filter((tool) => tool.isDirect)
      .reduce((sum, tool) => sum + tool.estimatedTokens, 0);
    let tokenText = "";
    if (totalCount > 0) {
      tokenText =
        directCount > 0
          ? ` (~${formatTokenCount(directTokens)}/${formatTokenCount(totalTokens)} tok)`
          : ` (~${formatTokenCount(totalTokens)} tok)`;
    }
    return this.s.description(
      `${totalCount} tool${totalCount === 1 ? "" : "s"}, ${directCount} pinned${resources}${tokenText}`,
    );
  }

  private selectedServerHasFailureMessage(): boolean {
    const item = this.state.visibleItems[this.state.cursorIndex];
    if (!item) {
      return false;
    }
    const server = this.state.servers[item.serverIndex];
    return server?.connectionStatus === "failed" && Boolean(server.failureMessage);
  }

  private wrapText(text: string, width: number): string[] {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (normalized.length === 0) {
      return [text];
    }
    return wrapTextWithAnsi(normalized, Math.max(8, width));
  }

  private renderConnectionStatus(server: ServerState): string {
    if (this.state.authInFlight === server.name) {
      return `  ${this.s.needsAuth("authenticating")}`;
    }
    if (server.connectionStatus === "disabled") {
      return `  ${this.s.description("disabled")}`;
    }
    if (server.connectionStatus === "needs-auth") {
      return `  ${this.s.needsAuth("needs auth")}`;
    }
    if (server.connectionStatus === "connecting") {
      return `  ${this.s.needsAuth("connecting")}`;
    }
    if (server.connectionStatus === "failed") {
      return `  ${this.s.cancel("failed")}`;
    }
    if (this.state.authOnly && server.connectionStatus === "connected") {
      return `  ${this.s.direct("connected")}`;
    }
    if (this.state.authOnly) {
      return `  ${this.s.description("idle")}`;
    }
    return "";
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
    const toggleIcon = tool.isDirect ? this.s.direct("●") : this.s.description("○");
    const cursor = isCursor ? this.s.selected("▸") : " ";
    const toolName = sanitizeDisplayText(tool.name);
    const description = sanitizeDisplayText(tool.description);
    const nameStr = isCursor ? this.s.bold(this.s.selected(toolName)) : toolName;
    const tokLabel = `~${formatTokenCount(tool.estimatedTokens)}t`;
    const tokStr = this.s.description(tokLabel);

    const prefixLen = 8 + visibleWidth(toolName) + visibleWidth(tokLabel);
    const maxDescLen = Math.max(0, innerW - prefixLen - 8);
    const descStr =
      maxDescLen > 5 && description.length > 0
        ? this.s.description("— " + truncateToWidth(description, maxDescLen, "…"))
        : "";

    return `  ${cursor} ${toggleIcon} ${nameStr} ${tokStr} ${descStr}`;
  }
}
