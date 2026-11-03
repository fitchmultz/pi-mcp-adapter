import type { ServerResponse } from "node:http";
import type { CallToolRequest } from "@modelcontextprotocol/client";
import type { ServerConnection } from "./server-manager.ts";
import type { UiServerOptions } from "./ui-server-options.ts";
import { withSessionRecovery } from "./session-recovery.ts";
import {
  ensureToolCallApproved,
  isToolCallApprovalRequired,
  type ToolCallApprovalResult,
} from "./tool-approval.ts";
import {
  extractUiToolVisibility,
  isUiToolCallableByApp,
  type UiToolVisibility,
} from "./ui-tool-visibility.ts";
import {
  isServerDisabled,
  isToolAllowed,
  resolveToolPrefix,
  type ToolMetadata,
  type McpTool,
} from "./types.ts";
import { isUiJsonObject } from "./ui-json.ts";
import { sendJson } from "./ui-http.ts";

type UiToolCall = Pick<CallToolRequest["params"], "name"> & {
  arguments: NonNullable<CallToolRequest["params"]["arguments"]>;
};

/** App-originated tool calls retain consent, visibility, approval and native recovery. */
export class UiToolProxy {
  private readonly options: UiServerOptions;

  constructor(options: UiServerOptions) {
    this.options = options;
  }

  async call(params: unknown, res: ServerResponse): Promise<void> {
    const options = this.options;
    options.consentManager.ensureApproved(options.serverName);
    const args = parseToolCall(params);
    if (!args) {
      sendJson(res, 400, { ok: false, error: "Invalid tools/call params" });
      return;
    }
    const connection = this.connection(res);
    if (!connection) {
      return;
    }
    const meta = this.toolMeta(connection, args.name);
    if (!meta) {
      sendJson(res, 403, { ok: false, error: `MCP tool "${args.name}" is not callable by apps` });
      return;
    }
    const approval = await this.approve(meta, args.arguments);
    if (!approval.ok) {
      this.sendApprovalFailure(res, args.name, approval.reason);
      return;
    }
    await this.execute(connection, args, res);
  }

  private connection(res: ServerResponse): ServerConnection | undefined {
    const options = this.options;
    const connection = options.manager.getConnection(options.serverName);
    if (!connection || connection.status !== "connected") {
      sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is not connected` });
      return undefined;
    }
    if (
      isServerDisabled(options.config?.mcpServers[options.serverName]) ||
      isServerDisabled(connection.definition)
    ) {
      sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is disabled` });
      return undefined;
    }
    return connection;
  }

  private toolMeta(connection: ServerConnection, name: string): ToolMetadata | undefined {
    const options = this.options;
    const definition = options.config?.mcpServers[options.serverName] ?? connection.definition;
    const tool = connection.tools.find((entry) => entry.name === name);
    if (
      !tool ||
      !isToolAllowed(
        name,
        options.serverName,
        resolveToolPrefix(definition, options.config?.settings?.toolPrefix),
        definition.includeTools,
        definition.excludeTools,
      )
    ) {
      return undefined;
    }
    const uiVisibility = extractUiToolVisibility(tool._meta);
    if (!isUiToolCallableByApp(uiVisibility)) {
      return undefined;
    }
    return toToolMetadata(tool, uiVisibility);
  }

  private async approve(
    meta: ToolMetadata,
    args: UiToolCall["arguments"],
  ): Promise<ToolCallApprovalResult> {
    const options = this.options;
    if (options.state) {
      return ensureToolCallApproved(
        options.state,
        options.serverName,
        meta,
        args,
        options.state.owner.signal,
      );
    }
    if (options.config && isToolCallApprovalRequired(options.config, options.serverName, meta)) {
      return { ok: false, reason: "approval_required_headless" };
    }
    return { ok: true };
  }

  private sendApprovalFailure(
    res: ServerResponse,
    name: string,
    reason: "denied" | "approval_required_headless",
  ): void {
    const server = this.options.serverName;
    const denied = reason === "denied";
    const message = denied
      ? `The user declined approval to run MCP tool "${name}" on server "${server}".`
      : `MCP tool "${name}" on server "${server}" is approval-gated and requires an interactive session.`;
    sendJson(res, 200, {
      ok: true,
      result: {
        content: [{ type: "text", text: message }],
        details: { error: denied ? "approval_denied" : "approval_required", server, tool: name },
      },
    });
  }

  private async execute(
    connection: ServerConnection,
    args: UiToolCall,
    res: ServerResponse,
  ): Promise<void> {
    const options = this.options;
    try {
      options.manager.touch(options.serverName);
      options.manager.incrementInFlight(options.serverName);
      const result = options.config
        ? await withSessionRecovery(
            {
              manager: options.manager,
              config: options.config,
              ...(options.onNeedsAuth ? { onNeedsAuth: options.onNeedsAuth } : {}),
            },
            options.serverName,
            (conn) =>
              conn.client.callTool(args, options.manager.getRequestOptions(options.serverName)),
          )
        : await connection.client.callTool(
            args,
            options.manager.getRequestOptions(options.serverName),
          );
      sendJson(res, 200, { ok: true, result });
    } finally {
      options.manager.decrementInFlight(options.serverName);
      options.manager.touch(options.serverName);
    }
  }
}

function toToolMetadata(tool: McpTool, uiVisibility: UiToolVisibility[] | undefined): ToolMetadata {
  return {
    name: tool.name,
    originalName: tool.name,
    description: tool.description ?? "",
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(uiVisibility !== undefined ? { uiVisibility } : {}),
  };
}

function parseToolCall(params: unknown): UiToolCall | undefined {
  if (!isUiJsonObject(params) || typeof params.name !== "string" || params.name.trim() === "") {
    return undefined;
  }
  return { name: params.name, arguments: isUiJsonObject(params.arguments) ? params.arguments : {} };
}
