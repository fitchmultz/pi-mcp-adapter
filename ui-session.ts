import { UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { UiHostContext, UiSessionMessages, UiStreamSummary } from "./types.ts";
import { UI_STREAM_HOST_CONTEXT_KEY } from "./ui-stream-types.ts";
import { logger } from "./logger.ts";
import { startUiServer } from "./ui-server.ts";
import type { UiServerHandle } from "./ui-server-contracts.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";
import type {
  UiSessionRequest,
  UiSessionRuntime,
  UiSessionResultSummary,
} from "./ui-session-contracts.ts";
import { createUiStreamIdentity, UiSessionStream } from "./ui-session-stream.ts";
import { UiSessionEvents } from "./ui-session-events.ts";
import { closeActiveUiWindow, openUiViewer } from "./ui-session-viewer.ts";

export type {
  UiSessionRequest,
  UiSessionRuntime,
  UiSessionResultSummary,
  UiSessionViewer,
} from "./ui-session-contracts.ts";

const MAX_COMPLETED_SESSIONS = 10;

export function summarizeUiSessionResult(
  uiSession: UiSessionRuntime | null,
): UiSessionResultSummary {
  if (!uiSession) {
    return {
      message: "Interactive UI was unavailable; returning the tool result inline.",
      uiOpen: false,
    };
  }
  if (!uiSession.windowOpen) {
    const action = uiSession.reused
      ? "Updated the suppressed MCP UI session."
      : "MCP UI window was suppressed.";
    return {
      message: `${action} Open manually: ${uiSession.url}`,
      uiOpen: false,
      uiViewer: uiSession.viewer,
      uiUrl: uiSession.url,
    };
  }
  return {
    message: uiSession.reused
      ? "Updated the open UI."
      : "Interactive UI is open. I'll respond to your prompts and intents as you interact with it.",
    uiOpen: true,
    uiViewer: uiSession.viewer,
    uiUrl: uiSession.url,
  };
}

export async function maybeStartUiSession(
  state: McpExtensionState,
  request: UiSessionRequest,
): Promise<UiSessionRuntime | null> {
  const signal =
    combineAbortSignals(state.owner.signal, request.signal) ?? new AbortController().signal;
  const session = new UiSession(state, request, signal);
  try {
    return await session.start();
  } catch (error) {
    if (error instanceof UrlElicitationRequiredError || isAbortError(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger
      .child({ component: "UiSession", server: request.serverName, tool: request.toolName })
      .error("Failed to start UI session", error instanceof Error ? error : undefined);
    state.ui?.notify(
      `MCP UI unavailable for ${request.toolName} (${request.serverName}): ${message}`,
      "warning",
    );
    return null;
  }
}

/** Owns registration, archival and viewer cleanup for a newly opened session. */
class UiSession {
  private readonly state: McpExtensionState;
  private readonly request: UiSessionRequest;
  private readonly signal: AbortSignal;
  private readonly log: ReturnType<typeof logger.child>;
  private handle: UiServerHandle | undefined;
  private stream: UiSessionStream | undefined;

  constructor(state: McpExtensionState, request: UiSessionRequest, signal: AbortSignal) {
    this.state = state;
    this.request = request;
    this.signal = signal;
    this.log = logger.child({
      component: "UiSession",
      server: request.serverName,
      tool: request.toolName,
    });
  }

  async start(): Promise<UiSessionRuntime> {
    throwIfAborted(this.signal);
    const existing = this.state.uiServer;
    const request = this.request;
    if (
      existing &&
      existing.serverName === request.serverName &&
      existing.toolName === request.toolName
    ) {
      const stream = new UiSessionStream(this.state, request, existing, {
        ...createUiStreamIdentity(request.streamMode),
        reused: true,
      });
      existing.sendToolInput(request.toolArgs);
      stream.register();
      return stream.runtime(existing.viewer ?? "browser", existing.windowOpen ?? true);
    }
    return this.open();
  }

  private async open(): Promise<UiSessionRuntime> {
    const state = this.state;
    const request = this.request;
    const resource = await state.uiResourceHandler.readUiResource(
      request.serverName,
      request.uiResourceUri,
      { config: state.config, signal: this.signal, onNeedsAuth: request.onNeedsAuth },
    );
    throwIfAborted(this.signal);
    this.replaceExisting();
    const identity = createUiStreamIdentity(request.streamMode);
    const hostContext: UiHostContext | undefined =
      request.streamMode !== undefined && identity.streamId !== undefined
        ? {
            [UI_STREAM_HOST_CONTEXT_KEY]: {
              mode: request.streamMode,
              streamId: identity.streamId,
              intermediateResultPatches: request.streamMode === "stream-first",
              partialInput: false,
            },
          }
        : undefined;
    const events = new UiSessionEvents(state, request);
    const handle = await startUiServer({
      serverName: request.serverName,
      toolName: request.toolName,
      toolArgs: request.streamMode === "stream-first" ? {} : request.toolArgs,
      resource,
      manager: state.manager,
      config: state.config,
      state,
      consentManager: state.consentManager,
      ...(request.onNeedsAuth ? { onNeedsAuth: request.onNeedsAuth } : {}),
      ...(hostContext !== undefined ? { hostContext } : {}),
      onMessage: (params) => events.message(params),
      onContextUpdate: (params) => events.context(params),
      onComplete: (reason) => this.complete(reason),
    });
    this.handle = handle;
    if (!state.owner.isActive() || this.signal.aborted) {
      handle.close("runtime_owner_stopped");
      throwIfAborted(this.signal);
      throw new Error("MCP UI session became stale before registration");
    }
    const stream = new UiSessionStream(state, request, handle, { ...identity, reused: false });
    this.stream = stream;
    stream.register();
    this.state.uiServer = handle;
    const viewer = await openUiViewer({
      state,
      request,
      handle,
      signal: this.signal,
      isActive: () => stream.isActive(),
    });
    throwIfAborted(this.signal);
    handle.viewer = viewer.viewer;
    handle.windowOpen = viewer.windowOpen;
    return stream.runtime(viewer.viewer, viewer.windowOpen);
  }

  private replaceExisting(): void {
    if (this.state.uiServer) {
      this.state.uiServer.close("replaced");
      this.state.uiServer = null;
    }
    closeActiveUiWindow();
  }

  private complete(reason: string): void {
    this.stream?.deactivate();
    const handle = this.handle;
    if (!handle || this.state.uiServer !== handle) {
      return;
    }
    const messages = handle.getSessionMessages();
    const stream = handle.getStreamSummary();
    if (hasSessionContent(messages, stream)) {
      this.state.completedUiSessions.push({
        serverName: handle.serverName,
        toolName: handle.toolName,
        completedAt: new Date(),
        reason,
        messages,
        ...(stream !== undefined ? { stream } : {}),
      });
      while (this.state.completedUiSessions.length > MAX_COMPLETED_SESSIONS) {
        this.state.completedUiSessions.shift();
      }
      this.log.debug("Session completed", {
        reason,
        prompts: messages.historyCount ?? messages.prompts.length,
        intents: messages.intents.length,
        notifications: messages.notifications.length,
        contexts: messages.contexts.length,
        streamFrames: stream?.frames ?? 0,
      });
    }
    this.state.uiServer = null;
    closeActiveUiWindow();
  }
}

function hasSessionContent(
  messages: UiSessionMessages,
  stream: UiStreamSummary | undefined,
): boolean {
  return (
    Boolean(messages.historyCount) ||
    messages.prompts.length > 0 ||
    messages.intents.length > 0 ||
    messages.notifications.length > 0 ||
    messages.contexts.length > 0 ||
    Boolean(stream)
  );
}
