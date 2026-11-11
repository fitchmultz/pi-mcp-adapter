import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildHostHtmlTemplate, buildCspMetaContent } from "./host-html-template.ts";
import { logger } from "./logger.ts";
import { formatAuthRequiredMessage } from "./utils.ts";
import { SessionRecoveryAuthRequiredError } from "./session-recovery.ts";
import type { UiHostContext } from "./types.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import type { UiServerOptions } from "./ui-server-options.ts";
import { UiEventStream } from "./ui-event-stream.ts";
import { UiServerSessionHandle } from "./ui-server-handle.ts";
import { UiProxyRoutes } from "./ui-proxy-routes.ts";
import { UiToolProxy } from "./ui-tool-proxy.ts";
import { parseBody, requestUrl, sendJson, sendText, validateTokenQuery } from "./ui-http.ts";
import { isUiJsonObject } from "./ui-json.ts";

export type { UiServerHandle } from "./ui-server-contracts.ts";
export type { UiServerOptions } from "./ui-server-options.ts";

const ABANDONED_GRACE_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MOSHI_DISCOVERY_PORT_START = 8377;
const MOSHI_DISCOVERY_PORT_END = 8396;
let nextMoshiDiscoveryPort = MOSHI_DISCOVERY_PORT_START;

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const session = new UiHttpServer(options);
  return session.start();
}

/** Owns one local HTTP listener and its completion/watchdog lifecycle. */
class UiHttpServer {
  private readonly options: UiServerOptions;
  private readonly sessionToken: string;
  private readonly resourceToken = randomUUID();
  private readonly hostContext: UiHostContext;
  private readonly events: UiEventStream;
  private readonly proxy: UiProxyRoutes;
  private readonly tools: UiToolProxy;
  private readonly server: http.Server;
  private readonly log: ReturnType<typeof logger.child>;
  /** The listener is open until its first completion, whenever that arrives. */
  private phase: "open" | "closed" = "open";
  private lastHeartbeatAt = Date.now();
  private watchdog: NodeJS.Timeout | null = null;

  constructor(options: UiServerOptions) {
    this.options = options;
    this.sessionToken = options.sessionToken ?? randomUUID();
    this.log = logger.child({
      component: "UiServer",
      server: options.serverName,
      tool: options.toolName,
      session: this.sessionToken.slice(0, 8),
    });
    this.hostContext = {
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen", "pip"],
      platform: "desktop",
      ...options.hostContext,
    };
    this.events = new UiEventStream(this.hostContext);
    this.proxy = new UiProxyRoutes(
      options,
      this.hostContext,
      (name, payload) => this.pushEvent(name, payload),
      this.log,
    );
    this.tools = new UiToolProxy(options);
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => this.handleError(error, res));
    });
  }

  start(): Promise<UiServerHandle> {
    this.log.debug("Starting UI server");
    if (this.options.initialResultPromise) {
      this.options.initialResultPromise
        .then((result) => {
          this.pushEvent("tool-result", result);
        })
        .catch((error: unknown) => {
          this.pushEvent("tool-cancelled", {
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    }
    this.watchdog = setInterval(() => {
      if (this.phase === "open" && Date.now() - this.lastHeartbeatAt > ABANDONED_GRACE_MS) {
        this.close("stale");
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref();
    return this.listen();
  }

  private listen(): Promise<UiServerHandle> {
    return new Promise((resolve, reject) => {
      const candidates = resolvePortCandidates(this.options.port);
      let index = 0;
      const listen = (): void => {
        this.server.once("error", onError);
        this.server.listen(candidates[index], "127.0.0.1", onListening);
      };
      const onError = (error: NodeJS.ErrnoException): void => {
        this.server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && index < candidates.length - 1) {
          index += 1;
          listen();
          return;
        }
        this.stopWatchdog();
        this.log.error("Failed to start server", error);
        reject(new Error(`UI server error: ${error.message}`, { cause: error }));
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          this.stopWatchdog();
          const error = new Error("UI server error: invalid address");
          this.log.error("Invalid server address", error);
          reject(error);
          return;
        }
        this.log.debug("Server started", { port: address.port });
        rememberMoshiDiscoveryPort(address.port);
        resolve(this.handle(address.port));
      };
      listen();
    });
  }

  private handle(port: number): UiServerHandle {
    return new UiServerSessionHandle(
      {
        url: `http://localhost:${port}/?session=${this.sessionToken}`,
        port,
        sessionToken: this.sessionToken,
        serverName: this.options.serverName,
        toolName: this.options.toolName,
      },
      {
        hostContext: this.hostContext,
        push: (name, payload) => this.pushEvent(name, payload),
        close: (reason) => this.close(reason ?? "closed"),
        getMessages: () => this.proxy.getMessages(),
        getSummary: () => this.events.getSummary(),
      },
    );
  }

  private pushEvent(name: string, payload: unknown): void {
    if (this.phase === "open") {
      this.events.push(name, payload);
    }
  }

  /** The one completion transition; later closes are no-ops with respect to the session. */
  private markCompleted(reason: string): void {
    if (this.phase === "closed") {
      return;
    }
    this.log.debug("Session completed", { reason });
    this.pushEvent("session-complete", { reason });
    this.phase = "closed";
    this.stopWatchdog();
    this.options.onComplete?.(reason);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private close(reason: string): void {
    this.markCompleted(reason);
    this.closeTransport();
  }

  private closeTransport(): void {
    try {
      this.server.close();
    } catch {
      // Completion remains idempotent if the native server is already closed.
    }
    this.events.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method === undefined || req.method === "" ? "GET" : req.method;
    const host = req.headers.host;
    const url = requestUrl(req);
    if (host !== undefined && !isAllowedHost(url.hostname)) {
      sendText(res, 403, "Invalid host");
      return;
    }
    if (method === "HEAD" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end();
      return;
    }
    if (method === "GET") {
      await this.serveGet(req, res, url);
      return;
    }
    if (method === "POST") {
      await this.servePost(req, res, url);
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
  }

  private async serveGet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    switch (url.pathname) {
      case "/":
        this.serveHost(url, res);
        return;
      case "/events":
        this.serveEvents(req, res, url);
        return;
      case "/health":
        if (validateTokenQuery(url, this.sessionToken, res)) {
          sendJson(res, 200, { ok: true, result: { healthy: true } });
        }
        return;
      case "/ui-app":
        this.serveApp(url, res);
        return;
      case "/app-bridge.bundle.js":
        await serveBundle(res);
        return;
      default:
        sendJson(res, 404, { ok: false, error: "Not found" });
    }
  }

  private serveHost(url: URL, res: ServerResponse): void {
    if (!url.searchParams.has("session")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>MCP UI</title></head>' +
          "<body><p>Open the authenticated MCP UI URL shown by Pi.</p></body></html>",
      );
      return;
    }
    if (!validateTokenQuery(url, this.sessionToken, res)) {
      return;
    }
    this.touchHeartbeat();
    const options = this.options;
    const html = buildHostHtmlTemplate({
      sessionToken: this.sessionToken,
      uiResourceToken: this.resourceToken,
      serverName: options.serverName,
      toolName: options.toolName,
      toolArgs: options.toolArgs,
      resource: options.resource,
      allowAttribute: buildAllowAttribute(options.resource.meta.permissions),
      requireToolConsent: options.consentManager.requiresPrompt(options.serverName),
      hostContext: this.hostContext,
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }

  private serveApp(url: URL, res: ServerResponse): void {
    if (!validateTokenQuery(url, this.resourceToken, res, "resource")) {
      return;
    }
    this.touchHeartbeat();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": buildCspMetaContent(this.options.resource.meta.csp),
    });
    res.end(this.options.resource.html);
  }

  private serveEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!validateTokenQuery(url, this.sessionToken, res)) {
      return;
    }
    this.touchHeartbeat();
    const lastId = req.headers["last-event-id"];
    this.events.connect(res, lastId === undefined ? undefined : String(lastId));
    req.on("close", () => this.events.disconnect(res));
  }

  private async servePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await parseBody(req, res);
    if (!body) {
      return;
    }
    if (body.token !== this.sessionToken) {
      sendJson(res, 403, { ok: false, error: "Invalid session" });
      return;
    }
    // A partial upload is not accepted until its authenticated body is complete.
    if (
      this.phase === "closed" &&
      (url.pathname === "/proxy/ui/message" || url.pathname === "/proxy/ui/context")
    ) {
      sendJson(res, 409, { ok: false, error: "UI session is complete; message was not accepted" });
      return;
    }
    this.touchHeartbeat();
    await this.dispatchPost(url.pathname, body.params, res);
  }

  private async dispatchPost(
    pathname: string,
    params: unknown,
    res: ServerResponse,
  ): Promise<void> {
    if (pathname === "/proxy/tools/call") {
      await this.tools.call(params, res);
      return;
    }
    if (pathname === "/proxy/ui/complete") {
      const reason =
        isUiJsonObject(params) && typeof params.reason === "string" ? params.reason : "done";
      this.markCompleted(reason);
      sendJson(res, 200, { ok: true, result: {} });
      setTimeout(() => this.closeTransport(), 20).unref();
      return;
    }
    if (!(await this.proxy.handle(pathname, params, res))) {
      sendJson(res, 404, { ok: false, error: "Not found" });
    }
  }

  private touchHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
  }

  private handleError(error: unknown, res: ServerResponse): void {
    const options = this.options;
    if (error instanceof SessionRecoveryAuthRequiredError) {
      const fallback = `Server "${options.serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${options.serverName}" }) to get a browser URL, or /mcp-auth ${options.serverName} in an interactive local session.`;
      const message =
        error.authMessage ??
        (options.config
          ? formatAuthRequiredMessage(options.config, options.serverName, fallback)
          : fallback);
      sendJson(res, 401, { ok: false, error: message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = /approval required|denied/i.test(message) ? 403 : 500;
    if (status === 500) {
      this.log.error("Request handler error", error instanceof Error ? error : undefined);
    }
    sendJson(res, status, { ok: false, error: message });
  }
}

async function serveBundle(res: ServerResponse): Promise<void> {
  try {
    const content = await fs.readFile(
      path.join(import.meta.dirname, "app-bridge.bundle.js"),
      "utf-8",
    );
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=31536000",
    });
    res.end(content);
  } catch {
    sendJson(res, 500, { ok: false, error: "Bundle not found" });
  }
}

function resolvePortCandidates(port: number | undefined): number[] {
  if (port !== undefined) {
    return [port];
  }
  const candidates: number[] = [];
  const count = MOSHI_DISCOVERY_PORT_END - MOSHI_DISCOVERY_PORT_START + 1;
  for (let offset = 0; offset < count; offset += 1) {
    candidates.push(
      MOSHI_DISCOVERY_PORT_START +
        ((nextMoshiDiscoveryPort - MOSHI_DISCOVERY_PORT_START + offset) % count),
    );
  }
  candidates.push(0);
  return candidates;
}

function rememberMoshiDiscoveryPort(port: number): void {
  if (port >= MOSHI_DISCOVERY_PORT_START && port <= MOSHI_DISCOVERY_PORT_END) {
    nextMoshiDiscoveryPort =
      port >= MOSHI_DISCOVERY_PORT_END ? MOSHI_DISCOVERY_PORT_START : port + 1;
  }
}

function isAllowedHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
