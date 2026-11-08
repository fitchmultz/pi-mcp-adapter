import type { Client, RequestOptions } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { ProxyToolResult } from "./proxy-result.ts";
import type {
  ToolMetadata,
  McpOperationContext,
  McpToolCallEvent,
  McpToolCallIdentity,
} from "./types.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import type { UiSessionRuntime } from "./ui-session.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { formatSchema } from "./tool-metadata.ts";
import {
  guardMcpOutput,
  guardedMcpDetails,
  retainMcpResult,
  resolveMcpOutputGuardOptions,
  formatMcpResultReference,
} from "./mcp-output-guard.ts";
import { toolCallResult } from "./proxy-call-result.ts";
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
  recoverAuthConnection: NonNullable<SessionRecoveryDeps["onNeedsAuth"]>;
  authRequiredMessage: () => string;
  autoAuthAttempted: () => boolean;
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
  private beforeDispatchPending = false;
  private captureFailure: McpToolCallEvent | undefined;
  private readonly configuredOptions: RequestOptions | undefined;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly outputGuardOptions: ReturnType<typeof resolveMcpOutputGuardOptions>;
  private readonly identity: McpToolCallIdentity & { server: string; tool: string };
  private readonly request: CallRequest;
  private readonly deps: RuntimeDependencies;
  constructor(request: CallRequest, deps: RuntimeDependencies) {
    this.request = request;
    this.deps = deps;

    const { state, serverName, target, options } = request;
    this.configuredOptions = state.manager.getRequestOptions(serverName, options.ownedSignal);
    this.callerSignal = combineAbortSignals(this.configuredOptions?.signal, options.ownedSignal);
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
  private schemaSuffix(): string {
    const { target } = this.request;
    return target.inputSchema
      ? `\n\nExpected parameters:\n${formatSchema(target.inputSchema)}`
      : "";
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
      target.uiResourceUri.length > 0
    ) {
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
  private async dispatch(
    operation: Omit<McpOperationContext, "annotationsTrusted">,
  ): Promise<Record<string, unknown>> {
    const { state, serverName, target, args, options } = this.request;
    // Approval and UI preparation do not consume the service deadline.
    const deadline = AbortSignal.timeout(
      Math.ceil(this.configuredOptions?.timeout ?? this.deps.sdk.DEFAULT_REQUEST_TIMEOUT_MSEC),
    );
    const signal = combineAbortSignals(this.callerSignal, deadline) ?? deadline;
    const requestOptions = { ...this.configuredOptions, signal };
    const recovery = {
      manager: state.manager,
      config: state.config,
      signal,
      onNeedsAuth: options.recoverAuthConnection,
    };
    const call = { ...operation, signal };
    const resourceUri = target.resourceUri;
    if (resourceUri !== undefined && resourceUri.length > 0) {
      return this.captureDispatch(call, () =>
        this.deps.recovery.withSessionRecovery(recovery, serverName, (connection) =>
          abortable(connection.client.readResource({ uri: resourceUri }, requestOptions), signal),
        ),
      );
    }
    const result = await this.captureDispatch(call, () =>
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
            (connection) =>
              abortable(
                connection.client.callTool(
                  {
                    name: target.originalName,
                    arguments: args ?? {},
                    _meta: this.uiSession?.requestMeta,
                  },
                  requestOptions,
                ),
                signal,
              ),
          ),
        signal,
      ),
    );
    this.uiSession?.sendToolResult(result);
    return result;
  }
  async run(): Promise<ProxyToolResult> {
    const { state, serverName, target, options } = this.request;
    try {
      state.manager.touch(serverName);
      state.manager.incrementInFlight(serverName);
      throwIfAborted(this.callerSignal);
      const operation = await this.prepareOperation();
      const result = await this.dispatch(operation);
      return await toolCallResult(result, {
        target,
        uiSummary:
          (target.uiResourceUri ?? "").length > 0
            ? this.deps.ui.summarizeUiSessionResult(this.uiSession)
            : undefined,
        detailsBase: options.detailsBase,
        outputGuardOptions: this.outputGuardOptions,
        schemaSuffix: () => this.schemaSuffix(),
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
      state.manager.decrementInFlight(serverName);
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
  private async failure(error: unknown): Promise<ProxyToolResult> {
    const { serverName, target, options } = this.request;
    const { recovery, sdk } = this.deps;
    if (this.captureFailure) {
      return this.captureFailureResult(error, this.captureFailure);
    }
    if (recovery.isToolTransportFailure(error) || recovery.isInterruptedToolCall(error)) {
      const message = `The outcome of MCP tool "${target.originalName}" on "${serverName}" is unknown after the call was interrupted. Read back the original operation using its saved arguments and provider identity before continuing. Do not blindly repeat the call.`;
      return this.cancelled(
        message,
        { error: "ambiguous_outcome", recovery: { ...this.identity, action: "readback" } },
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
    const message = error instanceof Error ? error.message : String(error);
    this.uiSession?.sendToolCancelled(message);
    const guarded = await guardMcpOutput([{ type: "text", text: message }], {
      ...this.outputGuardOptions,
      prefix: "Failed to call tool: ",
      suffix: this.schemaSuffix(),
    });
    return {
      content: guarded.content,
      isError: true,
      details: {
        ...this.request.options.detailsBase,
        error: isAbortError(error, this.callerSignal) ? "aborted" : "call_failed",
        message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
        ...guardedMcpDetails(guarded),
      },
    };
  }
}
