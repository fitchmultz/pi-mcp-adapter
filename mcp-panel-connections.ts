import type { TUI } from "@earendil-works/pi-tui";
import type { McpPanelCallbacks } from "./types.ts";
import type { ServerCacheEntry } from "./metadata-cache.ts";
import type { PanelServer } from "./mcp-panel-model.ts";
import { sanitizeDisplayText } from "./mcp-panel-text.ts";

interface PanelConnectionsInput {
  callbacks: McpPanelCallbacks;
  tui: Pick<TUI, "requestRender">;
  refreshTools: (server: PanelServer, entry: ServerCacheEntry) => void;
}

export class PanelConnections {
  notice: string | null = null;
  inFlight: string | null = null;
  private readonly input: PanelConnectionsInput;
  constructor(input: PanelConnectionsInput) {
    this.input = input;
  }
  authenticate(server: PanelServer): void {
    if ((this.inFlight ?? "").length > 0) {
      return;
    }
    if (
      server.data.connectionStatus === "connecting" ||
      server.data.connectionStatus === "disabled"
    ) {
      return;
    }
    const serverName = sanitizeDisplayText(server.data.name);
    if (!this.input.callbacks.canAuthenticate(server.data.name)) {
      this.notice = `${serverName} does not use OAuth authentication.`;
      return;
    }

    this.inFlight = server.data.name;
    this.notice = `Authenticating ${serverName}...`;
    this.input.tui.requestRender();

    this.input.callbacks
      .authenticate(server.data.name)
      .then((result) => {
        server.setConnectionStatus(this.input.callbacks.getConnectionStatus(server.data.name));
        if (result.ok) {
          this.notice = `OAuth finished for ${serverName}. Reconnecting...`;
          this.inFlight = null;
          this.input.tui.requestRender();
          this.reconnect(server, { afterAuth: true });
          return;
        }

        const message = sanitizeDisplayText(result.message);
        this.notice = `OAuth failed for ${serverName}${message.length > 0 ? `: ${message}` : ". Check the notification for details."}`;
        this.inFlight = null;
        this.input.tui.requestRender();
      })
      .catch((error: unknown) => {
        const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
        server.setConnectionStatus(this.input.callbacks.getConnectionStatus(server.data.name));
        this.notice = `OAuth failed for ${serverName}: ${message}`;
        this.inFlight = null;
        this.input.tui.requestRender();
      });
  }

  reconnect(server: PanelServer, options: { afterAuth?: boolean } = {}): void {
    if (
      server.data.connectionStatus === "connecting" ||
      server.data.connectionStatus === "disabled"
    ) {
      return;
    }
    const serverName = sanitizeDisplayText(server.data.name);
    server.setConnectionStatus("connecting");
    this.input.tui.requestRender();

    this.input.callbacks
      .reconnect(server.data.name, options.afterAuth)
      .then((connected) => {
        server.refreshConnection(this.input.callbacks);
        if (server.data.connectionStatus === "connected") {
          const entry = this.input.callbacks.refreshCacheAfterReconnect(server.data.name);
          if (entry) {
            this.input.refreshTools(server, entry);
          }
        }
        if (options.afterAuth === true) {
          this.notice =
            connected && server.data.connectionStatus === "connected"
              ? `OAuth finished for ${serverName}. Reconnected.`
              : `OAuth finished for ${serverName}, but reconnect did not complete. Press ctrl+r to retry.`;
        }
        this.input.tui.requestRender();
      })
      .catch((error: unknown) => {
        server.setConnectionStatus("failed");
        const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
        this.notice = `Reconnect failed for ${serverName}: ${message}`;
        this.input.tui.requestRender();
      });
  }

  copyError(server: PanelServer): void {
    if (
      server.data.connectionStatus !== "failed" ||
      (server.data.failureMessage ?? "").length === 0
    ) {
      return;
    }
    const serverName = sanitizeDisplayText(server.data.name);
    const failureMessage = sanitizeDisplayText(server.data.failureMessage);
    import("@earendil-works/pi-coding-agent")
      .then(({ copyToClipboard }) => copyToClipboard(failureMessage))
      .then(() => {
        this.notice = `Copied error for ${serverName} to clipboard`;
        this.input.tui.requestRender();
      })
      .catch((error: unknown) => {
        const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
        this.notice = `Failed to copy error for ${serverName}: ${message}`;
        this.input.tui.requestRender();
      });
    return;
  }
}
