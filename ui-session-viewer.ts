import { execFile } from "node:child_process";
import net from "node:net";
import type { McpExtensionState } from "./state.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import type { UiSessionRequest, UiSessionViewer } from "./ui-session-contracts.ts";
import { isGlimpseAvailable, openGlimpseWindow } from "./glimpse-ui.ts";
import { isAbortError } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import { logger } from "./logger.ts";

/** One process-wide optional viewer; session replacement closes it before opening another. */
let activeGlimpseWindow: { close: () => void } | null = null;

export function closeActiveUiWindow(): void {
  if (activeGlimpseWindow) {
    activeGlimpseWindow.close();
    activeGlimpseWindow = null;
  }
}

interface ViewerContext {
  state: McpExtensionState;
  request: UiSessionRequest;
  handle: UiServerHandle;
  signal: AbortSignal;
  isActive: () => boolean;
}
interface ViewerResult {
  viewer: UiSessionViewer;
  windowOpen: boolean;
}

export async function openUiViewer(context: ViewerContext): Promise<ViewerResult> {
  const viewer = new UiViewer(context);
  return viewer.open();
}

/** Optional viewers do not own the HTTP session or the call's stream listener. */
class UiViewer {
  private readonly context: ViewerContext;
  private readonly remoteByEnv =
    Boolean(process.env.SSH_CONNECTION) || Boolean(process.env.SSH_TTY);
  private readonly preference = process.env.MCP_UI_VIEWER?.toLowerCase();
  private readonly log: ReturnType<typeof logger.child>;

  constructor(context: ViewerContext) {
    this.context = context;
    this.log = logger.child({
      component: "UiSession",
      server: context.request.serverName,
      tool: context.request.toolName,
    });
  }

  async open(): Promise<ViewerResult> {
    const { state, handle } = this.context;
    const preference = this.preference;
    if (preference === "none" || preference === "off" || preference === "disabled") {
      state.ui?.notify(
        `MCP UI window suppressed (MCP_UI_VIEWER=${preference}). Open manually: ${handle.url}`,
        "info",
      );
      this.log.info(`Suppressing MCP UI window (MCP_UI_VIEWER=${preference})`, { url: handle.url });
      return { viewer: "suppressed", windowOpen: false };
    }
    const remoteLikely = this.remoteByEnv || (await hasActiveRemoteLogin());
    const glimpseDetected = !this.remoteByEnv && isGlimpseAvailable();
    const useGlimpse = this.useGlimpse(glimpseDetected);
    if (useGlimpse) {
      return this.openLocalWindow(remoteLikely);
    }
    await this.browserWithHint(remoteLikely);
    return { viewer: "browser", windowOpen: true };
  }

  private useGlimpse(detected: boolean): boolean {
    return (
      !this.remoteByEnv &&
      (this.preference === "glimpse" || (this.preference !== "browser" && detected))
    );
  }

  private async openLocalWindow(remoteLikely: boolean): Promise<ViewerResult> {
    const { state, request, handle, signal, isActive } = this.context;
    try {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden}iframe{width:100%;height:100%;border:none}</style></head><body><iframe src="${handle.url}"></iframe></body></html>`;
      const glimpseWindow = await openGlimpseWindow(html, {
        title: `MCP · ${request.serverName} · ${request.toolName}`,
        width: 1000,
        height: 800,
        onClosed: () => {
          if (isActive()) {
            handle.close("glimpse-closed");
          }
        },
      });
      if (!state.owner.isActive() || signal.aborted) {
        glimpseWindow.close();
        throwIfAborted(signal);
        throw new Error("MCP Glimpse window became stale before registration");
      }
      activeGlimpseWindow = glimpseWindow;
      if (remoteLikely) {
        await this.emitRemoteHint(null, true);
      }
      return { viewer: "glimpse", windowOpen: true };
    } catch (error) {
      this.log.debug("Glimpse unavailable, using browser", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.browserWithHint(remoteLikely);
      return { viewer: "browser", windowOpen: true };
    }
  }

  private async browserWithHint(remoteLikely: boolean): Promise<void> {
    const openError = await this.openBrowser();
    if (openError !== null || remoteLikely) {
      await this.emitRemoteHint(openError);
    }
  }

  private async openBrowser(): Promise<string | null> {
    const { state, handle, signal } = this.context;
    throwIfAborted(signal);
    try {
      await state.openBrowser(handle.url);
      throwIfAborted(signal);
      return null;
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!state.owner.isActive()) {
        return null;
      }
      state.ui?.notify(`MCP UI browser open failed: ${message}`, "warning");
      return message;
    }
  }

  private async emitRemoteHint(openError: string | null, openedOnHost = false): Promise<void> {
    const { state, handle } = this.context;
    state.ui?.notify(
      remoteAccessHint({
        url: handle.url,
        port: handle.port,
        moshi: await probeMoshiGateway(),
        openError,
        openedOnHost,
      }),
      openError === null ? "info" : "warning",
    );
  }
}

function hasActiveRemoteLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("who", { encoding: "utf8", timeout: 2000 }, (error, out) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(/\(.+\)\s*$/m.test(out));
    });
  });
}

function probeMoshiGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 24543 });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function remoteAccessHint(opts: {
  url: string;
  port: number;
  moshi: boolean;
  openError: string | null;
  openedOnHost?: boolean;
}): string {
  let introduction =
    "This looks like a remote session - if no MCP UI appeared, open it from your own device:";
  if (opts.openError !== null) {
    introduction = "Couldn't open MCP UI here. Open it from your own device:";
  } else if (opts.openedOnHost === true) {
    introduction =
      "MCP UI opened on this host. If you're controlling this session remotely, open it from your own device:";
  }
  const lines = [introduction, `  ${opts.url}`];
  if (opts.openError !== null) {
    lines.push(`Browser launch failed: ${opts.openError}`);
  }
  if (opts.moshi) {
    lines.push(
      "Moshi: tap the preview button in the terminal title bar and pick this MCP UI server.",
    );
  }
  lines.push(
    `SSH: run \`ssh -L ${opts.port}:127.0.0.1:${opts.port} <this-host>\` on your local machine, then open the URL above.`,
    "mosh can't forward ports - run that ssh command in a separate terminal.",
  );
  return lines.join("\n");
}
