import {
  validateToolArguments,
  type JsonObject,
  type JsonValue,
  type Tool,
} from "@earendil-works/pi-ai";
import { asObjectRecord } from "./mcp-output-values.ts";
import { logger } from "./logger.ts";
import { expectedParametersHint } from "./proxy-call-result.ts";
import type { ProxyToolResult } from "./proxy-result.ts";
import type { ToolMetadata } from "./types.ts";

export type LocalValidationResult =
  | { readonly ok: true; readonly args: Record<string, unknown> | undefined }
  | { readonly ok: false; readonly message: string };

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      items.push(toJsonValue(item) ?? null);
    }
    return items;
  }
  const record = asObjectRecord(value);
  if (record !== undefined) {
    return toJsonObject(record);
  }
  return undefined;
}

function toJsonObject(record: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(record)) {
    const converted = toJsonValue(value);
    if (converted !== undefined) {
      Object.defineProperty(result, key, {
        value: converted,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}

function isValidationFailureMessage(message: string): boolean {
  return (
    message.startsWith("Validation failed for tool ") ||
    message.startsWith("Invalid arguments for tool ")
  );
}

function runPiValidation(tool: Tool, toolName: string, args: JsonObject): unknown {
  return validateToolArguments(tool, {
    type: "toolCall",
    id: "gateway-pre-dispatch",
    name: toolName,
    arguments: args,
  });
}

function resolveValidatedArgs(
  validated: unknown,
  originalArgs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const coerced = asObjectRecord(validated);
  if (coerced === undefined || Array.isArray(validated)) {
    return originalArgs;
  }
  return originalArgs === undefined && Object.keys(coerced).length === 0 ? undefined : coerced;
}

/**
 * Validate and coerce gateway `call` arguments locally using Pi's native `validateToolArguments`
 * (`@earendil-works/pi-schema` with `coerce: true` and WeakMap-memoized validators).
 */
export function validateGatewayCallArguments(
  toolName: string,
  inputSchema: ToolMetadata["inputSchema"],
  args: Record<string, unknown> | undefined,
): LocalValidationResult {
  const schemaRecord = asObjectRecord(inputSchema);
  if (!schemaRecord || Array.isArray(inputSchema)) {
    return { ok: true, args };
  }

  // pi-ai WeakMap-caches compiled validators by tool.parameters object identity.
  const tool: Tool = { name: toolName, description: "", parameters: schemaRecord };
  const input = args !== undefined ? toJsonObject(args) : {};

  try {
    return { ok: true, args: resolveValidatedArgs(runPiValidation(tool, toolName, input), args) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isValidationFailureMessage(message)) {
      return { ok: false, message };
    }
    // Broken or non-standard server schemas must not block a valid remote tool call.
    logger.debug(`MCP: skipped local argument validation for "${toolName}": ${message}`);
    return { ok: true, args };
  }
}

export function invalidCallRequest(
  toolName: unknown,
  serverOverride: unknown,
): ProxyToolResult | undefined {
  if (
    typeof toolName !== "string" ||
    toolName.trim().length === 0 ||
    (serverOverride !== undefined &&
      (typeof serverOverride !== "string" || serverOverride.length === 0))
  ) {
    return {
      content: [
        { type: "text", text: "Specify a non-empty tool name and, when supplied, server." },
      ],
      details: { mode: "call", error: "invalid_arguments" },
    };
  }
  return;
}

export function callPreparationError(
  error: ProxyToolResult,
  cachedTarget: ToolMetadata | undefined,
  toolName: string,
  resourceUri?: string,
): ProxyToolResult {
  let target: Record<string, unknown> =
    resourceUri !== undefined ? { resourceUri } : { requestedTool: toolName };
  if (cachedTarget) {
    target =
      (cachedTarget.resourceUri ?? "").length > 0
        ? { resourceUri: cachedTarget.resourceUri }
        : { tool: cachedTarget.originalName };
  }
  return { ...error, details: { ...error.details, ...target } };
}

export function serverNotFoundResult(serverName: string, requestedTool: string): ProxyToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Server "${serverName}" not found. Use mcp({ action: "status" }) to see available servers.`,
      },
    ],
    details: { mode: "call", error: "server_not_found", server: serverName, requestedTool },
  };
}

export function nativeToolCallResult(toolName: string): ProxyToolResult {
  return {
    content: [
      {
        type: "text",
        text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ action: "call", tool: "${toolName}" }).`,
      },
    ],
    details: { mode: "call", error: "native_tool", requestedTool: toolName },
  };
}

export function suggestedServerCallResult(options: {
  toolName: string;
  serverOverride: string | undefined;
  hintServer: string | undefined;
  suggestedServer: string;
  suggestions: string[];
}): ProxyToolResult {
  const { toolName, serverOverride, hintServer, suggestedServer, suggestions } = options;
  return {
    content: [
      {
        type: "text",
        text: `Tool ${JSON.stringify(toolName)} is on server ${JSON.stringify(suggestedServer)}, not ${JSON.stringify(serverOverride)}. Retry the same call with server: ${JSON.stringify(suggestedServer)} or omit server.`,
      },
    ],
    details: {
      mode: "call",
      error: "tool_not_found",
      requestedTool: toolName,
      hintServer,
      suggestedServer,
      suggestions,
    },
  };
}

export function approvalFailure(
  reason: string,
  serverName: string,
  toolMeta: ToolMetadata,
): ProxyToolResult {
  const denied = reason === "denied";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: denied
          ? `The user declined approval to run MCP tool "${toolMeta.originalName}" on server "${serverName}".`
          : `MCP tool "${toolMeta.originalName}" on server "${serverName}" is approval-gated and requires an interactive session.`,
      },
    ],
    details: {
      mode: "call",
      error: denied ? "approval_denied" : "approval_required",
      server: serverName,
      tool: toolMeta.originalName,
    },
  };
}

export function validateCallTargetArguments(
  serverName: string,
  target: ToolMetadata,
  args: Record<string, unknown> | undefined,
):
  | { readonly ok: true; readonly args: Record<string, unknown> | undefined }
  | { readonly ok: false; readonly error: ProxyToolResult } {
  if ((target.resourceUri ?? "").length > 0 || target.inputSchema === undefined) {
    return { ok: true, args };
  }
  const validation = validateGatewayCallArguments(target.originalName, target.inputSchema, args);
  if (validation.ok) {
    return validation;
  }
  return {
    ok: false,
    error: {
      content: [
        {
          type: "text",
          text: `${validation.message}${expectedParametersHint(target.inputSchema)}`,
        },
      ],
      isError: true,
      details: {
        mode: "call",
        error: "invalid_arguments",
        server: serverName,
        tool: target.originalName,
      },
    },
  };
}
