import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/client";
import type { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { clientOperations, type ClientOperation } from "./client-operations.ts";
import { throwIfAborted } from "./abort.ts";

// Track complete SDK operations, including pagination and pre-request cache awaits.
export class ManagedClient extends Client {
  serverName = "";
  oauthProvider: McpOAuthProvider | undefined;

  private record(operation: Promise<unknown>, kind: ClientOperation): void {
    let pending = clientOperations.get(this);
    if (!pending) {
      pending = new Map<Promise<unknown>, ClientOperation>();
      clientOperations.set(this, pending);
    }
    pending.set(operation, kind);
    const settled = () => {
      pending.delete(operation);
    };
    void operation.then(settled, settled);
  }

  ownNative<T>(run: () => Promise<T>): Promise<T> {
    const operation = run();
    this.record(operation, "request/refresh");
    return operation;
  }

  ownSend(run: () => Promise<void>): Promise<void> {
    // SDK-generated callback replies also perform HTTP/auth work, without calling callTool().
    const operation = Promise.resolve().then(run);
    this.record(operation, "request/refresh");
    return operation;
  }

  ownCallback<T>(
    kind: "sampling callback" | "elicitation callback",
    run: () => Promise<T>,
  ): Promise<T> {
    // Insert before dispatch. Cancellation/close of the SDK response does not settle this promise.
    const operation = Promise.resolve().then(run);
    this.record(operation, kind);
    return operation;
  }

  private async track<T>(
    start: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const provider = this.oauthProvider;
    if (!provider) {
      return this.ownNative(() => start(signal));
    }
    const controller = new AbortController();
    let removeAbortListener: (() => void) | undefined;
    const operation = provider.runWithSignal(controller.signal, () => {
      // Native legacy cancellation notifications retain their operation's auth context.
      const abort = AsyncLocalStorage.bind(() => controller.abort(signal?.reason));
      if (signal?.aborted === true) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
      removeAbortListener = () => signal?.removeEventListener("abort", abort);
      return start(controller.signal);
    });
    void operation.then(
      () => removeAbortListener?.(),
      () => {
        controller.abort();
        removeAbortListener?.();
      },
    );
    this.record(operation, "request/refresh");
    return operation;
  }

  override callTool(...args: Parameters<Client["callTool"]>): ReturnType<Client["callTool"]> {
    return this.track(
      (signal) => super.callTool(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override readResource(
    ...args: Parameters<Client["readResource"]>
  ): ReturnType<Client["readResource"]> {
    return this.track(
      (signal) => super.readResource(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override getPrompt(...args: Parameters<Client["getPrompt"]>): ReturnType<Client["getPrompt"]> {
    return this.track(
      (signal) => super.getPrompt(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override listTools(...args: Parameters<Client["listTools"]>): ReturnType<Client["listTools"]> {
    return this.track(
      (signal) => super.listTools(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override listResources(
    ...args: Parameters<Client["listResources"]>
  ): ReturnType<Client["listResources"]> {
    return this.track(
      (signal) => super.listResources(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override listPrompts(
    ...args: Parameters<Client["listPrompts"]>
  ): ReturnType<Client["listPrompts"]> {
    return this.track(
      (signal) => super.listPrompts(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override complete(...args: Parameters<Client["complete"]>): ReturnType<Client["complete"]> {
    return this.track(
      (signal) => super.complete(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override setLoggingLevel(
    ...args: Parameters<Client["setLoggingLevel"]>
  ): ReturnType<Client["setLoggingLevel"]> {
    return this.track(
      // oxlint-disable-next-line typescript/no-deprecated -- QX-024: own the supported native logging operation through settlement.
      (signal) => super.setLoggingLevel(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }

  override listen(...args: Parameters<Client["listen"]>): ReturnType<Client["listen"]> {
    return this.track(async (signal) => {
      const subscription = await super.listen(args[0], {
        ...args[1],
        ...(signal ? { signal } : {}),
      });
      this.record(subscription.closed, "subscription");
      return subscription;
    }, args[1]?.signal);
  }

  override subscribeResource(
    ...args: Parameters<Client["subscribeResource"]>
  ): ReturnType<Client["subscribeResource"]> {
    return this.track(async (signal) => {
      throwIfAborted(signal);
      return super.subscribeResource(args[0], { ...args[1], ...(signal ? { signal } : {}) });
    }, args[1]?.signal);
  }

  override unsubscribeResource(
    ...args: Parameters<Client["unsubscribeResource"]>
  ): ReturnType<Client["unsubscribeResource"]> {
    return this.track(
      (signal) => super.unsubscribeResource(args[0], { ...args[1], ...(signal ? { signal } : {}) }),
      args[1]?.signal,
    );
  }
}

// Loaded only by the manager's connection path. Keep native constructors and
// synchronous connection setup together, after the one asynchronous import.
export { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
export { ConnectionCatalogs } from "./connection-catalogs.ts";
export {
  SdkHttpError,
  StreamableHTTPClientTransport,
  // oxlint-disable-next-line typescript/no-deprecated -- QX-024: load the supported native SSE constructor with the lazy runtime.
  SSEClientTransport,
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
export { UnixSocketClientTransport } from "./unix-socket-transport.ts";
export { trackToolTransport, trackToolTransportFailure } from "./tool-transport.ts";
export { McpOAuthProvider } from "./mcp-oauth-provider.ts";
export {
  extractOAuthConfig,
  isOAuthChallenge,
  recordOAuthChallenge,
  getOAuthRequest,
  bindOAuthRequestIssuer,
} from "./mcp-auth-flow.ts";
export { registerSamplingHandler } from "./sampling-handler.ts";
export { registerElicitationHandler } from "./elicitation-handler.ts";
export { serverStreamResultPatchNotificationSchema } from "./ui-stream-types.ts";
