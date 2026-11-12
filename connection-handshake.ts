import type { RequestOptions, Transport } from "@modelcontextprotocol/client";
import type { ManagedClient } from "./connection-runtime.ts";
import { abortable, throwIfAborted } from "./abort.ts";

export class ConnectionHandshake {
  private static readonly cleanups = new WeakMap<Transport, Promise<void>>();
  private readonly client: ManagedClient;
  private readonly transport: Transport;
  private readonly requestOptions: RequestOptions | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(
    client: ManagedClient,
    transport: Transport,
    requestOptions: RequestOptions | undefined,
    signal: AbortSignal | undefined,
  ) {
    this.client = client;
    this.transport = transport;
    this.requestOptions = requestOptions;
    this.signal = signal;
  }

  static cleanup(transport: Transport): Promise<void> | undefined {
    return this.cleanups.get(transport);
  }

  async run(): Promise<void> {
    const { signal, client, requestOptions } = this;
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
      await abortable(client.connect(this.transport, requestOptions), signal);
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
