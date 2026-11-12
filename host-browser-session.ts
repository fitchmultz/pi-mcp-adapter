import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import { UI_STREAM_RESULT_PATCH_METHOD } from "./ui-stream-types.ts";
import {
  isHostContext,
  isToolInput,
  readToolResult,
  isToolCancelled,
} from "./host-browser-contracts.ts";
import type { HostBrowserProxy } from "./host-browser-proxy.ts";
import type { HostBrowserView } from "./host-browser-view.ts";
import { UI_HEARTBEAT_INTERVAL_MS } from "./ui-session-timing.ts";

const patchParamsSchema = z.record(z.string(), z.unknown());

// Forward the validated original patch, keeping the native parse error.
function assertPatchParams(value: unknown): asserts value is z.input<typeof patchParamsSchema> {
  patchParamsSchema.parse(value);
}

const eventSubjects = {
  "tool-input": "tool input",
  "tool-result": "tool result",
  "tool-cancelled": "cancellation",
  "result-patch": "stream patch",
  "host-context": null,
};

export class HostBrowserSession {
  private readonly bridge: AppBridge;
  private readonly proxy: HostBrowserProxy;
  private readonly view: HostBrowserView;
  private readonly eventSource: EventSource;
  private readonly heartbeat: number;
  /** A completion is requested once and finished once; the reason is the request's. */
  private phase: "live" | "completing" | "finished" = "live";

  constructor(
    bridge: AppBridge,
    proxy: HostBrowserProxy,
    view: HostBrowserView,
    sessionToken: string,
  ) {
    this.bridge = bridge;
    this.proxy = proxy;
    this.view = view;
    this.eventSource = new EventSource("/events?session=" + encodeURIComponent(sessionToken));
    this.heartbeat = window.setInterval(() => {
      this.proxy
        .advisory("/proxy/ui/heartbeat", {})
        .catch((error: unknown) => this.reportLifecycleError(error));
    }, UI_HEARTBEAT_INTERVAL_MS);
  }

  listen(): void {
    this.bindEvents();
    this.view.doneButton.addEventListener("click", () => this.requestCompletion("done"));
    this.view.cancelButton.addEventListener("click", () => this.requestCompletion("cancel"));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.requestCompletion("cancel");
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        this.requestCompletion("done");
      }
    });
  }

  private bindEvents(): void {
    for (const [name, subject] of Object.entries(eventSubjects)) {
      this.eventSource.addEventListener(name, (event: MessageEvent<string>) => {
        this.forwardEvent(name, event.data).catch((error: unknown) => {
          if (subject !== null) {
            this.view.showError(`Failed to forward ${subject}: ${String(error)}`);
          }
          // Malformed context updates are non-terminal, as in the original host.
        });
      });
    }
    this.eventSource.addEventListener("error", () => this.view.setStatus("Connection lost", true));
    this.eventSource.addEventListener("session-complete", () => {
      this.finish().catch((error: unknown) => this.reportLifecycleError(error));
    });
  }

  private async forwardEvent(name: string, text: string): Promise<void> {
    const value: unknown = JSON.parse(text);
    switch (name) {
      case "tool-input":
        if (!isToolInput(value)) {
          throw new Error("Invalid tool input");
        }
        await this.bridge.sendToolInput(value);
        return;
      case "tool-result":
        await this.bridge.sendToolResult(readToolResult(value));
        return;
      case "tool-cancelled":
        if (!isToolCancelled(value)) {
          throw new Error("Invalid tool cancellation");
        }
        await this.bridge.sendToolCancelled(value);
        return;
      case "result-patch":
        assertPatchParams(value);
        await this.bridge.notification({
          method: UI_STREAM_RESULT_PATCH_METHOD,
          params: value,
        });
        return;
      case "host-context":
        if (isHostContext(value)) {
          this.bridge.setHostContext(value);
        }
        return;
      default:
        throw new Error(`Unknown host event: ${name}`);
    }
  }

  private requestCompletion(reason: "done" | "cancel"): void {
    this.complete(reason).catch((error: unknown) => this.reportLifecycleError(error));
  }

  private reportLifecycleError(error: unknown): void {
    console.error("[host] Session completion failed:", error);
  }

  private async complete(reason: "done" | "cancel"): Promise<void> {
    if (this.phase !== "live") {
      return;
    }
    this.phase = "completing";
    try {
      await this.proxy.post("/proxy/ui/complete", { reason });
    } catch (error) {
      this.reportLifecycleError(error);
    }
    await this.finish();
  }

  private async finish(): Promise<void> {
    if (this.phase === "finished") {
      return;
    }
    this.phase = "finished";
    window.clearInterval(this.heartbeat);
    this.eventSource.close();
    try {
      await this.bridge.teardownResource({});
    } catch (error) {
      // Apps may omit the optional teardown handler.
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === -32601)
      ) {
        console.error("[host] Resource teardown failed:", error);
      }
    }
    this.view.closeOrShowDone();
  }
}
