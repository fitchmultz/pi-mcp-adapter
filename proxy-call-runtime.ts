import type { Client, RequestOptions } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { ServerConnection } from "./server-connection.ts";
import {
  type ProxyToolResult,
  type ProxyToolUpdateCallback,
  emitProxyUpdate,
} from "./proxy-result.ts";
import type {
  ToolMetadata,
  McpOperationContext,
  McpToolCallEvent,
  McpToolCallIdentity,
} from "./types.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import type { UiSessionRuntime } from "./ui-session.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { connectionStderrTail } from "./connection-stdio.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  retainMcpResult,
  resolveMcpOutputGuardOptions,
  formatMcpResultReference,
} from "./mcp-output-guard.ts";
import {
  formatInterruptedTimeoutMessage,
  formatProgressText,
  formatTimeoutMessage,
  inputValidationHint,
  toolCallResult,
} from "./proxy-call-result.ts";
/** The part of a tool call that is identical for proxy and direct tools. */
type ToolCallTarget = Pick<
  ToolMetadata,
  "originalName" | "inputSchema" | "annotations" | "resourceUri" | "uiResourceUri" | "uiStreamMode"
>;

interface ToolCallOptions extends McpToolCallIdentity {
  beforeDispatch?: (
    signal: AbortSignal | undefined,
    operation: McpOperationContext,
  ) => Promise<void>;
  /** Spread into every details payload: identity, and `mode` for proxy calls. */
  detailsBase: Record<string, unknown>;
  ownedSignal: AbortSignal | undefined;
  /** Caller-supplied signal, passed to the UI session rather than the MCP call. */
  signal: AbortSignal | undefined;
  onUpdate?: ProxyToolUpdateCallback | undefined;
  recoverAuthConnection: NonNullable<SessionRecoveryDeps["onNeedsAuth"]>;
  authRequiredMessage: () => string;
  autoAuthAttempted: () => boolean;
}

function createNoProgressBudget(
  callerSignal: AbortSignal,
  remainingTimeoutMs: number | undefined,
  sdk: RuntimeDependencies["sdk"],
): { signal: AbortSignal; clear?: () => void } {
  if (remainingTimeoutMs === undefined) {
    return { signal: callerSignal };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new sdk.SdkError(sdk.SdkErrorCode.RequestTimeout, "Request timed out"));
  }, remainingTimeoutMs);
  timer.unref();
  return {
    signal: combineAbortSignals(callerSignal, controller.signal) ?? controller.signal,
    clear: () => clearTimeout(timer),
  };
}

type RuntimeDependencies = Awaited<ReturnType<typeof loadCallDependencies>>;
async function loadCallDependencies() {
  const [sdk, recovery, ui] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("./session-recovery.ts"),
    import("./ui-session.ts"),
  ]);
  return { sdk, recovery, ui };
}
interface CallRequest {
  state: McpExtensionState;
  serverName: string;
  target: ToolCallTarget;
  args: Record<string, unknown> | undefined;
  options: ToolCallOptions;
}
export async function runToolCall(request: CallRequest): Promise<ProxyToolResult> {
  const dependencies = await loadCallDependencies();
  return new ToolCallRuntime(request, dependencies).run();
}
class ToolCallRuntime {
  private uiSession: UiSessionRuntime | null = null;
  private uiAttempted = false;
  private beforeDispatchPending = false;
  private captureFailure: McpToolCallEvent | undefined;
  private activeConnection: ServerConnection | undefined;
  private readonly configuredOptions: RequestOptions | undefined;
  private readonly callerSignal: AbortSignal;
  private readonly outputGuardOptions: ReturnType<typeof resolveMcpOutputGuardOptions>;
  private readonly identity: McpToolCallIdentity & { server: string; tool: string };
  private readonly request: CallRequest;
  private readonly deps: RuntimeDependencies;
  constructor(request: CallRequest, deps: RuntimeDependencies) {
    this.request = request;
    this.deps = deps;

    const { state, serverName, target, options } = request;
    this.configuredOptions = state.manager.getRequestOptions(serverName, options.ownedSignal);
    this.callerSignal =
      combineAbortSignals(this.configuredOptions?.signal, options.ownedSignal) ??
      state.owner.signal;
    this.outputGuardOptions = resolveMcpOutputGuardOptions(
      state.config.settings,
      state.outputDirectory,
    );
    this.identity = {
      server: serverName,
      tool: target.originalName,
      ...(options.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
    };
  }
  private async capture(event: McpToolCallEvent): Promise<void> {
    const { state } = this.request;
    const callback = state.onToolCall;
    if (!callback) {
      return;
    }
    try {
      await abortable(
        state.owner.runCallback("onToolCall", () => callback(event)),
        event.signal,
      );
      throwIfAborted(event.signal);
    } catch (error) {
      this.captureFailure = event;
      throw error;
    }
  }
  private async prepareUi(): Promise<void> {
    const { state, serverName, target, args, options } = this.request;
    if (
      (target.resourceUri ?? "").length === 0 &&
      target.uiResourceUri !== undefined &&
      target.uiResourceUri.length > 0 &&
      !this.deps.ui.isUiViewerDisabled(state, serverName)
    ) {
      this.uiAttempted = true;
      this.uiSession = await abortable(
        this.deps.ui.maybeStartUiSession(state, {
          serverName,
          toolName: target.originalName,
          toolArgs: args ?? {},
          uiResourceUri: target.uiResourceUri,
          ...(target.uiStreamMode !== undefined ? { streamMode: target.uiStreamMode } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onNeedsAuth: options.recoverAuthConnection,
        }),
        this.callerSignal,
      );
    }
  }
  private async prepareOperation(): Promise<Omit<McpOperationContext, "annotationsTrusted">> {
    const { state, serverName, target, args, options } = this.request;
    await this.prepareUi();
    const liveTools = state.manager.getConnection(serverName)?.tools;
    const annotations = liveTools
      ? liveTools.find((tool) => tool.name === target.originalName)?.annotations
      : target.annotations;
    const operation = {
      ...this.identity,
      args: args ?? {},
      ...(annotations !== undefined ? { annotations } : {}),
      ...((target.resourceUri ?? "").length > 0 ? { resourceUri: target.resourceUri } : {}),
    };
    const beforeDispatch = options.beforeDispatch;
    if (beforeDispatch) {
      this.beforeDispatchPending = true;
      await abortable(
        state.owner.runCallback("beforeExecute", () =>
          beforeDispatch(this.callerSignal, {
            ...operation,
            annotationsTrusted:
              state.config.mcpServers[serverName]?.retryOnTransportFailure === true,
          }),
        ),
        this.callerSignal,
      );
      this.beforeDispatchPending = false;
    }
    throwIfAborted(this.callerSignal);
    return operation;
  }
  private async captureDispatch<T>(
    call: Omit<Extract<McpToolCallEvent, { phase: "before" }>, "phase">,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    await this.capture({ ...call, phase: "before" });
    throwIfAborted(call.signal);
    let result: T;
    try {
      result = await dispatch();
    } catch (error) {
      await this.capture({ ...call, phase: "after", error });
      throw error;
    }
    await this.capture({ ...call, phase: "after", result });
    return result;
  }
  private effectiveTimeoutMs(): number {
    return this.configuredOptions?.timeout ?? this.deps.sdk.DEFAULT_REQUEST_TIMEOUT_MSEC;
  }
  private progressHandler(): NonNullable<RequestOptions["onprogress"]> {
    const { serverName, target, options } = this.request;
    const details =
      (target.resourceUri ?? "").length > 0
        ? { server: serverName, tool: target.originalName, resourceUri: target.resourceUri }
        : { server: serverName, tool: target.originalName };
    return (progress) => {
      emitProxyUpdate(options.onUpdate, formatProgressText(progress), details);
    };
  }
  private requestOptionsFor(
    onprogress: NonNullable<RequestOptions["onprogress"]>,
    signal: AbortSignal = this.callerSignal,
  ): RequestOptions {
    return {
      ...this.configuredOptions,
      signal,
      onprogress,
      resetTimeoutOnProgress: true,
    };
  }
  private dispatchToolCall(
    operation: Omit<McpOperationContext, "annotationsTrusted">,
    recovery: SessionRecoveryDeps,
    call: Omit<Extract<McpToolCallEvent, { phase: "before" }>, "phase">,
    onprogress: NonNullable<RequestOptions["onprogress"]>,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const { serverName, target, args } = this.request;
    const signal = this.callerSignal;
    let lastConnection: ServerConnection | undefined;
    let attemptStartedAt = Date.now();
    let sawProgress = false;
    return this.captureDispatch(call, () =>
      this.deps.recovery.trackToolCallOutcome(
        () =>
          this.deps.recovery.withSessionRecovery<Awaited<ReturnType<Client["callTool"]>>>(
            {
              ...recovery,
              retryOnTransportFailure:
                operation.annotations?.readOnlyHint === true ||
                operation.annotations?.idempotentHint === true,
            },
            serverName,
            async (connection) => {
              this.activeConnection = connection;
              const sameConnectionRetry = lastConnection === connection;
              const remainingTimeoutMs =
                sameConnectionRetry && !sawProgress
                  ? Math.max(1, this.effectiveTimeoutMs() - (Date.now() - attemptStartedAt))
                  : undefined;
              if (!sameConnectionRetry || sawProgress) {
                lastConnection = connection;
                attemptStartedAt = Date.now();
                sawProgress = false;
              }
              const budget = createNoProgressBudget(signal, remainingTimeoutMs, this.deps.sdk);
              const trackedProgress: NonNullable<RequestOptions["onprogress"]> = (progress) => {
                sawProgress = true;
                budget.clear?.();
                onprogress(progress);
              };
              try {
                return await abortable(
                  connection.client.callTool(
                    {
                      name: target.originalName,
                      arguments: args ?? {},
                      _meta: this.uiSession?.requestMeta,
                    },
                    this.requestOptionsFor(trackedProgress, budget.signal),
                  ),
                  budget.signal,
                );
              } finally {
                budget.clear?.();
              }
            },
          ),
        signal,
      ),
    );
  }
  private async dispatch(
    operation: Omit<McpOperationContext, "annotationsTrusted">,
  ): Promise<Record<string, unknown>> {
    const { state, serverName, target, options } = this.request;
    const signal = this.callerSignal;
    const onprogress = this.progressHandler();
    const recovery: SessionRecoveryDeps = {
      manager: state.manager,
      config: state.config,
      signal,
      onNeedsAuth: options.recoverAuthConnection,
    };
    const call = { ...operation, signal };
    const resourceUri = target.resourceUri;
    if (resourceUri !== undefined && resourceUri.length > 0) {
      const requestOptions = this.requestOptionsFor(onprogress);
      return this.captureDispatch(call, () =>
        this.deps.recovery.withSessionRecovery(recovery, serverName, (connection) => {
          this.activeConnection = connection;
          return abortable(
            connection.client.readResource({ uri: resourceUri }, requestOptions),
            signal,
          );
        }),
      );
    }
    const result = await this.dispatchToolCall(operation, recovery, call, onprogress);
    this.uiSession?.sendToolResult(result);
    return result;
  }
  async run(): Promise<ProxyToolResult> {
    const { state, serverName, target, options } = this.request;
    // Count on the connection this call will dispatch on, if one exists yet; a call that
    // recovery later migrates keeps its count on the connection it started on.
    const connection = state.manager.getConnection(serverName);
    this.activeConnection = connection;
    try {
      state.manager.touch(serverName);
      if (connection !== undefined) {
        state.manager.incrementInFlight(connection);
      }
      throwIfAborted(this.callerSignal);
      const operation = await this.prepareOperation();
      const result = await this.dispatch(operation);
      return await toolCallResult(result, {
        target,
        uiSummary: this.uiAttempted
          ? this.deps.ui.summarizeUiSessionResult(this.uiSession)
          : undefined,
        detailsBase: options.detailsBase,
        outputGuardOptions: this.outputGuardOptions,
      });
    } catch (error) {
      if (this.beforeDispatchPending) {
        throw error;
      }
      return await this.failure(error);
    } finally {
      if (this.uiSession?.reused === true) {
        this.uiSession.close();
      }
      if (connection !== undefined) {
        state.manager.decrementInFlight(connection);
      }
      state.manager.touch(serverName);
    }
  }
  private async captureFailureResult(
    error: unknown,
    failure: McpToolCallEvent,
  ): Promise<ProxyToolResult> {
    const { signal: _signal, ...context } = failure;
    const message =
      failure.phase === "before"
        ? "MCP call capture failed before dispatch; the tool did not run. Restore capture before continuing."
        : "MCP outcome capture failed. Use the retained outcome to continue the original work; do not repeat a completed call.";
    this.uiSession?.sendToolCancelled(message);
    const retained =
      "result" in failure && failure.result !== undefined
        ? await retainMcpResult(failure.result, {
            ...this.outputGuardOptions,
            enabled: true,
            detailsMaxBytes: 1,
          })
        : {};
    return {
      content: [
        { type: "text", text: message },
        ...(retained.resultRef !== undefined && retained.resultRef.length > 0
          ? [{ type: "text" as const, text: formatMcpResultReference(retained.resultRef) }]
          : []),
      ],
      isError: true,
      details: {
        ...this.request.options.detailsBase,
        ...retained,
        error: isAbortError(error, this.callerSignal) ? "aborted" : "call_capture_failed",
        message,
        recovery: context,
      },
    };
  }
  private cancelled(
    message: string,
    details: Record<string, unknown>,
    isError = false,
  ): ProxyToolResult {
    this.uiSession?.sendToolCancelled(message);
    return {
      content: [{ type: "text", text: message }],
      ...(isError ? { isError: true } : {}),
      details: { ...this.request.options.detailsBase, ...details, message },
    };
  }
  private stderrTailForError(error: unknown): string {
    const { state, serverName } = this.request;
    return connectionStderrTail(
      this.activeConnection ?? state.manager.getConnection(serverName),
      error,
    );
  }
  private isRequestTimeout(error: unknown): boolean {
    if (this.callerSignal.aborted) {
      return false;
    }
    const { sdk } = this.deps;
    return sdk.SdkError.isInstance(error) && error.code === sdk.SdkErrorCode.RequestTimeout;
  }
  private async failure(error: unknown): Promise<ProxyToolResult> {
    const { serverName, target, options } = this.request;
    const { recovery, sdk } = this.deps;
    if (this.captureFailure) {
      return this.captureFailureResult(error, this.captureFailure);
    }
    if (recovery.isToolTransportFailure(error) || recovery.isInterruptedToolCall(error)) {
      const stderrTail = this.stderrTailForError(error);
      const cause = error instanceof Error ? error.cause : undefined;
      const baseMessage = this.isRequestTimeout(cause)
        ? formatInterruptedTimeoutMessage(
            serverName,
            target.originalName,
            this.effectiveTimeoutMs(),
          )
        : `The outcome of MCP tool "${target.originalName}" on "${serverName}" is unknown after the call was interrupted. Read back the original operation using its saved arguments and provider identity before continuing. Do not blindly repeat the call.`;
      const message =
        stderrTail.length > 0
          ? `${baseMessage}\n\nRecent server stderr:\n${stderrTail}`
          : baseMessage;
      return this.cancelled(
        message,
        {
          error: "ambiguous_outcome",
          recovery: { ...this.identity, action: "readback" },
          ...(stderrTail.length > 0 ? { stderr: stderrTail } : {}),
        },
        true,
      );
    }
    if (error instanceof recovery.SessionRecoveryAuthRequiredError) {
      return this.cancelled(error.authMessage ?? options.authRequiredMessage(), {
        error: "auth_required",
        autoAuthAttempted: options.autoAuthAttempted(),
      });
    }
    if (error instanceof sdk.UrlElicitationRequiredError) {
      return this.urlElicitationFailure(error);
    }
    return this.genericFailure(error);
  }
  private async urlElicitationFailure(
    error: InstanceType<RuntimeDependencies["sdk"]["UrlElicitationRequiredError"]>,
  ): Promise<ProxyToolResult> {
    const { state, serverName, options } = this.request;
    const action = await state.manager.handleUrlElicitationRequired(serverName, error);
    const message =
      action === "accept"
        ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
        : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
    this.uiSession?.sendToolCancelled(message);
    return {
      content: [{ type: "text", text: message }],
      details: { ...options.detailsBase, error: "url_elicitation_required", action },
    };
  }
  private async genericFailure(error: unknown): Promise<ProxyToolResult> {
    const { sdk } = this.deps;
    const timedOut = this.isRequestTimeout(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const baseMessage = timedOut
      ? formatTimeoutMessage(
          this.request.serverName,
          this.request.target,
          this.effectiveTimeoutMs(),
        )
      : rawMessage;
    const stderrTail = this.stderrTailForError(error);
    const message =
      stderrTail.length > 0 && !baseMessage.includes(stderrTail)
        ? `${baseMessage}\n\nRecent server stderr:\n${stderrTail}`
        : baseMessage;
    const invalidParamsCode: number = sdk.ProtocolErrorCode.InvalidParams;
    const suffix =
      !timedOut && error instanceof sdk.ProtocolError && error.code === invalidParamsCode
        ? inputValidationHint(this.request.target.inputSchema, message)
        : "";
    this.uiSession?.sendToolCancelled(message);
    const guarded = await guardMcpOutput([{ type: "text", text: message }], {
      ...this.outputGuardOptions,
      prefix: "Failed to call tool: ",
      suffix,
    });
    return {
      content: guarded.content,
      isError: true,
      details: {
        ...this.request.options.detailsBase,
        error: !timedOut && isAbortError(error, this.callerSignal) ? "aborted" : "call_failed",
        message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
        ...(stderrTail.length > 0 ? { stderr: stderrTail } : {}),
        ...guardedMcpDetails(guarded),
      },
    };
  }
}
