import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.ts";
import type { MetadataCache, ServerCacheEntry } from "./metadata-cache.ts";
import { PanelConnections } from "./mcp-panel-connections.ts";
import {
  type PanelServer,
  buildPanelServers,
  buildVisibleItems,
  type VisibleItem,
} from "./mcp-panel-model.ts";
import { PanelView } from "./mcp-panel-view.ts";

interface McpPanelInput {
  config: McpConfig;
  cache: MetadataCache | null;
  provenance: Map<string, ServerProvenance>;
  callbacks: McpPanelCallbacks;
  tui: Pick<TUI, "requestRender">;
  done: (result: McpPanelResult) => void;
  options?: { noticeLines?: string[]; authOnly?: boolean; keybindings?: PanelKeybindings };
}

/**
 * What the next keypress edits. Name filtering is orthogonal: it stays applied while browsing and
 * while searching descriptions.
 */
type PanelInputMode =
  | { kind: "browse" }
  | { kind: "description-search"; query: string }
  | { kind: "confirm-discard"; selected: number };

class McpPanel implements Component {
  private readonly noticeLines: string[];
  private readonly servers: PanelServer[];
  private cursorIndex = 0;
  private nameQuery = "";
  private mode: PanelInputMode = { kind: "browse" };
  private dirty = false;
  private importNotice: string | null = null;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private readonly authOnly: boolean;
  private readonly keys: PanelKeys;

  private static readonly INACTIVITY_MS = 60_000;

  private readonly connections: PanelConnections;
  private readonly done: (result: McpPanelResult) => void;

  constructor(input: McpPanelInput) {
    const { config, cache, provenance, callbacks, tui, done, options = {} } = input;
    this.connections = new PanelConnections({
      callbacks,
      tui,
      refreshTools: (server, entry) => this.rebuildServerTools(server, entry),
    });
    this.done = done;
    this.noticeLines = options.noticeLines ?? [];
    this.authOnly = options.authOnly === true;
    this.keys = createPanelKeys(options.keybindings);

    this.servers = buildPanelServers({
      config,
      cache,
      provenance,
      callbacks,
      authOnly: this.authOnly,
    });
    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
    }, McpPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private rebuildVisibleItems(): void {
    this.visibleItems = buildVisibleItems({
      servers: this.servers,
      descSearchActive: this.mode.kind === "description-search",
      descQuery: this.mode.kind === "description-search" ? this.mode.query : "",
      nameQuery: this.nameQuery,
      authOnly: this.authOnly,
    });
  }

  private updateDirty(): void {
    this.dirty = this.servers.some((s) => s.data.tools.some((t) => t.isDirect !== t.wasDirect));
  }

  private buildResult(): McpPanelResult {
    const changes = new Map<string, true | string[] | false>();
    for (const server of this.servers) {
      const changed = server.data.tools.some((t) => t.isDirect !== t.wasDirect);
      if (!changed) {
        continue;
      }
      const directTools = server.data.tools.filter((t) => t.isDirect);
      if (directTools.length === server.data.tools.length && server.data.tools.length > 0) {
        changes.set(server.data.name, true);
      } else if (directTools.length === 0) {
        changes.set(server.data.name, false);
      } else {
        changes.set(
          server.data.name,
          directTools.map((t) => t.name),
        );
      }
    }
    return { changes, cancelled: false };
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;
    if ((this.connections.inFlight ?? "").length === 0) {
      this.connections.notice = null;
    }
    if (this.mode.kind === "confirm-discard") {
      this.handleDiscardInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.closeCancelled();
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.cleanup();
      this.done(this.buildResult());
      return;
    }
    if (this.mode.kind === "description-search") {
      this.handleDescriptionInput(data, this.mode);
      return;
    }
    this.handleBrowseInput(data);
  }

  private closeCancelled(): void {
    this.cleanup();
    this.done({ cancelled: true, changes: new Map() });
  }
  private refreshSelection(): void {
    this.rebuildVisibleItems();
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
  }
  private handleNavigation(data: string): boolean {
    if (this.keys.selectUp(data)) {
      this.moveCursor(-1);
      return true;
    }
    if (this.keys.selectDown(data)) {
      this.moveCursor(1);
      return true;
    }
    return false;
  }
  private handleDescriptionInput(
    data: string,
    { query }: { kind: "description-search"; query: string },
  ): void {
    if (matchesKey(data, "escape") || this.keys.selectConfirm(data)) {
      this.mode = { kind: "browse" };
      this.refreshSelection();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (query.length > 0) {
        this.mode = { kind: "description-search", query: query.slice(0, -1) };
        this.refreshSelection();
      }
      return;
    }
    if (this.handleNavigation(data)) {
      return;
    }
    if (matchesKey(data, "space")) {
      // Toggle even while in desc search
      const item = this.visibleItems[this.cursorIndex];
      if (item) {
        this.toggleItem(item);
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.mode = { kind: "description-search", query: query + data };
      this.refreshSelection();
      return;
    }
    return;
  }
  private handleBrowseInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.handleEscape();
      return;
    }
    if (this.handleNavigation(data)) {
      return;
    }
    if (matchesKey(data, "space")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item && !this.authOnly) {
        this.toggleItem(item);
      }
      return;
    }
    if (this.keys.selectConfirm(data)) {
      this.confirmSelection();
      return;
    }
    if (matchesKey(data, "ctrl+a")) {
      this.authenticateSelectedServer();
      return;
    }
    if (matchesKey(data, "ctrl+r")) {
      this.reconnectSelectedServer();
      return;
    }
    this.handleSearchOrCopyInput(data);
  }
  private handleEscape(): void {
    if (this.nameQuery.length > 0) {
      this.nameQuery = "";
      this.refreshSelection();
      return;
    }
    if (this.dirty) {
      this.mode = { kind: "confirm-discard", selected: 1 };
      return;
    }
    this.closeCancelled();
  }
  private confirmSelection(): void {
    const item = this.visibleItems[this.cursorIndex];
    if (!item) {
      return;
    }
    const server = this.servers[item.serverIndex];
    if (!server) {
      return;
    }
    if (item.type === "server") {
      if (server.data.connectionStatus === "disabled") {
        return;
      }
      if (this.authOnly || server.data.connectionStatus === "needs-auth") {
        this.connections.authenticate(server);
        return;
      }
      server.data.expanded = !server.data.expanded;
      this.refreshSelection();
    } else if (item.toolIndex !== undefined) {
      this.toggleTool(item.serverIndex, item.toolIndex);
      this.updateDirty();
    }
    return;
  }
  private copySelectedError(): void {
    const item = this.visibleItems[this.cursorIndex];
    const server = item === undefined ? undefined : this.servers[item.serverIndex];
    if (server) {
      this.connections.copyError(server);
    }
  }

  private handleSearchOrCopyInput(data: string): void {
    if (matchesKey(data, "ctrl+y")) {
      this.copySelectedError();
      return;
    }

    if (data === "?") {
      if (this.authOnly) {
        return;
      }
      this.mode = { kind: "description-search", query: "" };
      this.refreshSelection();
      return;
    }

    // Backspace removes from name query
    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.refreshSelection();
      }
      return;
    }

    // All other printable chars → always-on name search
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.nameQuery += data;
      this.refreshSelection();
      return;
    }
  }

  private selectedServer(): PanelServer | undefined {
    const item = this.visibleItems[this.cursorIndex];
    return item === undefined ? undefined : this.servers[item.serverIndex];
  }

  private reconnectSelectedServer(): void {
    const server = this.selectedServer();
    if (server) {
      this.connections.reconnect(server);
    }
  }

  private authenticateSelectedServer(): void {
    const server = this.selectedServer();
    if (server) {
      this.connections.authenticate(server);
    }
  }

  private toggleTool(serverIndex: number, toolIndex: number): void {
    const server = this.servers[serverIndex];
    const tool = server?.data.tools[toolIndex];
    if (!tool) {
      return;
    }
    tool.isDirect = !tool.isDirect;
    if (tool.isDirect && server.data.source === "import") {
      this.importNotice = "Only tool selections save to Pi config.";
    }
  }

  private toggleItem(item: VisibleItem): void {
    if (this.authOnly) {
      return;
    }
    const server = this.servers[item.serverIndex];
    if (!server) {
      return;
    }
    if (item.type === "server") {
      const newState = !server.data.tools.every((t) => t.isDirect);
      if (server.data.source === "import" && newState) {
        this.importNotice = "Only tool selections save to Pi config.";
      }
      for (const t of server.data.tools) {
        t.isDirect = newState;
      }
    } else if (item.toolIndex !== undefined) {
      this.toggleTool(item.serverIndex, item.toolIndex);
    }
    this.updateDirty();
  }

  private handleDiscardInput(data: string): void {
    if (this.mode.kind !== "confirm-discard") {
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
      this.mode = { kind: "browse" };
      return;
    }
    if (this.keys.selectConfirm(data)) {
      this.cleanup();
      if (this.mode.selected === 0) {
        this.done({ cancelled: true, changes: new Map() });
      } else {
        this.done(this.buildResult());
      }
      return;
    }
    if (data.toLowerCase() === "y") {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    this.handleDiscardNavigation(data);
  }

  private handleDiscardNavigation(data: string): void {
    if (this.mode.kind !== "confirm-discard") {
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.mode = { kind: "confirm-discard", selected: this.mode.selected === 0 ? 1 : 0 };
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) {
      return;
    }
    this.cursorIndex = Math.max(
      0,
      Math.min(this.visibleItems.length - 1, this.cursorIndex + delta),
    );
  }

  private rebuildServerTools(server: PanelServer, entry: ServerCacheEntry): void {
    server.rebuildTools(entry);
    this.rebuildVisibleItems();
    this.updateDirty();
  }

  render(width: number): string[] {
    return new PanelView({
      servers: this.servers.map((server) => server.data),
      visibleItems: this.visibleItems,
      cursorIndex: this.cursorIndex,
      noticeLines: this.noticeLines,
      authOnly: this.authOnly,
      descSearchActive: this.mode.kind === "description-search",
      descQuery: this.mode.kind === "description-search" ? this.mode.query : "",
      nameQuery: this.nameQuery,
      importNotice: this.importNotice,
      authNotice: this.connections.notice,
      authInFlight: this.connections.inFlight,
      confirmingDiscard: this.mode.kind === "confirm-discard",
      discardSelected: this.mode.kind === "confirm-discard" ? this.mode.selected : 1,
      dirty: this.dirty,
    }).render(width);
  }
  invalidate(): void {
    // Lines are rendered from state on every call; no layout is cached.
  }

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpPanel(input: McpPanelInput): McpPanel {
  return new McpPanel(input);
}
