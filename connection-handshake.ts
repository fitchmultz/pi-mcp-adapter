import type { ConnectOptions, Transport } from "@modelcontextprotocol/client";
import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ManagedClient } from "./connection-runtime.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { drainClientCallbacks } from "./client-operations.ts";
import { cleanupFailures } from "./connection-disposal.ts";

let connectionRuntimePromise: Promise<typeof ConnectionRuntime> | undefined;

export function loadConnectionRuntime(): Promise<typeof ConnectionRuntime> {
  connectionRuntimePromise ??= import("./connection-runtime.ts").catch((error: unknown) => {
    connectionRuntimePromise = undefined;
    throw error;
  });
  return connectionRuntimePromise;
}

export async function closeFailedConnectionSetup(
  client: ManagedClient,
  transport: Transport,
  failure: unknown,
  releaseWhenSettled: (client: ManagedClient) => void,
): Promise<unknown[]> {
  const abortCleanup = ConnectionHandshake.cleanup(transport);
  const abortCleanupFailed =
    failure instanceof AggregateError && failure.message === "MCP connection abort cleanup failed";
  const results = abortCleanupFailed
    ? []
    : await Promise.allSettled([abortCleanup ?? Promise.resolve().then(() => client.close())]);
  await drainClientCallbacks(client);
  releaseWhenSettled(client);
  return cleanupFailures(results);
}

export class ConnectionHandshake {
  private static readonly cleanups = new WeakMap<Transport, Promise<void>>();
  private readonly client: ManagedClient;
  private readonly transport: Transport;
  private readonly connectOptions: ConnectOptions | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(
    client: ManagedClient,
    transport: Transport,
    connectOptions: ConnectOptions | undefined,
    signal: AbortSignal | undefined,
  ) {
    this.client = client;
    this.transport = transport;
    this.connectOptions = connectOptions;
    this.signal = signal;
  }

  static cleanup(transport: Transport): Promise<void> | undefined {
    return this.cleanups.get(transport);
  }

  async run(): Promise<void> {
    const { signal, client, connectOptions } = this;
    throwIfAborted(signal);
    const send = this.transport.send.bind(this.transport);
    // Last layer of transport-callback patching (http → tool-transport → mcp-trace → here);
    // this wrapper chains the previous send and is never restored.
    this.transport.send = (...args) => client.ownSend(() => send(...args));
    let abortCleanup: Promise<void> | undefined;
    const closeTransport = () => {
      abortCleanup = Promise.resolve().then(() => this.transport.close());
      ConnectionHandshake.cleanups.set(this.transport, abortCleanup);
    };
    signal?.addEventListener("abort", closeTransport, { once: true });
    try {
      await abortable(client.connect(this.transport, connectOptions), signal);
      await abortCleanup;
    } catch (error) {
      if (abortCleanup) {
        try {
          await abortCleanup;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "MCP connection abort cleanup failed", {
            cause: cleanupError,
          });
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeTransport);
    }
  }
}
