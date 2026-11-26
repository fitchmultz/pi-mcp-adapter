import { statSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Transport, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/client";
import type { McpTraceSettings, ServerEntry } from "./config-types.ts";
import { hasServerUrl } from "./utils.ts";
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
  truncateOnInit?: boolean;
  appendFile?: (path: string, data: string, options: { encoding: "utf8" }) => Promise<void>;
  writeFile?: (
    path: string,
    data: string,
    options: { encoding: "utf8"; flag?: string },
  ) => Promise<void>;
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
  /** Why tracing stopped, or undefined while it still records. */
  private stopReason: "initialization" | "serialization" | "budget" | "append" | undefined;
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
    if (options.truncateOnInit !== true && options.appendFile === undefined) {
      try {
        this.bytesWritten = statSync(this.options.filePath).size;
      } catch {
        this.bytesWritten = 0;
      }
    }
    this.fileReady = this.ensureFileReady();
  }

  private async ensureFileReady(): Promise<void> {
    try {
      await this.makeDirectory(dirname(this.options.filePath), { recursive: true });
      if (this.options.truncateOnInit === true) {
        await this.resetFile(this.options.filePath, "", { encoding: "utf8" });
        return;
      }
      await this.resetFile(this.options.filePath, "", { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        Object.getOwnPropertyDescriptor(error, "code")?.value === "EEXIST"
      ) {
        return;
      }
      // Tracing must never change MCP request/response behavior.
      this.persistenceError = error;
      this.stopReason = "initialization";
    }
  }

  get filePath(): string {
    return this.options.filePath;
  }

  get isDisabled(): boolean {
    return this.stopReason !== undefined;
  }

  get stats(): { bytes: number; events: number } {
    return { bytes: this.bytesWritten, events: this.eventsWritten };
  }

  write(event: McpTraceEvent): void {
    if (this.isDisabled || this.eventsWritten >= this.maxEvents) {
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.stopReason = "serialization";
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxBytes - this.bytesWritten) {
      this.stopReason = "budget";
      return;
    }

    this.bytesWritten += bytes;
    this.eventsWritten += 1;
    this.queue = this.queue
      .then(async () => {
        await this.fileReady;
        if (this.stopReason === "initialization") {
          return;
        }
        await this.append(this.options.filePath, line, { encoding: "utf8" });
        return;
      })
      .catch((error: unknown) => {
        // Tracing must never change MCP request/response behavior.
        this.persistenceError ??= error;
        this.stopReason = "append";
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
  randomSuffix = randomBytes(4).toString("hex"),
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

const MAX_PENDING_TRACE_REQUESTS = 1024;

function rawRequestId(message: JSONRPCMessage): string | number | undefined {
  if (!("id" in message)) {
    return undefined;
  }
  const { id } = message;
  if (typeof id === "string") {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return id;
  }
  return undefined;
}

function trackPendingRequest(
  pending: Map<string | number, number>,
  message: JSONRPCMessage,
  startedAt: number,
): string | number | undefined {
  if (messageKind(message) !== "request") {
    return undefined;
  }
  const id = rawRequestId(message);
  if (id === undefined) {
    return undefined;
  }
  if (!pending.has(id) && pending.size >= MAX_PENDING_TRACE_REQUESTS) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) {
      pending.delete(oldest);
    }
  }
  pending.set(id, startedAt);
  return id;
}

function consumePendingDuration(
  pending: Map<string | number, number>,
  message: JSONRPCMessage,
  now: number,
): number | undefined {
  if (messageKind(message) !== "response") {
    return undefined;
  }
  const id = rawRequestId(message);
  if (id === undefined) {
    return undefined;
  }
  const startedAt = pending.get(id);
  if (startedAt === undefined) {
    return undefined;
  }
  pending.delete(id);
  return now - startedAt;
}

function wrapTransportSend(input: {
  send: Transport["send"];
  server: string;
  transportKind: McpTraceTransport;
  outboundPending: Map<string | number, number>;
  inboundPending: Map<string | number, number>;
  record: (event: McpTraceEvent) => void;
}): Transport["send"] {
  const { send, server, transportKind, outboundPending, inboundPending, record } = input;
  return async (message, options) => {
    const started = performance.now();
    const messages: JSONRPCMessage[] = Array.isArray(message) ? message : [message];
    const trackedIds = messages.map((item) => trackPendingRequest(outboundPending, item, started));
    const related =
      options?.relatedRequestId !== undefined ? { relatedRequestId: options.relatedRequestId } : {};
    try {
      await send(message, options);
      const sentAt = performance.now();
      for (const item of messages) {
        const durationMs = consumePendingDuration(inboundPending, item, sentAt);
        record(
          createMcpTraceEvent({
            direction: "outbound",
            server,
            transport: transportKind,
            message: item,
            status: "sent",
            ...related,
            ...(durationMs !== undefined ? { durationMs } : {}),
          }),
        );
      }
    } catch (error) {
      for (const id of trackedIds) {
        if (id !== undefined) {
          outboundPending.delete(id);
        }
      }
      const failedDuration = performance.now() - started;
      for (const item of messages) {
        record(
          createMcpTraceEvent({
            direction: "outbound",
            server,
            transport: transportKind,
            message: item,
            status: "error",
            ...related,
            durationMs: failedDuration,
          }),
        );
      }
      throw error;
    }
  };
}

function extractExtraRelatedRequestId(extra: MessageExtraInfo | undefined): unknown {
  if (!extra) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(extra, "relatedRequestId")?.value;
}

function wrapTransportMessageHandler(input: {
  handler: NonNullable<Transport["onmessage"]>;
  server: string;
  transportKind: McpTraceTransport;
  outboundPending: Map<string | number, number>;
  inboundPending: Map<string | number, number>;
  record: (event: McpTraceEvent) => void;
}): NonNullable<Transport["onmessage"]> {
  const { handler, server, transportKind, outboundPending, inboundPending, record } = input;
  return (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    const receivedAt = performance.now();
    trackPendingRequest(inboundPending, message, receivedAt);
    const durationMs = consumePendingDuration(outboundPending, message, receivedAt);
    const relatedRequestId = extractExtraRelatedRequestId(extra);
    const status = messageKind(message) === "response" && "error" in message ? "error" : "received";
    record(
      createMcpTraceEvent({
        direction: "inbound",
        server,
        transport: transportKind,
        message,
        status,
        ...(relatedRequestId !== undefined ? { relatedRequestId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }),
    );
    handler(message, extra);
  };
}

function createTransportTraceContext(
  observer: McpTraceObserver,
  server: string,
  transportKind: McpTraceTransport,
): {
  server: string;
  transportKind: McpTraceTransport;
  outboundPending: Map<string | number, number>;
  inboundPending: Map<string | number, number>;
  record: (event: McpTraceEvent) => void;
} {
  return {
    server,
    transportKind,
    outboundPending: new Map<string | number, number>(),
    inboundPending: new Map<string | number, number>(),
    record: (event: McpTraceEvent): void => {
      try {
        observer.record(event);
      } catch {
        // An observer failure must never alter SDK transport behavior.
      }
    },
  };
}

/**
 * Compose the SDK's transport callbacks instead of replacing them. Protocol
 * assigns `onmessage` during connect, so the setter must keep the observer in
 * front of whichever callback the SDK installs. Third layer of transport-callback
 * patching, after connection-http and tool-transport, before connection-handshake;
 * every wrapper calls the previous handler and none are restored.
 */
export function wrapTransportWithMcpTrace(
  transport: Transport,
  server: string,
  transportKind: McpTraceTransport,
  observer: McpTraceObserver,
): Transport {
  let messageHandler = transport.onmessage;
  const traceContext = createTransportTraceContext(observer, server, transportKind);
  // The SDK requires the native stdio prototype for sibling probing and reads
  // HTTP hasPerRequestStream for cancellation. Compose callbacks in place.
  const send = transport.send.bind(transport);
  // oxlint-disable-next-line eslint/no-param-reassign -- QX-001: SDK invokes this member on the instance it holds.
  transport.send = wrapTransportSend({
    send,
    ...traceContext,
  });
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => messageHandler,
    set: (handler: Transport["onmessage"]) => {
      messageHandler = handler
        ? wrapTransportMessageHandler({
            handler,
            ...traceContext,
          })
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
  return hasServerUrl(definition) ? "streamable-http" : "unknown";
}
