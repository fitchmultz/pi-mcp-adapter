import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ServerState, ToolState, VisibleItem } from "./mcp-panel-model.ts";
import {
  DEFAULT_THEME,
  fg,
  rainbowProgress,
  sanitizeDisplayText,
  sanitizeRowContent,
} from "./mcp-panel-text.ts";
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
}

const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
const italic = (text: string): string => `\x1b[3m${text}\x1b[23m`;
const inverse = (text: string): string => `\x1b[7m${text}\x1b[27m`;

class PanelLayout {
  readonly innerW: number;
  constructor(width: number) {
    this.innerW = width - 2;
  }
  row(content: string): string {
    return (
      fg(DEFAULT_THEME.border, "│") +
      truncateToWidth(" " + sanitizeRowContent(content), this.innerW, "…", true) +
      fg(DEFAULT_THEME.border, "│")
    );
  }
  emptyRow(): string {
    return fg(DEFAULT_THEME.border, "│") + " ".repeat(this.innerW) + fg(DEFAULT_THEME.border, "│");
  }
  divider(): string {
    return fg(DEFAULT_THEME.border, "├" + "─".repeat(this.innerW) + "┤");
  }
  title(text: string): string {
    const borderLen = this.innerW - visibleWidth(text);
    const left = Math.floor(borderLen / 2);
    return (
      fg(DEFAULT_THEME.border, "╭" + "─".repeat(left)) +
      fg(DEFAULT_THEME.title, text) +
      fg(DEFAULT_THEME.border, "─".repeat(borderLen - left) + "╮")
    );
  }
  bottom(): string {
    return fg(DEFAULT_THEME.border, "╰" + "─".repeat(this.innerW) + "╯");
  }
}
export class PanelView {
  private readonly t = DEFAULT_THEME;
  private readonly state: PanelViewState;
  constructor(state: PanelViewState) {
    this.state = state;
  }

  render(width: number): string[] {
    const layout = new PanelLayout(width);
    return [
      ...this.renderHeader(layout),
      ...this.renderBody(layout),
      ...this.renderFooter(layout),
      layout.bottom(),
    ];
  }

  private renderHeader(layout: PanelLayout): string[] {
    const lines = [
      layout.title(this.state.authOnly ? " MCP OAuth " : " MCP Servers "),
      layout.emptyRow(),
    ];
    const cursor = fg(this.t.selected, "│");
    const searchIcon = fg(this.t.border, "◎");
    if (this.state.descSearchActive) {
      lines.push(
        layout.row(
          `${searchIcon}  ${fg(this.t.needsAuth, "desc:")} ${this.state.descQuery}${cursor}`,
        ),
      );
    } else if (this.state.nameQuery.length > 0) {
      lines.push(layout.row(`${searchIcon}  ${this.state.nameQuery}${cursor}`));
    } else {
      lines.push(layout.row(`${searchIcon}  ${fg(this.t.placeholder, italic("search..."))}`));
    }
    lines.push(layout.emptyRow());
    if (this.state.noticeLines.length > 0) {
      for (const notice of this.state.noticeLines) {
        lines.push(layout.row(fg(this.t.hint, italic(sanitizeDisplayText(notice)))));
      }
      lines.push(layout.emptyRow());
    }
    lines.push(layout.divider());
    return lines;
  }

  private renderBody(layout: PanelLayout): string[] {
    if (this.state.servers.length === 0) {
      const message = this.state.authOnly
        ? "No OAuth-capable MCP servers configured."
        : "No MCP servers configured.";
      return [layout.emptyRow(), layout.row(fg(this.t.hint, italic(message))), layout.emptyRow()];
    }
    const total = this.state.visibleItems.length;
    const maxVisible = 12;
    const start = Math.max(
      0,
      Math.min(this.state.cursorIndex - Math.floor(maxVisible / 2), total - maxVisible),
    );
    const end = Math.min(start + maxVisible, total);
    const lines = [layout.emptyRow()];
    for (let index = start; index < end; index++) {
      const item = this.state.visibleItems[index];
      if (item) {
        lines.push(...this.renderItem(item, index === this.state.cursorIndex, layout));
      }
    }
    lines.push(layout.emptyRow());
    if (total > maxVisible) {
      const progress = Math.round(((this.state.cursorIndex + 1) / total) * 10);
      lines.push(
        layout.row(
          `${rainbowProgress(progress, 10)}  ${fg(this.t.hint, `${this.state.cursorIndex + 1}/${total}`)}`,
        ),
        layout.emptyRow(),
      );
    }
    for (const notice of [this.state.importNotice, this.state.authNotice]) {
      if ((notice ?? "").length > 0) {
        lines.push(
          layout.row(fg(this.t.needsAuth, italic(sanitizeDisplayText(notice)))),
          layout.emptyRow(),
        );
      }
    }
    return lines;
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
      lines.push(
        layout.row(fg(this.t.hint, "    Resources: mcp actions resources / read-resource")),
      );
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
        lines.push(layout.row(`    ${fg(this.t.cancel, line)}`));
      }
    }
    return lines;
  }

  private renderFooter(layout: PanelLayout): string[] {
    const lines = [layout.divider(), layout.emptyRow()];
    if (this.state.confirmingDiscard) {
      const discard =
        this.state.discardSelected === 0
          ? inverse(bold(fg(this.t.cancel, "  Discard  ")))
          : fg(this.t.hint, "  Discard  ");
      const keep =
        this.state.discardSelected === 1
          ? inverse(bold(fg(this.t.confirm, "  Keep & Close  ")))
          : fg(this.t.hint, "  Keep & Close  ");
      lines.push(layout.row(`Discard unsaved changes?  ${discard}   ${keep}`));
    } else if (this.state.authOnly) {
      lines.push(layout.row(fg(this.t.description, "select a server to authenticate")));
    } else {
      lines.push(
        layout.row(this.renderStatistics()),
        layout.row(fg(this.t.hint, "Pins load at startup; the rest load through tool_search.")),
      );
    }
    lines.push(layout.emptyRow(), ...this.renderHints(layout));
    return lines;
  }

  private renderStatistics(): string {
    const direct = this.state.servers.flatMap((server) =>
      server.tools.filter((tool) => tool.isDirect),
    );
    const tokens = direct.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
    const stats =
      direct.length > 0
        ? `${direct.length} pinned  ~${tokens.toLocaleString()} tokens`
        : "no pinned tools";
    return fg(
      this.t.description,
      stats + (this.state.dirty ? fg(this.t.needsAuth, "  (unsaved)") : ""),
    );
  }

  private renderHints(layout: PanelLayout): string[] {
    const hints = this.state.authOnly
      ? [
          italic("↑↓") + " navigate",
          italic("⏎") + " auth",
          italic("ctrl+a") + " auth",
          italic("esc") + " clear/close",
          italic("ctrl+c") + " quit",
        ]
      : [
          italic("↑↓") + " navigate",
          italic("space") + " pin/unpin",
          italic("⏎") + " expand/auth",
          italic("ctrl+a") + " auth",
          italic("ctrl+r") + " reconnect",
          ...(this.selectedServerHasFailureMessage() ? [italic("ctrl+y") + " copy error"] : []),
          italic("?") + " desc search",
          italic("ctrl+s") + " save",
          italic("esc") + " clear/close",
          italic("ctrl+c") + " quit",
        ];
    const lines: string[] = [];
    let current = "";
    let currentWidth = 0;
    for (const hint of hints) {
      const width = visibleWidth(hint);
      const needed = currentWidth === 0 ? width : 2 + width;
      if (currentWidth > 0 && currentWidth + needed > layout.innerW - 2) {
        lines.push(layout.row(fg(this.t.hint, current)));
        current = hint;
        currentWidth = width;
      } else {
        current += (currentWidth > 0 ? "  " : "") + hint;
        currentWidth += needed;
      }
    }
    if (current.length > 0) {
      lines.push(layout.row(fg(this.t.hint, current)));
    }
    return lines;
  }

  private renderServerRow(server: ServerState, isCursor: boolean): string {
    const t = this.t;

    const expandIcon = server.expanded ? "▾" : "▸";
    const prefix = isCursor
      ? fg(t.selected, expandIcon)
      : fg(t.border, server.expanded ? expandIcon : "·");

    const serverName = sanitizeDisplayText(server.name);
    const importKind = sanitizeDisplayText(server.importKind ?? "import");
    const nameStr = isCursor ? bold(fg(t.selected, serverName)) : serverName;
    const importLabel = server.source === "import" ? fg(t.description, ` (${importKind})`) : "";
    const statusLabel = this.renderConnectionStatus(server);

    if (!server.hasCachedData && !this.state.authOnly) {
      return `${prefix}   ${nameStr}${importLabel}${statusLabel}  ${fg(t.description, "(undiscovered)")}`;
    }

    const directCount = server.tools.filter((tool) => tool.isDirect).length;
    const totalCount = server.tools.length;
    const toggleIcon = this.serverToggleIcon(totalCount, directCount);

    const toolInfo = this.serverToolInfo(server, totalCount, directCount);

    return `${prefix} ${toggleIcon} ${nameStr}${importLabel}${statusLabel}  ${toolInfo}`;
  }

  private serverToggleIcon(total: number, direct: number): string {
    if (direct === total && total > 0) {
      return fg(this.t.direct, "●");
    }
    return direct > 0 ? fg(this.t.needsAuth, "◐") : fg(this.t.description, "○");
  }

  private serverToolInfo(server: ServerState, totalCount: number, directCount: number): string {
    if (this.state.authOnly) {
      return "";
    }
    const resources =
      server.resourceCount > 0
        ? `, ${server.resourceCount} resource${server.resourceCount === 1 ? "" : "s"}`
        : "";
    return fg(
      this.t.description,
      `${totalCount} tool${totalCount === 1 ? "" : "s"}, ${directCount} pinned${resources}`,
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
    const max = Math.max(8, width);
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    const splitLongWord = (word: string): string => {
      let rest = word;
      while (visibleWidth(rest) > max) {
        let take = "";
        let index = 0;
        while (index < rest.length && visibleWidth(take + rest.charAt(index)) <= max) {
          take += rest.charAt(index);
          index++;
        }
        if (take.length === 0) {
          take = rest.charAt(0);
        }
        lines.push(take);
        rest = rest.slice(take.length);
      }
      return rest;
    };

    for (const word of words) {
      const candidate = current.length > 0 ? `${current} ${word}` : word;
      if (visibleWidth(candidate) <= max) {
        current = candidate;
      } else {
        if (current.length > 0) {
          lines.push(current);
        }
        current = splitLongWord(word);
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
    return lines.length > 0 ? lines : [text];
  }

  private renderConnectionStatus(server: ServerState): string {
    const t = this.t;
    if (this.state.authInFlight === server.name) {
      return `  ${fg(t.needsAuth, "authenticating")}`;
    }
    if (server.connectionStatus === "disabled") {
      return `  ${fg(t.description, "disabled")}`;
    }
    if (server.connectionStatus === "needs-auth") {
      return `  ${fg(t.needsAuth, "needs auth")}`;
    }
    if (server.connectionStatus === "connecting") {
      return `  ${fg(t.needsAuth, "connecting")}`;
    }
    if (server.connectionStatus === "failed") {
      return `  ${fg(t.cancel, "failed")}`;
    }
    if (this.state.authOnly && server.connectionStatus === "connected") {
      return `  ${fg(t.direct, "connected")}`;
    }
    if (this.state.authOnly) {
      return `  ${fg(t.description, "idle")}`;
    }
    return "";
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
    const t = this.t;

    const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○");
    const cursor = isCursor ? fg(t.selected, "▸") : " ";
    const toolName = sanitizeDisplayText(tool.name);
    const description = sanitizeDisplayText(tool.description);
    const nameStr = isCursor ? bold(fg(t.selected, toolName)) : toolName;

    const prefixLen = 7 + visibleWidth(toolName);
    const maxDescLen = Math.max(0, innerW - prefixLen - 8);
    const descStr =
      maxDescLen > 5 && description.length > 0
        ? fg(t.description, "— " + truncateToWidth(description, maxDescLen, "…"))
        : "";

    return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`;
  }
}
