import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatTerminalError } from "./utils.ts";

export interface McpRuntimeOwner {
  readonly signal: AbortSignal;
  isActive: () => boolean;
  addCleanup: (cleanup: () => void | Promise<void>) => void;
  stop: (reason?: string) => Promise<void>;
  throwIfInactive: () => void;
  runCallback: <T>(kind: "beforeExecute" | "onToolCall", run: () => Promise<T>) => Promise<T>;
}

export function createMcpRuntimeOwner(): McpRuntimeOwner {
  const controller = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let stopPromise: Promise<void> | undefined;
  // These two host hooks can outlive abortable() at their call sites. Count their underlying
  // promises through settlement, without cancelling, serializing, or replaying callback work.
  const callbacks = { beforeExecute: 0, onToolCall: 0 };
  const pendingCallback = () => {
    if (callbacks.beforeExecute > 0) {
      return "MCP beforeExecute callback is pending";
    }
    if (callbacks.onToolCall > 0) {
      return "MCP onToolCall callback is pending";
    }
    return;
  };

  const reportCleanupFailure = (error: unknown, late: boolean) => {
    console.error(
      `MCP: ${late ? "late " : ""}runtime cleanup failed: ${formatTerminalError(error)}`,
    );
  };

  return {
    signal: controller.signal,
    runCallback: async (kind, run) => {
      // Invocation/cancellation policy stays at the call site. In particular, an accepted
      // tool's outcome callback may still need to persist its result during shutdown.
      callbacks[kind]++;
      try {
        return await run();
      } finally {
        callbacks[kind]--;
      }
    },
    isActive: () => !controller.signal.aborted,
    addCleanup: (cleanup) => {
      if (controller.signal.aborted) {
        Promise.resolve()
          .then(cleanup)
          .catch((error: unknown) => reportCleanupFailure(error, true));
        return;
      }
      cleanups.push(cleanup);
    },
    stop: (reason = "MCP extension runtime stopped") => {
      if (stopPromise) {
        return stopPromise;
      }
      controller.abort(new Error(reason));
      const pendingCleanups = cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => Promise.resolve().then(cleanup));
      stopPromise = Promise.allSettled(pendingCleanups).then((results) => {
        const failures: unknown[] = results.flatMap((result): unknown[] =>
          result.status === "rejected" ? [result.reason] : [],
        );
        const callback = pendingCallback();
        if (callback !== undefined) {
          failures.push(new Error(callback));
        }
        if (failures.length > 0) {
          const aggregate = new AggregateError(failures, "MCP runtime cleanup failed");
          console.error(`MCP: runtime cleanup failed: ${formatTerminalError(aggregate)}`);
          throw aggregate;
        }
        return;
      });
      return stopPromise;
    },
    throwIfInactive: () => {
      controller.signal.throwIfAborted();
    },
  };
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

/** Fence session-bound UI calls after the owning extension runtime stops. */
export function createOwnedUi(ui: ExtensionUIContext, owner: McpRuntimeOwner): ExtensionUIContext {
  const proxies = new WeakMap<object, object>();
  const handler: ProxyHandler<object> = {
    get(target, property) {
      if (!owner.isActive()) {
        return;
      }
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member === "function") {
        return (...args: unknown[]): unknown => {
          if (!owner.isActive()) {
            return;
          }
          return Reflect.apply(member, target, args);
        };
      }
      return owner.isActive() ? wrap(member) : undefined;
    },
  };
  const wrap = (value: unknown): unknown => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return value;
    }
    const existing = proxies.get(value);
    if (existing) {
      return existing;
    }
    const proxy = new Proxy(value, handler);
    proxies.set(value, proxy);
    return proxy;
  };
  const owned = new Proxy<ExtensionUIContext>(ui, handler);
  proxies.set(ui, owned);
  return owned;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "MCP extension runtime stopped")
  );
}
