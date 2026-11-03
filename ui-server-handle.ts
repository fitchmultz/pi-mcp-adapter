import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import type { UiHostContext, UiSessionMessages, UiStreamSummary } from "./types.ts";
import type { UiStreamCallToolResult } from "./ui-stream-types.ts";

type SessionAddress = Pick<
  UiServerHandle,
  "url" | "port" | "sessionToken" | "serverName" | "toolName"
>;
interface SessionChannel {
  hostContext: UiHostContext;
  push: (name: string, payload: unknown) => void;
  close: UiServerHandle["close"];
  getMessages: UiServerHandle["getSessionMessages"];
  getSummary: UiServerHandle["getStreamSummary"];
}

/** Native HTTP handle also accepts the adapter's partial-result notification contract. */
export class UiServerSessionHandle implements UiServerHandle {
  readonly url: string;
  readonly port: number;
  readonly sessionToken: string;
  readonly serverName: string;
  readonly toolName: string;
  declare viewer?: NonNullable<UiServerHandle["viewer"]>;
  declare windowOpen?: boolean;
  readonly #channel: SessionChannel;

  constructor(address: SessionAddress, channel: SessionChannel) {
    this.url = address.url;
    this.port = address.port;
    this.sessionToken = address.sessionToken;
    this.serverName = address.serverName;
    this.toolName = address.toolName;
    this.#channel = channel;
  }

  close = (reason?: string): void => {
    this.#channel.close(reason);
  };

  sendToolInput = (args: Record<string, unknown>): void => {
    this.#channel.push("tool-input", { arguments: args });
  };

  sendToolResult = (result: CallToolResult): void => {
    this.#channel.push("tool-result", result);
  };

  sendResultPatch = (result: CallToolResult | UiStreamCallToolResult): void => {
    this.#channel.push("result-patch", result);
  };

  sendToolCancelled = (reason: string): void => {
    this.#channel.push("tool-cancelled", { reason });
  };

  sendHostContext = (context: UiHostContext): void => {
    Object.assign(this.#channel.hostContext, context);
    this.#channel.push("host-context", context);
  };

  getSessionMessages = (): UiSessionMessages => {
    return this.#channel.getMessages();
  };

  getStreamSummary = (): UiStreamSummary | undefined => {
    return this.#channel.getSummary();
  };
}

export function sendUiStreamPatch(handle: UiServerHandle, result: UiStreamCallToolResult): void {
  if (handle instanceof UiServerSessionHandle) {
    handle.sendResultPatch(result);
    return;
  }
  // External handles expose the public native-result API, not the HTTP raw patch sink.
  handle.sendResultPatch(CallToolResultSchema.parse(result));
}
