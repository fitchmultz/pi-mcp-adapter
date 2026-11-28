/**
 * Centralized logging for MCP UI operations.
 * Provides structured, contextual logs with levels.
 */
import { sanitizeTerminalText, stripOscSequences } from "./utils.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  server?: string;
  session?: string;
  tool?: string;
  uri?: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: "[MCP-UI:DEBUG]",
  info: "[MCP-UI]",
  warn: "[MCP-UI:WARN]",
  error: "[MCP-UI:ERROR]",
};

export type UiNotify = (message: string, level?: "info" | "warning" | "error") => void;

function isEnvDebugEnabled(): boolean {
  return process.env.MCP_UI_DEBUG === "1" || process.env.MCP_UI_DEBUG === "true";
}

function sanitizeNotificationText(text: string): string {
  return stripOscSequences(text)
    .split(/\r\n|\r|\n/)
    .map((line) => sanitizeTerminalText(line))
    .filter((line) => line !== "")
    .join("\n");
}

function notifySafely(
  notify: UiNotify,
  message: string,
  level: "info" | "warning" | "error",
): void {
  const sanitized = sanitizeNotificationText(message);
  if (sanitized === "") {
    return;
  }
  try {
    notify(sanitized, level);
  } catch {
    // Ignore notification failures during UI teardown or headless transitions.
  }
}

function formatTerminalArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.message;
  }
  if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") {
    return String(arg);
  }
  if (arg === undefined || arg === null) {
    return "";
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return "[unserializable]";
  }
}

function formatTerminalArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => formatTerminalArg(arg))
    .filter((part) => part !== "")
    .join(" ");
}

function emitToConsole(level: LogLevel, fullMessage: string, error?: Error): void {
  if (level === "error") {
    console.error(fullMessage, error ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(fullMessage);
    return;
  }
  if (level === "debug") {
    console.debug(fullMessage);
    return;
  }
  console.log(fullMessage);
}

function formatNotifyText(level: LogLevel, fullMessage: string, error?: Error): string {
  if (level === "error" && error !== undefined && error.message !== "") {
    return `${fullMessage}: ${error.message}`;
  }
  return fullMessage;
}

function emitDiagnosticToUiHost(
  notifier: UiNotify | undefined,
  level: "warn" | "error",
  fullMessage: string,
  error?: Error,
): void {
  if (notifier === undefined) {
    emitToConsole(level, fullMessage, error);
    return;
  }
  notifySafely(
    notifier,
    formatNotifyText(level, fullMessage, error),
    level === "error" ? "error" : "warning",
  );
  if (isEnvDebugEnabled()) {
    console.error(fullMessage, ...(error !== undefined ? [error] : []));
  }
}

function emitToUiHost(
  notifier: UiNotify | undefined,
  level: LogLevel,
  fullMessage: string,
  error?: Error,
): void {
  if (level === "warn" || level === "error") {
    emitDiagnosticToUiHost(notifier, level, fullMessage, error);
    return;
  }
  if (isEnvDebugEnabled()) {
    console.error(fullMessage, ...(error !== undefined ? [error] : []));
  }
}

class Logger {
  private minLevel: LogLevel = "info";
  private readonly uiHosts = new Map<object, UiNotify | undefined>();

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** Tracks active interactive UI hosts so logs route via notify instead of raw stdout/stderr. */
  setUiHost(owner: object, ui: { readonly notify?: UiNotify } | null | undefined): void {
    this.uiHosts.delete(owner);
    if (ui === null || ui === undefined) {
      return;
    }
    const notifier = typeof ui.notify === "function" ? ui.notify.bind(ui) : undefined;
    this.uiHosts.set(owner, notifier);
  }

  hasActiveUiHost(): boolean {
    return this.uiHosts.size > 0;
  }

  getActiveNotifier(): UiNotify | undefined {
    let latest: UiNotify | undefined;
    for (const notifier of this.uiHosts.values()) {
      if (notifier !== undefined) {
        latest = notifier;
      }
    }
    return latest;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const prefix = LEVEL_PREFIX[level];
    const contextStr = formatContext(context);
    const fullMessage =
      contextStr !== "" ? `${prefix} ${message} ${contextStr}` : `${prefix} ${message}`;

    if (this.hasActiveUiHost()) {
      emitToUiHost(this.getActiveNotifier(), level, fullMessage, error);
      return;
    }
    emitToConsole(level, fullMessage, error);
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.emit("error", message, context, error);
  }

  /**
   * Create a child logger with additional default context.
   */
  child(context: LogContext): ChildLogger {
    return new ChildLogger(this, context);
  }
}

class ChildLogger {
  private readonly parent: Logger;
  private readonly context: LogContext;

  constructor(parent: Logger, context: LogContext) {
    this.parent = parent;
    this.context = context;
  }

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, { ...this.context, ...context });
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, { ...this.context, ...context });
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, { ...this.context, ...context });
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.parent.error(message, error, { ...this.context, ...context });
  }

  child(context: LogContext): ChildLogger {
    return new ChildLogger(this.parent, { ...this.context, ...context });
  }
}

function formatContext(context?: LogContext): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null) {
      parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

// Singleton instance
export const logger = new Logger();

export function writeTerminalLog(...args: unknown[]): void {
  if (!logger.hasActiveUiHost()) {
    console.log(...args);
    return;
  }
  const notifier = logger.getActiveNotifier();
  if (notifier !== undefined) {
    notifySafely(notifier, formatTerminalArgs(args), "info");
  }
  if (isEnvDebugEnabled()) {
    console.error(...args);
  }
}

export function writeTerminalWarn(...args: unknown[]): void {
  if (!logger.hasActiveUiHost()) {
    console.warn(...args);
    return;
  }
  const notifier = logger.getActiveNotifier();
  if (notifier !== undefined) {
    notifySafely(notifier, formatTerminalArgs(args), "warning");
    if (isEnvDebugEnabled()) {
      console.warn(...args);
    }
    return;
  }
  console.warn(...args);
}

export function writeTerminalError(...args: unknown[]): void {
  if (!logger.hasActiveUiHost()) {
    console.error(...args);
    return;
  }
  const notifier = logger.getActiveNotifier();
  if (notifier !== undefined) {
    notifySafely(notifier, formatTerminalArgs(args), "error");
    if (isEnvDebugEnabled()) {
      console.error(...args);
    }
    return;
  }
  console.error(...args);
}

// Enable debug mode via environment variable
if (isEnvDebugEnabled()) {
  logger.setLevel("debug");
}
