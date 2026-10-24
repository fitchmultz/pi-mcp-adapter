import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/client";
import type { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { clientOperations, type ClientOperation } from "./client-operations.ts";
import { throwIfAborted } from "./abort.ts";

// Track complete SDK operations, including pagination and pre-request cache awaits.
export class ManagedClient extends Client {
  serverName = "";
  oauthProvider: McpOAuthProvider | undefined;

  private own<T>(operation: Promise<T>, kind: ClientOperation): Promise<T> {
    let pending = clientOperations.get(this);
    if (!pending) clientOperations.set(this, pending = new Map());
    pending.set(operation, kind);
    const settled = () => { pending.delete(operation); };
    void operation.then(settled, settled);
    return operation;
  }

  ownNative<T>(run: () => Promise<T>): Promise<T> {
    return this.own(run(), "request/refresh");
  }

  ownSend(run: () => Promise<void>): Promise<void> {
    // SDK-generated callback replies also perform HTTP/auth work, without calling callTool().
    return this.own(Promise.resolve().then(run), "request/refresh");
  }

  ownCallback<T>(kind: "sampling callback" | "elicitation callback", run: () => Promise<T>): Promise<T> {
    // Insert before dispatch. Cancellation/close of the SDK response does not settle this promise.
    return this.own(Promise.resolve().then(run), kind);
  }

  private async track<T>(start: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = this.oauthProvider ? new AbortController() : undefined;
    let removeAbortListener = () => {};
    const operation = this.oauthProvider
      ? this.oauthProvider.runWithSignal(controller!.signal, () => {
          // Native legacy cancellation notifications must retain their operation's auth context.
          const abort = AsyncLocalStorage.bind(() => controller!.abort(signal?.reason));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => signal?.removeEventListener("abort", abort);
          return start(controller!.signal);
        })
      : start(signal);
    void operation.then(removeAbortListener, () => { controller?.abort(); removeAbortListener(); });
    return this.own(operation, "request/refresh");
  }

  override callTool(...args: Parameters<Client["callTool"]>) {
    return this.track(signal => super.callTool(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override readResource(...args: Parameters<Client["readResource"]>) {
    return this.track(signal => super.readResource(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override getPrompt(...args: Parameters<Client["getPrompt"]>) {
    return this.track(signal => super.getPrompt(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listTools(...args: Parameters<Client["listTools"]>) {
    return this.track(signal => super.listTools(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listResources(...args: Parameters<Client["listResources"]>) {
    return this.track(signal => super.listResources(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listPrompts(...args: Parameters<Client["listPrompts"]>) {
    return this.track(signal => super.listPrompts(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override complete(...args: Parameters<Client["complete"]>) {
    return this.track(signal => super.complete(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override setLoggingLevel(...args: Parameters<Client["setLoggingLevel"]>) {
    return this.track(signal => super.setLoggingLevel(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }

  override listen(...args: Parameters<Client["listen"]>) {
    return this.track(async signal => {
      const subscription = await super.listen(args[0], { ...args[1], ...(signal ? { signal } : {}) });
      this.own(subscription.closed, "subscription");
      return subscription;
    }, args[1]?.signal);
  }

  override subscribeResource(...args: Parameters<Client["subscribeResource"]>) {
    return this.track(async signal => {
      throwIfAborted(signal);
      return super.subscribeResource(args[0], { ...args[1], ...(signal ? { signal } : {}) });
    }, args[1]?.signal);
  }

  override unsubscribeResource(...args: Parameters<Client["unsubscribeResource"]>) {
    return this.track(signal => super.unsubscribeResource(args[0], { ...args[1], ...(signal ? { signal } : {}) }), args[1]?.signal);
  }
}

// Loaded only by the manager's connection path. Keep native constructors and
// synchronous connection setup together, after the one asynchronous import.
export { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
export { SdkHttpError, StreamableHTTPClientTransport, SSEClientTransport, auth, extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/client";
export { UnixSocketClientTransport } from "./unix-socket-transport.ts";
export { trackToolTransport, trackToolTransportFailure } from "./session-recovery.ts";
export { McpOAuthProvider } from "./mcp-oauth-provider.ts";
export { extractOAuthConfig, isOAuthChallenge, recordOAuthChallenge, getOAuthRequest, bindOAuthRequestIssuer } from "./mcp-auth-flow.ts";
export { registerSamplingHandler } from "./sampling-handler.ts";
export { registerElicitationHandler } from "./elicitation-handler.ts";
export { serverStreamResultPatchNotificationSchema } from "./ui-stream-types.ts";
