import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import { sendUiStreamPatch } from "./ui-server-handle.ts";
import type {
  UiSessionRequest,
  UiSessionRuntime,
  UiSessionViewer,
} from "./ui-session-contracts.ts";
import type { UiStreamMode } from "./types.ts";
import {
  UI_STREAM_REQUEST_META_KEY,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  type UiStreamCallToolResult,
} from "./ui-stream-types.ts";
import { isUiJsonObject } from "./ui-json.ts";

export interface UiStreamIdentity {
  streamId: string | undefined;
  streamToken: string | undefined;
}

export function createUiStreamIdentity(mode: UiStreamMode | undefined): UiStreamIdentity {
  return {
    streamId: mode !== undefined ? randomUUID() : undefined,
    streamToken: mode !== undefined ? randomUUID() : undefined,
  };
}

function withStreamEnvelope(
  result: CallToolResult,
  streamId: string | undefined,
  sequence: number,
  terminal: boolean,
): CallToolResult;
function withStreamEnvelope(
  result: UiStreamCallToolResult,
  streamId: string | undefined,
  sequence: number,
  terminal: boolean,
): UiStreamCallToolResult;
function withStreamEnvelope(
  result: CallToolResult | UiStreamCallToolResult,
  streamId: string | undefined,
  sequence: number,
  terminal: boolean,
): CallToolResult | UiStreamCallToolResult {
  if (streamId === undefined || streamId === "") {
    return result;
  }
  const structuredContent = isUiJsonObject(result.structuredContent)
    ? { ...result.structuredContent }
    : {};
  const rawEnvelope = structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY];
  const supplied = isUiJsonObject(rawEnvelope) ? { ...rawEnvelope } : undefined;
  const envelope = supplied ?? {
    frameType: "final",
    phase: "settled",
    status: result.isError === true ? "error" : "ok",
  };
  // The result frame ends the stream: a server's own label cannot keep it looking unfinished.
  const framed = terminal ? { ...envelope, frameType: "final" as const } : envelope;
  structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY] = { ...framed, streamId, sequence };
  return { ...result, structuredContent };
}

/** One call's listener and sequence, independent of a reused window's lifetime. */
export class UiSessionStream {
  readonly streamId: string | undefined;
  readonly streamToken: string | undefined;
  private readonly state: McpExtensionState;
  private readonly request: UiSessionRequest;
  private readonly handle: UiServerHandle;
  private readonly reused: boolean;
  private active = true;
  private sequence = 0;

  constructor(
    state: McpExtensionState,
    request: UiSessionRequest,
    handle: UiServerHandle,
    identity: UiStreamIdentity & { reused: boolean },
  ) {
    this.state = state;
    this.request = request;
    this.handle = handle;
    this.reused = identity.reused;
    this.streamId = identity.streamId;
    this.streamToken = identity.streamToken;
  }

  register(): void {
    if (this.streamToken !== undefined) {
      this.state.manager.registerUiStreamListener(this.streamToken, (serverName, notification) => {
        if (this.isActive() && serverName === this.request.serverName) {
          this.sequence += 1;
          sendUiStreamPatch(
            this.handle,
            withStreamEnvelope(notification.result, this.streamId, this.sequence, false),
          );
        }
      });
    }
  }

  deactivate(): void {
    this.active = false;
    if (this.streamToken !== undefined) {
      this.state.manager.removeUiStreamListener(this.streamToken);
    }
  }

  isActive(): boolean {
    return this.active && this.state.uiServer === this.handle;
  }

  runtime(viewer: UiSessionViewer, windowOpen: boolean): UiSessionRuntime {
    const request = this.request;
    return {
      serverName: request.serverName,
      toolName: request.toolName,
      reused: this.reused,
      ...(this.streamId !== undefined ? { streamId: this.streamId } : {}),
      ...(this.streamToken !== undefined
        ? {
            streamToken: this.streamToken,
            requestMeta: { [UI_STREAM_REQUEST_META_KEY]: this.streamToken },
          }
        : {}),
      ...(request.streamMode !== undefined ? { streamMode: request.streamMode } : {}),
      url: this.handle.url,
      viewer,
      windowOpen,
      isActive: () => this.isActive(),
      sendToolResult: (result) => this.sendResult(result, false),
      sendResultPatch: (result) => this.sendResult(result, true),
      sendToolCancelled: (reason) => this.cancel(reason),
      close: (reason) => {
        this.deactivate();
        if (!this.reused) {
          this.handle.close(reason);
        }
      },
    };
  }

  private sendResult(result: CallToolResult, patch: boolean): void {
    if (!this.isActive()) {
      return;
    }
    this.sequence += 1;
    const framed = withStreamEnvelope(result, this.streamId, this.sequence, !patch);
    if (patch) {
      this.handle.sendResultPatch(framed);
    } else {
      this.handle.sendToolResult(framed);
    }
  }

  private cancel(reason: string): void {
    if (!this.isActive()) {
      return;
    }
    if (this.reused) {
      this.sendResult({ isError: true, content: [{ type: "text", text: reason }] }, false);
    } else {
      this.handle.sendToolCancelled(reason);
    }
  }
}
