/**
 * Log messages MCP servers send with `notifications/message`, appended to `mcp.log` in the agent
 * directory. Several processes may write to the same file, so every message is one synchronous
 * append. The file rotates to `mcp.log.1` once it grows past `MAX_MCP_LOG_BYTES`.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";
import { getAgentPath } from "./agent-dir.ts";

export const MAX_MCP_LOG_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data === undefined || data === null) {
    return String(data);
  }
  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    return String(data);
  }
  try {
    const serialized = JSON.stringify(data);
    return typeof serialized === "string"
      ? serialized
      : inspect(data, { depth: 2, breakLength: Infinity });
  } catch {
    return inspect(data, { depth: 2, breakLength: Infinity });
  }
}

export function getDefaultMcpLogPath(): string {
  return getAgentPath("mcp.log");
}

/** Format one `notifications/message` from `server` as a log line; continuation lines are indented. */
export function formatMcpLogMessage(server: string, params: unknown, now = new Date()): string {
  const message = isRecord(params) ? params : { data: params };
  const level =
    typeof message.level === "string" && message.level.length > 0 ? message.level : "info";
  const logger =
    typeof message.logger === "string" && message.logger.length > 0 ? ` ${message.logger}:` : "";
  const text = formatData(message.data).replace(/\r?\n/g, "\n    ");
  return `${now.toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

/** Appends server log messages to one file with size-based rotation (`<path>.1`). */
export class McpServerLog {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private size: number | undefined;

  constructor(logPath: string, maxBytes = MAX_MCP_LOG_BYTES) {
    this.logPath = logPath;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : MAX_MCP_LOG_BYTES;
  }

  get path(): string {
    return this.logPath;
  }

  write(server: string, params: unknown, now = new Date()): void {
    const line = formatMcpLogMessage(server, params, now);
    try {
      if (this.size === undefined) {
        mkdirSync(dirname(this.logPath), { recursive: true });
        this.size = this.currentSize();
      }
      if (this.size > this.maxBytes) {
        // Check actual disk size before rotating so concurrent processes do not double-rotate.
        if (this.currentSize() > this.maxBytes) {
          renameSync(this.logPath, `${this.logPath}.1`);
        }
        this.size = this.currentSize();
      }
      appendFileSync(this.logPath, line);
      this.size += Buffer.byteLength(line);
    } catch {
      // Logging is best effort and must never disrupt MCP traffic.
    }
  }

  private currentSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }
}
