import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { ConsentManager } from "../consent-manager.ts";
import type { McpServerManager } from "../server-manager.ts";
import { startUiServer } from "../ui-server.ts";

class BrowserClock {
  private now = 0;
  private nextId = 0;
  private tasks = new Map<number, { at: number; interval?: number; callback: () => void }>();

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
      if (!next || next[1].at > end) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.interval !== undefined) task.at += task.interval;
      else this.tasks.delete(id);
      task.callback();
    }
    this.now = end;
  }
}

class Element {
  textContent = "";
  style: Record<string, string> = {};
  private classes = new Set<string>();
  private listeners = new Map<string, Array<() => unknown>>();
  classList = {
    add: (name: string) => this.classes.add(name),
    contains: (name: string) => this.classes.has(name),
  };

  addEventListener(name: string, listener: () => unknown): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  click(): Promise<unknown[]> {
    return Promise.all((this.listeners.get("click") ?? []).map((listener) => listener()));
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openHost(options: {
  failCompletion?: boolean;
  holdCompletion?: "request" | "response";
} = {}) {
  const completions: string[] = [];
  const handle = await startUiServer({
    port: 0,
    serverName: "test-server",
    toolName: "test-tool",
    toolArgs: {},
    resource: {
      uri: "ui://test/app",
      html: "<h1>Test app</h1>",
      mimeType: "text/html",
      meta: { permissions: {} },
    },
    manager: {} as McpServerManager,
    consentManager: new ConsentManager(),
    onComplete: (reason) => {
      completions.push(reason);
      if (options.failCompletion && reason !== "test-cleanup") {
        throw new Error("Completion callback failed");
      }
    },
  });
  cleanups.push(async () => handle.close("test-cleanup"));

  const origin = `http://127.0.0.1:${handle.port}`;
  const page = await fetch(`${origin}/?session=${encodeURIComponent(handle.sessionToken)}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const moduleScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!moduleScript) throw new Error("Served host module not found");
  const script = moduleScript.replace(/^\s*import\s+[^;]+;/, "");
  if (script === moduleScript) throw new Error("Served host module import not found");

  const clock = new BrowserClock();
  const elements = new Map([
    "mcp-app",
    "status",
    "done-btn",
    "cancel-btn",
    "error-overlay",
    "completion-overlay",
    "error-message",
    "server-name",
    "tool-name",
  ].map((id) => [id, new Element()]));
  const element = (id: string) => {
    const result = elements.get(id);
    if (!result) throw new Error(`Missing element ${id}`);
    return result;
  };

  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  const consoleErrors: unknown[][] = [];
  const browserConsole = {
    ...console,
    error: (...args: unknown[]) => { consoleErrors.push(args); },
  };
  let closeAttempts = 0;
  const window = {
    innerWidth: 1024,
    close: () => { closeAttempts += 1; },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      const listeners = windowListeners.get(name) ?? new Set();
      listeners.add(listener);
      windowListeners.set(name, listeners);
    },
    removeEventListener: (name: string, listener: (event: unknown) => void) => {
      windowListeners.get(name)?.delete(listener);
    },
  };
  const dispatchWindow = (name: string, event: unknown) => {
    for (const listener of windowListeners.get(name) ?? []) listener(event);
  };
  vi.stubGlobal("window", window);

  const teardownStarted = Promise.withResolvers<void>();
  const teardowns: Array<{ id: number | string; answered: boolean }> = [];
  const appWindow = {
    postMessage: (message: { method?: string; id?: number | string }) => {
      if (message.method !== "ui/resource-teardown" || message.id === undefined) return;
      teardowns.push({ id: message.id, answered: false });
      teardownStarted.resolve();
    },
  };
  const respondToTeardowns = (error?: string) => {
    for (const request of teardowns) {
      if (request.answered) continue;
      request.answered = true;
      dispatchWindow("message", {
        source: appWindow,
        data: error
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error } }
          : { jsonrpc: "2.0", id: request.id, result: {} },
      });
    }
  };

  const iframeLoaded = Promise.withResolvers<void>();
  const iframe = element("mcp-app") as Element & {
    contentWindow: typeof appWindow;
    onload?: () => void;
    src: string;
  };
  iframe.contentWindow = appWindow;
  Object.defineProperty(iframe, "src", {
    set: (path: string) => {
      void fetch(new URL(path, origin))
        .then(async (response) => {
          if (!response.ok) throw new Error(`App load failed: ${response.status}`);
          await response.text();
          iframe.onload?.();
          iframeLoaded.resolve();
        })
        .catch(iframeLoaded.reject);
    },
  });
  const document = {
    hidden: false,
    getElementById: element,
    addEventListener: () => {},
  };

  let eventSource!: LiveEventSource;
  class LiveEventSource {
    readonly connected = Promise.withResolvers<void>();
    readonly completed = Promise.withResolvers<{ reason: string }>();
    readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
    readonly request: http.ClientRequest;
    closed = false;
    onerror?: () => void;

    constructor(path: string) {
      eventSource = this;
      this.request = http.get(new URL(path, origin), (response) => {
        if (response.statusCode !== 200) {
          this.connected.reject(new Error(`SSE failed: ${response.statusCode}`));
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
            if (name && data !== undefined) this.dispatch(name, data);
          }
        });
        response.on("end", () => {
          if (!this.closed) this.onerror?.();
        });
        this.connected.resolve();
      });
      this.request.on("error", (error) => {
        if (!this.closed) {
          this.connected.reject(error);
          this.onerror?.();
        }
      });
    }

    addEventListener(name: string, listener: (event: { data: string }) => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    dispatch(name: string, data: string): void {
      for (const listener of this.listeners.get(name) ?? []) listener({ data });
      if (name === "session-complete") this.completed.resolve(JSON.parse(data) as { reason: string });
    }

    close(): void {
      this.closed = true;
      this.request.destroy();
    }
  }

  const completionGate = Promise.withResolvers<void>();
  const attempts: Array<{ path: string; status?: number; error?: string; settled: Promise<void> }> = [];
  const browserFetch = (path: string, init: RequestInit) => {
    const isCompletion = path === "/proxy/ui/complete";
    const send = () => fetch(new URL(path, origin), init);
    const request = isCompletion && options.holdCompletion === "request"
      ? completionGate.promise.then(send)
      : send();
    const attempt: (typeof attempts)[number] = {
      path,
      settled: request.then(
        (response) => { attempt.status = response.status; },
        (error: unknown) => { attempt.error = String(error); },
      ),
    };
    attempts.push(attempt);
    return isCompletion && options.holdCompletion === "response"
      ? request.then(async (response) => {
        await completionGate.promise;
        return response;
      })
      : request;
  };
  const requests = (path: string) => attempts.filter((attempt) => attempt.path === path);
  const settleRequests = async (path?: string) => {
    await Promise.all((path ? requests(path) : attempts).map((attempt) => attempt.settled));
  };

  const bundle = await fetch(`${origin}/app-bridge.bundle.js`);
  expect(bundle.status).toBe(200);
  const bundleUrl = `data:text/javascript;base64,${Buffer.from(await bundle.text()).toString("base64")}`;
  const { AppBridge, PostMessageTransport }: typeof import("@modelcontextprotocol/ext-apps/app-bridge") =
    await import(/* @vite-ignore */ bundleUrl);
  let bridge: InstanceType<typeof AppBridge> | undefined;
  class CapturedBridge extends AppBridge {
    constructor(...args: ConstructorParameters<typeof AppBridge>) {
      super(...args);
      bridge = this;
    }
  }
  cleanups.push(async () => {
    completionGate.resolve();
    eventSource?.close();
    respondToTeardowns();
    await bridge?.close();
  });

  const run = new Function(
    "AppBridge", "PostMessageTransport", "document", "window", "EventSource",
    "fetch", "setInterval", "clearInterval", "setTimeout", "console",
    `return (async () => { ${script} })();`,
  );
  await Promise.all([
    run(CapturedBridge, PostMessageTransport, document, window, LiveEventSource,
      browserFetch, clock.setInterval, clock.clearInterval, clock.setTimeout, browserConsole),
    iframeLoaded.promise,
  ]);
  await eventSource.connected.promise;

  return {
    handle, completions, clock, element, eventSource, teardowns, teardownStarted: teardownStarted.promise,
    respondToTeardowns, requests, settleRequests, consoleErrors, releaseCompletion: completionGate.resolve,
    closeAttempts: () => closeAttempts,
  };
}

async function expectCompletionFallback(host: Awaited<ReturnType<typeof openHost>>) {
  await vi.waitFor(() => expect(host.closeAttempts()).toBe(1));
  host.clock.advance(1_000);
  expect(host.element("completion-overlay").classList.contains("visible")).toBe(true);
  expect(host.element("status").textContent).toBe("Complete");
}

it("stops heartbeats immediately when the server replaces the session", async () => {
  const host = await openHost();
  host.clock.advance(10_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200]);

  host.handle.close("replaced");
  expect(await host.eventSource.completed.promise).toEqual({ reason: "replaced" });
  await host.teardownStarted;
  expect(host.completions).toEqual(["replaced"]);

  host.clock.advance(30_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(1);
  expect(host.eventSource.closed).toBe(true);

  host.eventSource.dispatch("session-complete", JSON.stringify({ reason: "replaced" }));
  host.element("done-btn").click();
  host.element("cancel-btn").click();
  expect(host.teardowns).toHaveLength(1);
  expect(host.requests("/proxy/ui/complete")).toHaveLength(0);

  host.respondToTeardowns();
  await expectCompletionFallback(host);
});

it.each(["done", "cancel"] as const)(
  "finishes %s from the server event without waiting for the POST response",
  async (reason) => {
    const host = await openHost({ holdCompletion: "response" });
    host.clock.advance(10_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200]);

    const completion = host.element(`${reason}-btn`).click();
    expect(await host.eventSource.completed.promise).toEqual({ reason });
    await host.teardownStarted;
    await host.settleRequests();
    expect(host.completions).toEqual([reason]);
    expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([200]);
    expect(host.teardowns).toHaveLength(1);
    expect(host.eventSource.closed).toBe(true);

    host.clock.advance(30_000);
    await host.settleRequests();
    expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(1);
    host.respondToTeardowns();
    await expectCompletionFallback(host);

    host.releaseCompletion();
    await completion;
    expect(host.teardowns).toHaveLength(1);
    expect(host.closeAttempts()).toBe(1);
  },
);

it("keeps heartbeats while a local completion request is unconfirmed", async () => {
  const host = await openHost({ holdCompletion: "request" });
  const completion = host.element("done-btn").click();
  const duplicate = host.element("done-btn").click();
  const cancel = host.element("cancel-btn").click();
  expect(host.eventSource.closed).toBe(false);

  host.clock.advance(30_000);
  await host.settleRequests("/proxy/ui/heartbeat");
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual([200, 200, 200]);
  expect(host.completions).toEqual([]);
  expect(host.teardowns).toHaveLength(0);

  host.releaseCompletion();
  await host.teardownStarted;
  await host.settleRequests();
  expect(host.completions).toEqual(["done"]);
  expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([200]);
  expect(host.teardowns).toHaveLength(1);

  host.respondToTeardowns();
  await Promise.all([completion, duplicate, cancel]);
  await expectCompletionFallback(host);
});

it("reports a failed completion response without replaying an accepted operation", async () => {
  const host = await openHost({ failCompletion: true, holdCompletion: "response" });
  const completion = host.element("done-btn").click();
  expect(await host.eventSource.completed.promise).toEqual({ reason: "done" });
  await host.teardownStarted;
  await host.settleRequests();
  expect(host.completions).toEqual(["done"]);
  expect(host.requests("/proxy/ui/complete").map((request) => request.status)).toEqual([500]);

  host.respondToTeardowns();
  await expectCompletionFallback(host);
  host.releaseCompletion();
  await completion;
  await host.element("done-btn").click();
  expect(host.teardowns).toHaveLength(1);
  expect(host.requests("/proxy/ui/complete")).toHaveLength(1);
  expect(
    host.consoleErrors.some((args) => args.some((arg) => String(arg).includes("Completion callback failed"))),
  ).toBe(true);
  expect(host.element("error-overlay").classList.contains("visible")).toBe(false);
  expect(host.element("completion-overlay").classList.contains("visible")).toBe(true);
  expect(host.closeAttempts()).toBe(1);
});

it("keeps active heartbeats and the watchdog across a transient SSE error", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const host = await openHost();
  host.eventSource.onerror?.();
  expect(host.element("status").textContent).toBe("Connection lost");

  for (let i = 0; i < 7; i += 1) {
    host.clock.advance(10_000);
    await host.settleRequests();
    vi.advanceTimersByTime(10_000);
  }
  expect(host.requests("/proxy/ui/heartbeat").map((request) => request.status)).toEqual(Array(7).fill(200));
  expect(host.completions).toEqual([]);

  vi.advanceTimersByTime(65_000);
  expect(host.completions).toEqual(["stale"]);
});

it("finishes after the app rejects teardown", async () => {
  const host = await openHost();
  host.handle.close("replaced");
  await host.eventSource.completed.promise;
  await host.teardownStarted;
  host.respondToTeardowns("Teardown rejected");
  await expectCompletionFallback(host);
  expect(
    host.consoleErrors.some((args) => args.some((arg) => String(arg).includes("Teardown rejected"))),
  ).toBe(true);
  host.clock.advance(20_000);
  await host.settleRequests();
  expect(host.requests("/proxy/ui/heartbeat")).toHaveLength(0);
});
