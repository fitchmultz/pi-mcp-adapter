import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";
import { asObjectRecord } from "./mcp-output-values.ts";

function readAdapterVersion(): string {
  // Source modules sit beside package.json; compiled modules sit one level down in dist/.
  for (const path of ["./package.json", "../package.json"]) {
    try {
      const raw: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
      const manifest = asObjectRecord(raw);
      if (manifest?.name === "@fitchmultz/pi-mcp-adapter" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch {
      // Continue from source to the compiled-layout manifest, then use the fallback version.
    }
  }
  return "0.0.0";
}

export const ADAPTER_VERSION = readAdapterVersion();
export const DEFAULT_MCP_SCRIPT_TIMEOUT_MS = 30_000;
/** Most servers one multi-server pass connects at once. */
export const MAX_CONCURRENT_SERVER_CONNECTS = 10;

export function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}

async function execOpen(pi: ExtensionAPI, target: string, browser?: string, signal?: AbortSignal) {
  const options = signal ? { signal } : {};
  const hasBrowser = browser !== undefined && browser !== "";
  const os = platform();
  if (os === "darwin") {
    return pi.exec("open", hasBrowser ? ["-a", browser, target] : [target], options);
  }
  if (os === "win32") {
    return pi.exec(
      "cmd",
      hasBrowser ? ["/c", "start", "", browser, target] : ["/c", "start", "", target],
      options,
    );
  }
  return pi.exec(hasBrowser ? browser : "xdg-open", [target], options);
}

export async function openUrl(
  pi: ExtensionAPI,
  url: string,
  browser?: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await execOpen(pi, url, browser, signal);
  if (result.code !== 0) {
    throw new Error(
      result.stderr !== "" ? result.stderr : `Failed to open browser (exit code ${result.code})`,
    );
  }
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
  const result = await execOpen(pi, targetPath);
  if (result.code !== 0) {
    throw new Error(
      result.stderr !== "" ? result.stderr : `Failed to open path (exit code ${result.code})`,
    );
  }
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const iterator = items.entries();

  async function worker() {
    while (true) {
      const next = iterator.next();
      if (next.done === true) {
        return;
      }
      const [index, item] = next.value;
      results[index] = await fn(item);
    }
  }

  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);
  return results;
}

export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_match: string, name: string) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_match: string, name: string) => process.env[name] ?? "")
    .replace(/\{env:(\w+)\}/g, (_match: string, name: string) => process.env[name] ?? "");
}

function getMissingEnvVars(value: string): string[] {
  const missing = new Set<string>();
  for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined && name !== "" && process.env[name] === undefined) {
      missing.add(name);
    }
  }
  return [...missing];
}

export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function interpolateSecretExpression(value: string): string {
  if (value.startsWith("!!")) {
    return interpolateEnvVars(value.slice(1));
  }
  return value.startsWith("!") ? value : interpolateEnvVars(value);
}

export function interpolateEnvRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]),
  );
}

const COMMAND_SECRET_TIMEOUT_MS = 10_000;
const COMMAND_SECRET_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Resolve a secret value, executing only a single leading `!` command marker. */
export function resolveCommandSecret(value: string, context: string): string;
export function resolveCommandSecret(value: undefined, context: string): undefined;
export function resolveCommandSecret(
  value: string | undefined,
  context: string,
): string | undefined;
export function resolveCommandSecret(
  value: string | undefined,
  context: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.startsWith("!!")) {
    return interpolateEnvVars(value.slice(1));
  }
  if (!value.startsWith("!")) {
    return interpolateEnvVars(value);
  }

  let result;
  try {
    result = spawnSync(value.slice(1), {
      shell: true,
      encoding: "utf8",
      timeout: COMMAND_SECRET_TIMEOUT_MS,
      maxBuffer: COMMAND_SECRET_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error(`Failed to resolve ${context}: command failed to start`);
  }
  if (result.error) {
    const reason = commandFailureReason(result.error);
    throw new Error(`Failed to resolve ${context}: ${reason}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve ${context}: command exited with code ${result.status ?? "unknown"}`,
    );
  }

  const resolved = result.stdout.trim();
  if (resolved === "") {
    throw new Error(`Failed to resolve ${context}: command returned empty output`);
  }
  return resolved;
}

/** Resolve command markers in a configured record without mutating the input. */
export function resolveCommandSecretsRecord(
  values: Record<string, string> | undefined,
  context: (key: string) => string,
): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolveCommandSecret(value, context(key))]),
  );
}

export function resolveServerUrl(definition: Pick<ServerEntry, "url">): string | undefined {
  const configuredUrl: unknown = definition.url;
  if (configuredUrl === null || configuredUrl === undefined) {
    return undefined;
  }
  if (typeof configuredUrl !== "string") {
    throw new Error("MCP server URL must be a string");
  }

  const missing = getMissingEnvVars(configuredUrl);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`,
    );
  }

  const resolved = interpolateEnvVars(configuredUrl);
  try {
    // oxlint-disable-next-line eslint/no-new -- QX-026: preserve native URL errors without canonicalizing the returned bytes.
    new URL(resolved);
  } catch (error) {
    throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, {
      cause: error,
    });
  }
  return resolved;
}

export function resolveConfigPath(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const resolved = interpolateEnvVars(value);
  if (resolved === "~") {
    return homedir();
  }
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

export function resolveBearerToken(
  definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateSecretExpression(definition.bearerToken);
  }
  return definition.bearerTokenEnv !== undefined && definition.bearerTokenEnv !== ""
    ? process.env[definition.bearerTokenEnv]
    : undefined;
}

/** Remove OSC control strings, including payloads that have no terminator. */
export function stripOscSequences(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const isEscOsc = text.charCodeAt(index) === 0x1b && text[index + 1] === "]";
    const isC1Osc = text.charCodeAt(index) === 0x9d;
    if (!isEscOsc && !isC1Osc) {
      result += text.charAt(index++);
      continue;
    }

    index += isEscOsc ? 2 : 1;
    index = oscEnd(text, index);
  }
  return result;
}

function oscEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index++);
    if (code === 0x07 || code === 0x9c) {
      break;
    }
    if (code === 0x1b && text[index] === "\\") {
      index++;
      break;
    }
  }
  return index;
}

function commandFailureReason(error: Error): string {
  const code = "code" in error ? error.code : undefined;
  switch (code) {
    case "ETIMEDOUT":
      return "command timed out after 10 seconds";
    case "ENOBUFS":
      return "command output exceeded 1 MiB";
    default:
      return "command failed to start";
  }
}

export function sanitizeTerminalText(text: string): string {
  return stripOscSequences(text)
    .replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTerminalError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown) => {
    if (seen.has(value)) {
      return;
    }
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      seen.add(value);
    }

    if (value instanceof AggregateError) {
      collectAggregateMessages(value, collect, messages);
      return;
    }
    if (value instanceof Error) {
      if (value.message !== "") {
        messages.push(value.message);
      }
      if (value.cause !== undefined) {
        collect(value.cause);
      }
      return;
    }
    messages.push(String(value));
  };

  collect(error);
  return sanitizeTerminalText([...new Set(messages)].join(": "));
}

function collectAggregateMessages(
  value: AggregateError,
  collect: (value: unknown) => void,
  messages: string[],
): void {
  const countBefore = messages.length;
  for (const nested of value.errors) {
    collect(nested);
  }
  if (value.cause !== undefined) {
    collect(value.cause);
  }
  if (messages.length === countBefore && value.message !== "") {
    messages.push(value.message);
  }
}

export function truncateAtWord(text: string, target: number): string {
  if (text.length <= target) {
    return text;
  }

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

export function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown> {
  const record = asObjectRecord(schema);
  return record !== undefined && !Array.isArray(schema)
    ? structuredClone(record)
    : { type: "object", properties: {} };
}

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template !== undefined && template !== ""
    ? template.replaceAll("${server}", serverName)
    : defaultMessage;
}

export function formatMcpStatus(
  config: Pick<McpConfig, "settings">,
  message: string,
): string | undefined {
  if (config.settings?.mcpFooterStatus === "off") {
    return undefined;
  }
  return `${config.settings?.showStatusIcon === false ? "MCP: " : "🔌 MCP: "}${message}`;
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(
  toolMeta: Record<string, unknown> | undefined,
): "eager" | "stream-first" | undefined {
  const uiMeta = toolMeta?.ui;
  const record = asObjectRecord(uiMeta);
  if (!record) {
    return undefined;
  }
  const streamMode = record["pi-mcp-adapter.streamMode"];
  if (streamMode === "eager" || streamMode === "stream-first") {
    return streamMode;
  }
  return undefined;
}
