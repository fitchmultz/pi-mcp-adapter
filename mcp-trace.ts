import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Transport, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/client";
import type { McpTraceSettings, ServerEntry } from "./config-types.ts";
export type { McpTraceSettings } from "./config-types.ts";

export const MCP_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_MCP_TRACE_MAX_BYTES = 256 * 1024;
export const DEFAULT_MCP_TRACE_MAX_EVENTS = 10_000;

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

export interface McpTraceWriterOptions {
  filePath: string;
  maxBytes?: number;
  maxEvents?: number;
  appendFile?: (path: string, data: string, options: { encoding: "utf8" }) => Promise<void>;
  writeFile?: (path: string, data: string, options: { encoding: "utf8" }) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true }) => Promise<string | undefined>;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
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

function messageKind(message: JSONRPCMessage): McpTraceMessageKind {
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
    return "[REDACTED_ID]";
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

export interface McpTraceEventRequest {
  direction: McpTraceDirection;
  server: string;
  transport: McpTraceTransport;
  message: JSONRPCMessage;
  status: "sent" | "received" | "error";
  relatedRequestId?: unknown;
  durationMs?: number;
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

export class McpTraceWriter {
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly append: NonNullable<McpTraceWriterOptions["appendFile"]>;
  private readonly resetFile: NonNullable<McpTraceWriterOptions["writeFile"]>;
  private readonly makeDirectory: NonNullable<McpTraceWriterOptions["mkdir"]>;
  private bytesWritten = 0;
  private eventsWritten = 0;
  private queue = Promise.resolve();
  private disabled = false;
  private initializationFailed = false;
  private persistenceError: unknown;
  private readonly fileReady: Promise<void>;

  private readonly options: McpTraceWriterOptions;

  constructor(options: McpTraceWriterOptions) {
    this.options = options;
    this.maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MCP_TRACE_MAX_BYTES);
    this.maxEvents = boundedPositiveInteger(options.maxEvents, DEFAULT_MCP_TRACE_MAX_EVENTS);
    this.append = options.appendFile ?? appendFile;
    this.resetFile = options.writeFile ?? writeFile;
    this.makeDirectory = options.mkdir ?? mkdir;
    this.fileReady = this.makeDirectory(dirname(this.options.filePath), { recursive: true })
      .then(() => this.resetFile(this.options.filePath, "", { encoding: "utf8" }))
      .catch((error: unknown) => {
        // Tracing must never change MCP request/response behavior.
        this.persistenceError = error;
        this.initializationFailed = true;
        this.disabled = true;
      });
  }

  get filePath(): string {
    return this.options.filePath;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get stats(): { bytes: number; events: number } {
    return { bytes: this.bytesWritten, events: this.eventsWritten };
  }

  write(event: McpTraceEvent): void {
    if (this.disabled || this.eventsWritten >= this.maxEvents) {
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.disabled = true;
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxBytes - this.bytesWritten) {
      this.disabled = true;
      return;
    }

    this.bytesWritten += bytes;
    this.eventsWritten += 1;
    this.queue = this.queue
      .then(async () => {
        await this.fileReady;
        if (this.initializationFailed) {
          return;
        }
        await this.append(this.options.filePath, line, { encoding: "utf8" });
        return;
      })
      .catch((error: unknown) => {
        // Tracing must never change MCP request/response behavior.
        this.persistenceError ??= error;
        this.disabled = true;
      });
  }

  async flush(strict = false): Promise<void> {
    await this.fileReady;
    await this.queue;
    if (strict && this.persistenceError !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- QX-009: preserve the recorded persistence failure.
      throw this.persistenceError;
    }
  }
}

export function createMcpTraceWriter(
  sessionCwd: string | undefined,
  settings: McpTraceSettings = {},
  randomSuffix = Math.random().toString(36).slice(2, 10),
): McpTraceWriter {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const configuredPath = settings.file;
  let filePath: string;
  if (typeof configuredPath === "string" && configuredPath !== "") {
    filePath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(sessionCwd ?? process.cwd(), configuredPath);
  } else {
    filePath = resolve(
      sessionCwd ?? process.cwd(),
      ".pi",
      "fitch-mcp-adapter",
      "traces",
      `mcp-${timestamp}-${randomSuffix}.jsonl`,
    );
  }
  return new McpTraceWriter({
    filePath,
    ...(settings.maxBytes !== undefined ? { maxBytes: settings.maxBytes } : {}),
    ...(settings.maxEvents !== undefined ? { maxEvents: settings.maxEvents } : {}),
  });
}

export interface McpTraceObserver {
  record: (event: McpTraceEvent) => void;
}

export function isMcpTraceEnabled(
  definition: { trace?: boolean },
  settings?: McpTraceSettings,
): boolean {
  return definition.trace ?? settings?.enabled === true;
}

/**
 * Compose the SDK's transport callbacks instead of replacing them. Protocol
 * assigns `onmessage` during connect, so the setter must keep the observer in
 * front of whichever callback the SDK installs.
 */
export function wrapTransportWithMcpTrace(
  transport: Transport,
  server: string,
  transportKind: McpTraceTransport,
  observer: McpTraceObserver,
): Transport {
  let messageHandler = transport.onmessage;
  const record = (event: McpTraceEvent): void => {
    try {
      observer.record(event);
    } catch {
      // An observer failure must never alter SDK transport behavior.
    }
  };
  // The SDK requires the native stdio prototype for sibling probing and reads
  // HTTP hasPerRequestStream for cancellation. Compose callbacks in place.
  const send = transport.send.bind(transport);
  // oxlint-disable-next-line eslint/no-param-reassign -- QX-001: SDK invokes this member on the instance it holds.
  transport.send = async (message, options) => {
    const started = performance.now();
    const messages: JSONRPCMessage[] = Array.isArray(message) ? message : [message];
    try {
      await send(message, options);
      for (const item of messages) {
        record(
          createMcpTraceEvent({
            direction: "outbound",
            server,
            transport: transportKind,
            message: item,
            status: "sent",
            durationMs: performance.now() - started,
          }),
        );
      }
    } catch (error) {
      for (const item of messages) {
        record(
          createMcpTraceEvent({
            direction: "outbound",
            server,
            transport: transportKind,
            message: item,
            status: "error",
            durationMs: performance.now() - started,
          }),
        );
      }
      throw error;
    }
  };
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => messageHandler,
    set: (handler: Transport["onmessage"]) => {
      messageHandler = handler
        ? (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
            record(
              createMcpTraceEvent({
                direction: "inbound",
                server,
                transport: transportKind,
                message,
                status: "received",
              }),
            );
            handler(message, extra);
          }
        : undefined;
    },
  });
  return transport;
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
  return typeof definition.url === "string" && definition.url !== ""
    ? "streamable-http"
    : "unknown";
}
