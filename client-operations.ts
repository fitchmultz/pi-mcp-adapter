import type { Client } from "@modelcontextprotocol/client";

export type ClientOperation = "request/refresh" | "sampling callback" | "elicitation callback" | "subscription";
export const clientOperations = new WeakMap<Client, Map<Promise<unknown>, ClientOperation>>();

export async function drainClientCallbacks(client: Client): Promise<void> {
  for (;;) {
    const pending = [...(clientOperations.get(client) ?? [])]
      .filter(([, kind]) => kind === "sampling callback" || kind === "elicitation callback")
      .map(([operation]) => operation);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

export async function drainClientOperations(client: Client): Promise<void> {
  for (;;) {
    const pending = [...(clientOperations.get(client)?.keys() ?? [])];
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}
