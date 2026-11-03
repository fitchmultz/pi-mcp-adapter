import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  formatMcpPayloadFile,
  readMcpResult,
  resolveMcpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import type { createMcpOutputSpool } from "./mcp-output-preview.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";
import { executeCall, executeConnect } from "./proxy-modes.ts";
import { executeResourceList, executeResourceRead } from "./resource-tools.ts";
import { paginate, rankSuggestions, rankToolMatches } from "./search-ranking.ts";
import type { McpExtensionState } from "./state.ts";
import { catalogCoverage, toToolDescriptor } from "./tool-metadata.ts";
import { isServerDisabled, type ContentBlock } from "./types.ts";
import type { ScriptRequest } from "./mcp-script-protocol.ts";

type Outcome = { ok: true } | { ok: false; error: string };
type CallOutcome = { ok: true } | { ok: false; error: string; recovery?: unknown };
export type ScriptOperation = (
  | ({ operation: "call"; path: string } & CallOutcome)
  | (({ operation: "describe"; path: string } | { operation: "search"; query: string }) & Outcome)
) & { durationMs: number };
type TrackedOperation = ScriptOperation & { startedAt: number };
export type ScriptDispatchOptions = {
  state: McpExtensionState;
  getPiTools: (() => ToolInfo[]) | undefined;
  signal: AbortSignal | undefined;
  toolCallId: string | undefined;
  beforeDispatch: Parameters<typeof executeCall>[1]["beforeDispatch"];
};
export class McpScriptCaptureError extends Error {
  readonly recovery: unknown;
  constructor(recovery: unknown, message: string) {
    super(message);
    this.recovery = recovery;
  }
}
const payloadSchema = Type.Object({
  index: Type.Number(),
  kind: Type.Union([Type.Literal("audio"), Type.Literal("resource")]),
  uri: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
function textFromContent(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
function callErrorMessage(path: string, result: Awaited<ReturnType<typeof executeCall>>): string {
  const { details } = result;
  if (details.error === "tool_not_found") {
    const suggestions = isUnknownArray(details.suggestions)
      ? details.suggestions.filter(
          (suggestion): suggestion is string => typeof suggestion === "string",
        )
      : [];
    return `Tool "${path}" not found. Use await tools.search({ query: "..." }) inside mcp_script.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : ""}`;
  }
  return typeof details.message === "string" ? details.message : textFromContent(result.content);
}

export class ScriptOperations {
  readonly resultRefs = new Set<string>();
  readonly payloadNotices = new Set<string>();
  private readonly calls: TrackedOperation[] = [];
  private readonly options: ScriptDispatchOptions;
  private readonly output: ReturnType<typeof createMcpOutputSpool>;
  constructor(options: ScriptDispatchOptions, output: ReturnType<typeof createMcpOutputSpool>) {
    this.options = options;
    this.output = output;
  }

  snapshot(): ScriptOperation[] {
    return this.calls.map(({ startedAt, ...operation }) =>
      Object.assign(operation, {
        durationMs:
          "error" in operation && operation.error === "incomplete"
            ? Math.max(0, Date.now() - startedAt)
            : operation.durationMs,
      }),
    );
  }

  private retainNotices(details: Record<string, unknown>): void {
    if (typeof details.resultRef === "string") {
      this.resultRefs.add(details.resultRef);
    }
    if (typeof details.resultWriteError === "string") {
      this.payloadNotices.add(`[MCP result could not be saved: ${details.resultWriteError}]`);
    }
    if (isUnknownArray(details.payloadFiles)) {
      for (const value of details.payloadFiles) {
        if (Value.Check(payloadSchema, value)) {
          this.payloadNotices.add(formatMcpPayloadFile(value));
        }
      }
    }
  }

  private failedCall(
    path: string,
    result: Awaited<ReturnType<typeof executeCall>>,
    errorCode: string,
  ): unknown {
    const { details } = result;
    const hasReference = Boolean(details.resultRef);
    const hasRecovery = Boolean(details.recovery);
    const message = callErrorMessage(path, result);
    if (errorCode === "call_capture_failed") {
      throw new McpScriptCaptureError(details.recovery, message);
    }
    if (details.recovery !== undefined) {
      this.output.push({ type: "text", text: message });
    }
    return {
      ok: false,
      ...(details.mcpResult !== undefined ? { data: details.mcpResult } : {}),
      ...(hasReference ? { resultRef: details.resultRef } : {}),
      error: {
        code: errorCode,
        message,
        ...(hasRecovery ? { recovery: details.recovery } : {}),
      },
    };
  }

  private async recordCall(
    path: string,
    dispatch: () => ReturnType<typeof executeCall>,
  ): Promise<unknown> {
    // Record before dispatch so calls still in flight at timeout/abort appear in the trace.
    const startedAt = Date.now();
    const index =
      this.calls.push({
        operation: "call",
        path,
        ok: false,
        error: "incomplete",
        durationMs: 0,
        startedAt,
      }) - 1;
    const result = await dispatch();
    const { details } = result;
    this.retainNotices(details);
    const timing = { durationMs: Date.now() - startedAt, startedAt };
    const errorCode = String(details.error);
    if (details.error !== undefined) {
      this.calls[index] = {
        operation: "call",
        path,
        ok: false,
        error: errorCode,
        ...timing,
        ...(details.recovery !== undefined ? { recovery: details.recovery } : {}),
      };
      return this.failedCall(path, result, errorCode);
    }
    this.calls[index] = { operation: "call", path, ok: true, ...timing };
    const hasReference = Boolean(details.resultRef);
    return {
      ok: true,
      data: details.mcpResult !== undefined ? details.mcpResult : textFromContent(result.content),
      ...(hasReference ? { resultRef: details.resultRef } : {}),
    };
  }

  private callIdentity(innerCallId: number): { toolCallId?: string; innerCallId: number } {
    return {
      ...(this.options.toolCallId !== undefined ? { toolCallId: this.options.toolCallId } : {}),
      innerCallId,
    };
  }

  private callTool(message: Extract<ScriptRequest, { type: "call" }>): Promise<unknown> {
    return this.recordCall(message.path, () => {
      const args = asObjectRecord(message.args);
      if (message.args !== undefined && (args === undefined || Array.isArray(message.args))) {
        return Promise.resolve({
          content: [{ type: "text", text: "Tool arguments must be an object." }],
          details: { mode: "call", error: "invalid_arguments", requestedTool: message.path },
        });
      }
      const { state, getPiTools, signal, beforeDispatch } = this.options;
      return executeCall(state, {
        toolName: message.path,
        args,
        serverOverride: message.server,
        getPiTools,
        signal,
        identity: this.callIdentity(message.id),
        beforeDispatch,
        options: { raw: true },
      });
    });
  }

  private async discoverServer(
    server?: string,
  ): Promise<{ code: unknown; message: string } | undefined> {
    if (server === undefined || server === "") {
      return;
    }
    const { state, signal } = this.options;
    if (isServerDisabled(state.config.mcpServers[server])) {
      return { code: "server_disabled", message: `Server "${server}" is disabled.` };
    }
    if (state.config.mcpServers[server] && state.toolMetadata.has(server)) {
      return;
    }
    const result = await executeConnect(state, { serverName: server, signal });
    const failed = Boolean(result.details.error);
    return failed
      ? { code: result.details.error, message: textFromContent(result.content) }
      : undefined;
  }

  private recordDiscovery(
    operation: "search" | "describe",
    value: string,
    startedAt: number,
    error: unknown,
  ): void {
    const identity =
      operation === "search" ? { operation, query: value } : { operation, path: value };
    const message = error instanceof Error ? error.message : String(error);
    const outcome: Outcome = error === undefined ? { ok: true } : { ok: false, error: message };
    this.calls.push({ ...identity, ...outcome, durationMs: Date.now() - startedAt, startedAt });
  }

  private async search(input: unknown): Promise<unknown> {
    const record = asObjectRecord(input);
    const startedAt = Date.now();
    const query = typeof record?.query === "string" ? record.query : "";
    let error: unknown;
    try {
      const server = typeof record?.server === "string" ? record.server : undefined;
      const discoveryError = await this.discoverServer(server);
      const coverage = catalogCoverage(this.options.state, server);
      if (discoveryError) {
        error = discoveryError.code;
        return { error: discoveryError, coverage };
      }
      return this.searchPage(record, query, server, coverage);
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      this.recordDiscovery("search", query, startedAt, error);
    }
  }

  private searchPage(
    record: Record<string, unknown> | undefined,
    query: string,
    server: string | undefined,
    coverage: ReturnType<typeof catalogCoverage>,
  ): unknown {
    if (query.trim() === "") {
      return { items: [], total: 0, hasMore: false, nextOffset: null, coverage };
    }
    const limit = typeof record?.limit === "number" ? record.limit : 12;
    const offset = typeof record?.offset === "number" ? record.offset : 0;
    const page = paginate(
      rankToolMatches(this.options.state, query, server).filter(
        (match) => match.tool.resourceUri === undefined || match.tool.resourceUri === "",
      ),
      offset,
      limit,
    );
    return Object.assign({}, page, {
      coverage,
      items: page.items.map(({ server: matchServer, tool, score }) => {
        const described = Boolean(tool.description);
        return Object.assign(
          { path: tool.name, name: tool.originalName, server: matchServer },
          described ? { description: tool.description } : {},
          { score },
        );
      }),
    });
  }

  private describeMatches(
    path: string,
    selectedServer: string | undefined,
  ): ReturnType<typeof toToolDescriptor>[] {
    const { state } = this.options;
    return [...state.toolMetadata].flatMap(([server, metadata]) => {
      if (
        (selectedServer !== undefined && selectedServer !== "" && server !== selectedServer) ||
        !state.config.mcpServers[server] ||
        isServerDisabled(state.config.mcpServers[server])
      ) {
        return [];
      }
      const tools = metadata.filter(
        (tool) => tool.resourceUri === undefined || tool.resourceUri === "",
      );
      const originals =
        selectedServer !== undefined && selectedServer !== ""
          ? tools.filter((tool) => tool.originalName === path)
          : [];
      return (originals.length > 0 ? originals : tools.filter((tool) => tool.name === path)).map(
        (tool) => toToolDescriptor(server, tool),
      );
    });
  }

  private async describe(input: unknown): Promise<unknown> {
    const record = asObjectRecord(input);
    const startedAt = Date.now();
    const path = typeof record?.path === "string" ? record.path : "";
    let error: unknown;
    try {
      const server = typeof record?.server === "string" ? record.server : undefined;
      const discoveryError = await this.discoverServer(server);
      if (discoveryError) {
        error = discoveryError.code;
        return { path, error: discoveryError };
      }
      const matches = this.describeMatches(path, server);
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        error = "ambiguous_tool";
        return { path, error: { code: error, message: "Specify server and exact tool name." } };
      }
      const suggestions = path !== "" ? rankSuggestions(this.options.state, path, 5, server) : [];
      error = "tool_not_found";
      return { path, error: { code: error, message: `Tool not found: ${path}`, suggestions } };
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      this.recordDiscovery("describe", path, startedAt, error);
    }
  }

  private readResult(input: unknown): Promise<unknown> {
    const { state } = this.options;
    const options = resolveMcpOutputGuardOptions(state.config.settings, state.outputDirectory);
    return readMcpResult(input, options);
  }

  private async resource(message: Exclude<ScriptRequest, { type: "call" }>): Promise<unknown> {
    const input = asObjectRecord(message.input);
    if (typeof input?.server !== "string" || input.server === "") {
      return {
        error: {
          code: "invalid_arguments",
          message: "Specify server and, for reads, resource uri.",
        },
      };
    }
    const { state, signal, beforeDispatch } = this.options;
    if (message.type === "resources") {
      const result = await executeResourceList(state, {
        server: input.server,
        limit: typeof input.limit === "number" ? input.limit : 12,
        offset: typeof input.offset === "number" ? input.offset : 0,
        signal,
      });
      const failed = Boolean(result.details.error);
      return failed
        ? { error: { code: result.details.error, message: textFromContent(result.content) } }
        : result.details;
    }
    const { server, uri } = input;
    if (typeof uri !== "string" || uri === "") {
      return {
        error: {
          code: "invalid_arguments",
          message: "Specify server and, for reads, resource uri.",
        },
      };
    }
    return this.recordCall(`${server}:${uri}`, () =>
      executeResourceRead(state, {
        server,
        uri,
        signal,
        identity: this.callIdentity(message.id),
        beforeDispatch,
        raw: true,
      }),
    );
  }

  dispatch(message: ScriptRequest): Promise<unknown> {
    switch (message.type) {
      case "call":
        return this.callTool(message);
      case "search":
        return this.search(message.input);
      case "describe":
        return this.describe(message.input);
      case "readResult":
        return this.readResult(message.input);
      case "resources":
      case "readResource":
        return this.resource(message);
    }
  }
}
