import http from "node:http";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { transform } from "esbuild";
import { hostModuleScript } from "./host-module.ts";
import type { UiHostContext, UiResourcePermissions } from "../../types.ts";
import { z } from "zod";
import { expect, vi } from "vitest";
import { ConsentManager } from "../../consent-manager.ts";
import { McpServerManager } from "../../server-manager.ts";
import { startUiServer } from "../../ui-server.ts";
import type { UiServerHandle } from "../../ui-server-contracts.ts";

const completionSchema = z.object({ reason: z.string() });

class BrowserClock {
  private now = 0;
  private nextId = 0;
  private readonly tasks = new Map<
    number,
    { at: number; interval?: number; callback: () => void }
  >();

  setInterval = (callback: () => void, interval: number): number => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + interval, interval, callback });
    return id;
  };

  clearInterval = (id: number): void => {
    this.tasks.delete(id);
  };

  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };

  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) {
        break;
      }
      const [id, task] = next;
      this.now = task.at;
      if (task.interval !== undefined) {
        task.at += task.interval;
      } else {
        this.tasks.delete(id);
      }
      task.callback();
    }
    this.now = end;
  }
}

const cleanups: Array<() => Promise<void>> = [];

interface RequestAttempt {
  path: string;
  status?: number;
  error?: string;
  settled: Promise<void>;
}

interface HostRuntime {
  handle: UiServerHandle;
  window: DOMWindow;
  document: Document;
  iframe: HTMLIFrameElement;
  dispatchWindow: (data: unknown, source?: MessageEventSource) => void;
  appMessages: unknown[];
  completions: string[];
  clock: BrowserClock;
  element: (id: string) => HTMLElement;
  eventSource: {
    completed: PromiseWithResolvers<{ reason: string }>;
    request: http.ClientRequest;
    closed: boolean;
    terminalEvents: number;
    disconnect: () => Promise<void>;
  };
  teardowns: Array<{ id: number | string; answered: boolean }>;
  teardownStarted: Promise<void>;
  respondToTeardowns: (error?: { code: number; message: string }) => void;
  requests: (path: string) => RequestAttempt[];
  settleRequests: (path?: string) => Promise<void>;
  consoleErrors: unknown[][];
  releaseCompletion: () => void;
  closeAttempts: () => number;
}

export async function closeHosts(): Promise<void> {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
}

export async function openHost(
  options: {
    failCompletion?: boolean;
    holdCompletion?: "request" | "response";
    hostContext?: UiHostContext;
    toolArgs?: Record<string, unknown>;
    confirm?: boolean;
    permissions?: UiResourcePermissions;
  } = {},
): Promise<HostRuntime> {
  const completions: string[] = [];
  const handle = await startUiServer({
    port: 0,
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: options.toolArgs ?? {},
    ...(options.hostContext === undefined ? {} : { hostContext: options.hostContext }),
    resource: {
      uri: "ui://test/app",
      html: "<h1>Test app</h1>",
      mimeType: "text/html",
      meta: { permissions: options.permissions ?? {} },
    },
    manager: new McpServerManager(),
    consentManager: new ConsentManager(),
    onComplete: (reason) => {
      completions.push(reason);
      if (options.failCompletion === true && reason !== "test-cleanup") {
        throw new Error("Completion callback failed");
      }
    },
  });
  cleanups.push(async () => {
    handle.close("test-cleanup");
    const ref = handle.getSessionMessages().historyRef;
    if (ref !== undefined) {
      await rm(dirname(ref), { recursive: true, force: true });
    }
  });

  const origin = `http://127.0.0.1:${handle.port}`;
  const page = await fetch(`${origin}/?session=${encodeURIComponent(handle.sessionToken)}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const moduleScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (moduleScript === undefined || moduleScript === "") {
    throw new Error("Served host module not found");
  }
  const script = hostModuleScript(moduleScript);
  const clock = new BrowserClock();
  const consoleErrors: unknown[][] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", (...args: unknown[]) => consoleErrors.push(args));
  const dom = new JSDOM(html, {
    url: page.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  const { document } = window;
  const element = (id: string) => {
    const node = document.getElementById(id);
    assert(node instanceof window.HTMLElement, `Missing element ${id}`);
    return node;
  };
  const iframe = element("mcp-app");
  assert(iframe instanceof window.HTMLIFrameElement);
  const appWindow = iframe.contentWindow;
  assert(appWindow !== null);
  const closeDom = window.close.bind(window);
  cleanups.push(async () => closeDom());
  let closeAttempts = 0;
  window.close = () => {
    closeAttempts += 1;
  };
  const dispatchWindow = (data: unknown, source: MessageEventSource = appWindow) => {
    window.dispatchEvent(new window.MessageEvent("message", { source, data }));
  };

  const teardownStarted: PromiseWithResolvers<void> = Promise.withResolvers();
  const appMessages: unknown[] = [];
  const teardowns: Array<{ id: number | string; answered: boolean }> = [];
  appWindow.postMessage = (message: unknown) => {
    appMessages.push(message);
    const request = z
      .object({
        method: z.literal("ui/resource-teardown"),
        id: z.union([z.number(), z.string()]),
      })
      .safeParse(message);
    if (request.success) {
      teardowns.push({ id: request.data.id, answered: false });
      teardownStarted.resolve();
    }
  };
  const respondToTeardowns = (error?: { code: number; message: string }) => {
    for (const request of teardowns) {
      if (request.answered) {
        continue;
      }
      request.answered = true;
      dispatchWindow(
        error
          ? { jsonrpc: "2.0", id: request.id, error }
          : { jsonrpc: "2.0", id: request.id, result: {} },
      );
    }
  };

  // Navigation/layout are covered in Chrome. Here hold the WindowProxy stable
  // (jsdom replaces it on navigation) while fetching the real protected app.
  const iframeLoaded: PromiseWithResolvers<void> = Promise.withResolvers();
  Object.defineProperty(iframe, "src", {
    set: (path: string) => {
      iframe.setAttribute("data-loaded-url", new URL(path, origin).href);
      fetch(new URL(path, origin))
        .then(async (response) => {
          assert.equal(response.status, 200);
          await response.text();
          iframe.dispatchEvent(new window.Event("load"));
          iframeLoaded.resolve();
        })
        .catch(iframeLoaded.reject);
    },
    get: () => iframe.getAttribute("data-loaded-url") ?? "",
  });

  const eventSources: LiveEventSource[] = [];
  class LiveEventSource {
    readonly connected: PromiseWithResolvers<void> = Promise.withResolvers();
    readonly completed = Promise.withResolvers<z.infer<typeof completionSchema>>();
    readonly interrupted: PromiseWithResolvers<void> = Promise.withResolvers();
    readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
    readonly request: http.ClientRequest;
    closed = false;
    terminalEvents = 0;
    onerror?: () => void;

    constructor(path: string) {
      eventSources.push(this);
      this.request = http.get(new URL(path, origin), (response) => {
        if (response.statusCode !== 200) {
          this.connected.reject(new Error(`SSE failed: ${String(response.statusCode)}`));
          response.resume();
          return;
        }
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const name = frame.match(/^event:\s*(.*)$/m)?.[1];
            const data = frame.match(/^data:\s*(.*)$/m)?.[1];
            if (name !== undefined && name !== "" && data !== undefined) {
              this.dispatch(name, data);
            }
          }
        });
        response.on("end", () => this.reportInterruption());
        response.on("error", () => this.reportInterruption());
        this.connected.resolve();
      });
      this.request.on("error", (error) => {
        if (!this.closed) {
          this.connected.reject(error);
          this.reportInterruption();
        }
      });
    }

    addEventListener(name: string, listener: (event: { data: string }) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    private dispatch(name: string, data: string): void {
      for (const listener of this.listeners.get(name) ?? []) {
        listener({ data });
      }
      if (name === "session-complete") {
        this.terminalEvents += 1;
        this.completed.resolve(completionSchema.parse(JSON.parse(data)));
      }
    }

    private reportInterruption(): void {
      if (this.closed) {
        return;
      }
      for (const listener of this.listeners.get("error") ?? []) {
        listener({ data: "" });
      }
      this.onerror?.();
      this.interrupted.resolve();
    }

    disconnect(): Promise<void> {
      this.request.destroy();
      return this.interrupted.promise;
    }

    close(): void {
      this.closed = true;
      this.request.destroy();
    }
  }

  const completionGate: PromiseWithResolvers<void> = Promise.withResolvers();
  const attempts: Array<{
    path: string;
    status?: number;
    error?: string;
    settled: Promise<void>;
  }> = [];
  const browserFetch = (path: string, init: RequestInit) => {
    const isCompletion = path === "/proxy/ui/complete";
    const send = () => fetch(new URL(path, origin), init);
    const request =
      isCompletion && options.holdCompletion === "request"
        ? completionGate.promise.then(send)
        : send();
    const attempt: Omit<(typeof attempts)[number], "settled"> = { path };
    const settled = (async () => {
      try {
        const response = await request;
        attempt.status = response.status;
      } catch (error) {
        attempt.error = String(error);
      }
    })();
    attempts.push(Object.assign(attempt, { settled }));
    return isCompletion && options.holdCompletion === "response"
      ? request.then(async (response) => {
          await completionGate.promise;
          return response;
        })
      : request;
  };
  const requests = (path: string) => attempts.filter((attempt) => attempt.path === path);
  const settleRequests = async (path?: string) => {
    await Promise.all(
      (path !== undefined && path !== "" ? requests(path) : attempts).map(
        (attempt) => attempt.settled,
      ),
    );
  };

  const bundle = await fetch(`${origin}/app-bridge.bundle.js`);
  expect(bundle.status).toBe(200);
  const bridgeScript = await transform(await bundle.text(), {
    format: "iife",
    globalName: "bridgeModule",
  });
  const context = dom.getInternalVMContext();
  Object.assign(window, {
    EventSource: LiveEventSource,
    fetch: browserFetch,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    confirm: () => options.confirm ?? false,
    TextEncoder,
    TextDecoder,
  });
  cleanups.push(async () => {
    completionGate.resolve();
    for (const source of eventSources) {
      source.close();
    }
    respondToTeardowns();
  });
  const bridgeLoaded: unknown = runInContext(bridgeScript.code, context);
  await bridgeLoaded;
  const running: unknown = runInContext(script, context);
  await Promise.all([running, iframeLoaded.promise]);
  const eventSource = eventSources[0];
  assert(eventSource);
  await eventSource.connected.promise;

  return {
    handle,
    window,
    document,
    iframe,
    dispatchWindow,
    appMessages,
    completions,
    clock,
    element,
    eventSource,
    teardowns,
    teardownStarted: teardownStarted.promise,
    respondToTeardowns,
    requests,
    settleRequests,
    consoleErrors,
    releaseCompletion: completionGate.resolve,
    closeAttempts: (): number => closeAttempts,
  };
}
