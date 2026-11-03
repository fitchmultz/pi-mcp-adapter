import type * as ClientModule from "@modelcontextprotocol/client";
import type * as StdioModule from "@modelcontextprotocol/client/stdio";
import { vi } from "vitest";

type Observation = {
  clients: ClientModule.Client[];
  stdio: Array<{
    transport: StdioModule.StdioClientTransport;
    parameters: ConstructorParameters<typeof StdioModule.StdioClientTransport>[0];
  }>;
  records: Array<{
    client: ClientModule.Client;
    transport: Parameters<ClientModule.Client["connect"]>[0];
    connected: PromiseWithResolvers<null>;
  }>;
  entered: PromiseWithResolvers<null>;
  afterConnect: Promise<unknown> | undefined;
};
let observation: Observation | undefined;

/** Observe actual SDK classes, optionally holding completion after a real handshake. */
export function observeNativeConnections(afterConnect?: Promise<unknown>): Observation {
  observation = {
    clients: [],
    stdio: [],
    records: [],
    entered: Promise.withResolvers<null>(),
    afterConnect,
  };
  return observation;
}

export async function nativeClientModule(): Promise<typeof ClientModule> {
  const sdk = await vi.importActual<typeof ClientModule>("@modelcontextprotocol/client");
  class ObservedClient extends sdk.Client {
    constructor(...args: ConstructorParameters<typeof sdk.Client>) {
      super(...args);
      observation?.clients.push(this);
    }
    override async connect(...args: Parameters<ClientModule.Client["connect"]>): Promise<void> {
      const current = observation;
      const connected = Promise.withResolvers<null>();
      current?.records.push({ client: this, transport: args[0], connected });
      current?.entered.resolve(null);
      await super.connect(...args);
      connected.resolve(null);
      await current?.afterConnect;
    }
  }
  return { ...sdk, Client: ObservedClient };
}

export async function nativeStdioModule(): Promise<typeof StdioModule> {
  const sdk = await vi.importActual<typeof StdioModule>("@modelcontextprotocol/client/stdio");
  class ObservedStdio extends sdk.StdioClientTransport {
    constructor(...args: ConstructorParameters<typeof sdk.StdioClientTransport>) {
      super(...args);
      observation?.stdio.push({ transport: this, parameters: args[0] });
    }
  }
  return { ...sdk, StdioClientTransport: ObservedStdio };
}
