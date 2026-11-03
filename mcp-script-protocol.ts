import { asObjectRecord } from "./mcp-output-values.ts";

export type ScriptRequest =
  | { type: "call"; id: number; path: string; args?: unknown; server?: string }
  | {
      type: "search" | "describe" | "resources" | "readResource" | "readResult";
      id: number;
      input?: unknown;
    };
export type WorkerMessage =
  | { type: "emit"; block: unknown; size: number }
  | ScriptRequest
  | { type: "done"; returnBlock?: unknown }
  | { type: "error"; message: string };

function parseRequest(message: Record<string, unknown>): ScriptRequest | null {
  if (typeof message.id !== "number") {
    return null;
  }
  if (message.type === "call" && typeof message.path === "string") {
    return {
      type: "call",
      id: message.id,
      path: message.path,
      ...(message.args !== undefined ? { args: message.args } : {}),
      ...(typeof message.server === "string" ? { server: message.server } : {}),
    };
  }
  return parseDiscoveryRequest({ ...message, id: message.id });
}

function parseDiscoveryRequest(
  message: Record<string, unknown> & { id: number },
): ScriptRequest | null {
  const { type } = message;
  if (
    type === "search" ||
    type === "describe" ||
    type === "resources" ||
    type === "readResource" ||
    type === "readResult"
  ) {
    return { type, id: message.id, ...("input" in message ? { input: message.input } : {}) };
  }
  return null;
}

export function parseWorkerMessage(value: unknown): WorkerMessage | null {
  const message = asObjectRecord(value);
  if (message === undefined) {
    return null;
  }
  if (message.type === "emit" && "block" in message) {
    // Older worker files restored under a running Pi neither charge the window nor send a size.
    return {
      type: "emit",
      block: message.block,
      size: typeof message.size === "number" ? message.size : 0,
    };
  }
  if (message.type === "done") {
    return {
      type: "done",
      ...("returnBlock" in message ? { returnBlock: message.returnBlock } : {}),
    };
  }
  if (message.type === "error" && typeof message.message === "string") {
    return { type: "error", message: message.message };
  }
  return parseRequest(message);
}
