import { Buffer } from "node:buffer";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import type { McpTraceSettings, ServerEntry } from "./config-types.ts";
import { hasServerUrl } from "./utils.ts";

export const MCP_TRACE_SCHEMA_VERSION = 1;

export type McpTraceDirection = "outbound" | "inbound";
export type McpTraceTransport = "stdio" | "unix-socket" | "sse" | "streamable-http" | "unknown";
export type McpTraceMessageKind = "request" | "response" | "notification";

export interface McpTraceEvent {
  version: typeof MCP_TRACE_SCHEMA_VERSION;
  timestamp: string;
  direction: McpTraceDirection;
  server: string;
  transport: McpTraceTransport;
  kind: McpTraceMessageKind;
  status: "sent" | "received" | "error";
  method?: string;
  id?: string | number | null;
  relatedRequestId?: string | number;
  errorCode?: number | string;
  bytes?: number;
  durationMs?: number;
}

export interface McpTraceEventRequest {
  direction: McpTraceDirection;
  server: string;
  transport: McpTraceTransport;
  message: JSONRPCMessage;
  status: "sent" | "received" | "error";
  relatedRequestId?: unknown;
  durationMs?: number;
}

/** Redact strings before they can become durable trace metadata. */
export function redactTraceText(value: string, maxLength = 160): string {
  if (/\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\b/i.test(value)) {
    return "[REDACTED]";
  }
  let redacted = value
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
    .replace(
      /\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
  if (redacted.length > maxLength) {
    redacted = `${redacted.slice(0, maxLength - 1)}…`;
  }
  return redacted;
}

export function messageKind(message: JSONRPCMessage): McpTraceMessageKind {
  if ("method" in message) {
    return "id" in message ? "request" : "notification";
  }
  return "response";
}

function traceId(value: unknown): string | number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return redactTraceText(value, 160);
  }
  return undefined;
}

function messageBytes(message: JSONRPCMessage): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return undefined;
  }
}

function traceMessageMetadata(message: JSONRPCMessage): Pick<McpTraceEvent, "method" | "id"> {
  const fields: Pick<McpTraceEvent, "method" | "id"> = {};
  if ("method" in message) {
    fields.method = redactTraceText(message.method, 120);
  }
  if ("id" in message) {
    fields.id = traceId(message.id) ?? null;
  }
  return fields;
}

function traceOutcomeMetadata(
  request: McpTraceEventRequest,
): Pick<McpTraceEvent, "relatedRequestId" | "errorCode" | "durationMs"> {
  const fields: Pick<McpTraceEvent, "relatedRequestId" | "errorCode" | "durationMs"> = {};
  const relatedRequestId = traceId(request.relatedRequestId);
  if (relatedRequestId !== undefined && relatedRequestId !== null) {
    fields.relatedRequestId = relatedRequestId;
  }
  const wireError: unknown = "error" in request.message ? request.message.error : undefined;
  if (
    typeof wireError === "object" &&
    wireError !== null &&
    "code" in wireError &&
    typeof wireError.code === "number"
  ) {
    fields.errorCode = wireError.code;
  }
  if (request.durationMs !== undefined && Number.isFinite(request.durationMs)) {
    fields.durationMs = Math.max(0, Math.round(request.durationMs * 100) / 100);
  }
  return fields;
}

export function createMcpTraceEvent(request: McpTraceEventRequest): McpTraceEvent {
  const kind = messageKind(request.message);
  const bytes = messageBytes(request.message);
  return {
    version: MCP_TRACE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    direction: request.direction,
    server: redactTraceText(request.server, 120),
    transport: request.transport,
    kind,
    status: request.status,
    ...(bytes !== undefined ? { bytes } : {}),
    ...traceMessageMetadata(request.message),
    ...traceOutcomeMetadata(request),
  };
}

export function isMcpTraceEnabled(
  definition: { trace?: boolean },
  settings?: McpTraceSettings,
): boolean {
  return definition.trace ?? settings?.enabled === true;
}

export function traceTransportKind(
  definition: Pick<ServerEntry, "command" | "url" | "socket">,
  transport: Transport,
): McpTraceTransport {
  if (typeof definition.command === "string" && definition.command !== "") {
    return "stdio";
  }
  if (typeof definition.socket === "string" && definition.socket !== "") {
    return "unix-socket";
  }
  const constructorName = transport.constructor.name.toLowerCase();
  if (constructorName.includes("sse")) {
    return "sse";
  }
  if (constructorName.includes("streamable")) {
    return "streamable-http";
  }
  return hasServerUrl(definition) ? "streamable-http" : "unknown";
}
