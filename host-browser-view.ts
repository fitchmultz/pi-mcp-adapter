import type { HostConfiguration } from "./host-browser-contracts.ts";

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`Missing host element: ${id}`);
  }
  return node;
}

function appFrame(): HTMLIFrameElement {
  const node = element("mcp-app");
  if (!(node instanceof HTMLIFrameElement)) {
    throw new Error("Missing app iframe");
  }
  return node;
}

export class HostBrowserView {
  readonly iframe = appFrame();
  readonly doneButton = element("done-btn");
  readonly cancelButton = element("cancel-btn");
  private readonly status = element("status");
  private readonly errorOverlay = element("error-overlay");
  private readonly errorMessage = element("error-message");
  private readonly completionOverlay = element("completion-overlay");
  private completionPending = false;

  constructor(config: HostConfiguration) {
    element("server-name").textContent = config.serverName;
    element("tool-name").textContent = config.toolName;
    if (config.allowAttribute.length > 0) {
      this.iframe.setAttribute("allow", config.allowAttribute);
    }
    document.addEventListener("visibilitychange", () => {
      if (this.completionPending && !document.hidden) {
        this.showCompletion();
      }
    });
  }

  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.style.color = isError ? "var(--bad)" : "var(--muted)";
  }

  showError(message: string): void {
    this.errorMessage.textContent = message;
    this.errorOverlay.classList.add("visible");
    this.setStatus("Error", true);
  }

  showCompletion(): void {
    this.completionOverlay.classList.add("visible");
    this.setStatus("Complete");
  }

  closeOrShowDone(): void {
    this.completionPending = true;
    window.close();
    window.setTimeout(() => {
      if (!document.hidden) {
        this.showCompletion();
      }
    }, 1000);
  }

  resize({ width, height }: { width?: number; height?: number }): void {
    if (typeof width === "number" && width > 0) {
      this.iframe.style.minWidth = `${Math.min(width, window.innerWidth - 24)}px`;
    }
    if (typeof height === "number" && height > 0) {
      this.iframe.style.height = `${Math.max(height, 320)}px`;
    }
  }

  async load(resourceToken: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      this.iframe.addEventListener("load", () => resolve(), { once: true });
    });
    this.iframe.src = "/ui-app?resource=" + encodeURIComponent(resourceToken);
    await loaded;
  }
}
