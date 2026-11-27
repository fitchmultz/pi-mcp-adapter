import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import { throwIfAborted } from "./abort.ts";

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

export function interpolateSecretExpression(value: string): string {
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

// Match the prior synchronous 10s limit so hung secret-manager CLIs (e.g., op, security, pass) fail fast.
const COMMAND_SECRET_TIMEOUT_MS = 10_000;
// Short grace window after SIGTERM before SIGKILL so unresponsive shell/npm child trees do not linger.
const CHILD_KILL_GRACE_MS = 1_000;
// Match Node execFile/execFileSync's 1 MiB default maxBuffer so a runaway secret command cannot exhaust RAM.
const COMMAND_SECRET_MAX_OUTPUT_BYTES = 1024 * 1024;

function signalChildProcess(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  if (processGroup && process.platform !== "win32" && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child when no process group exists.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Child exited concurrently before signal delivery.
  }
}

/** Send SIGTERM and escalate to SIGKILL after a short unref'd grace window if the child ignores it. */
export function terminateChildProcess(proc: ChildProcess, processGroup = false): void {
  signalChildProcess(proc, "SIGTERM", processGroup);
  const killTimer = setTimeout(() => {
    signalChildProcess(proc, "SIGKILL", processGroup);
  }, CHILD_KILL_GRACE_MS);
  killTimer.unref();
  const clear = () => clearTimeout(killTimer);
  proc.once("exit", clear);
  proc.once("close", clear);
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "MCP request aborted"));
}

function runCommandSecret(command: string, context: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, {
        shell: true,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      reject(new Error(`Failed to resolve ${context}: command failed to start`));
      return;
    }
    let settled = false;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const finish = (outcome: { value?: string; error?: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (outcome.error !== undefined) {
        reject(outcome.error);
        return;
      }
      resolve(outcome.value ?? "");
    };
    const onAbort = () => {
      terminateChildProcess(proc, true);
      finish({ error: signal ? abortReasonError(signal) : new Error("MCP request aborted") });
    };
    const timer = setTimeout(() => {
      terminateChildProcess(proc, true);
      finish({
        error: new Error(`Failed to resolve ${context}: command timed out after 10 seconds`),
      });
    }, COMMAND_SECRET_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      totalBytes += bytes.byteLength;
      if (totalBytes > COMMAND_SECRET_MAX_OUTPUT_BYTES) {
        terminateChildProcess(proc, true);
        finish({ error: new Error(`Failed to resolve ${context}: command output exceeded 1 MiB`) });
        return;
      }
      chunks.push(bytes);
    });
    proc.on("error", () => {
      finish({ error: new Error(`Failed to resolve ${context}: command failed to start`) });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        finish({
          error: new Error(
            `Failed to resolve ${context}: command exited with code ${code ?? "unknown"}`,
          ),
        });
        return;
      }
      const resolved = Buffer.concat(chunks).toString("utf8").trim();
      finish(
        resolved === ""
          ? { error: new Error(`Failed to resolve ${context}: command returned empty output`) }
          : { value: resolved },
      );
    });
  });
}

/** Resolve a secret value, executing only a single leading `!` command marker. */
export async function resolveCommandSecret(
  value: string,
  context: string,
  signal?: AbortSignal,
): Promise<string>;
export async function resolveCommandSecret(
  value: undefined,
  context: string,
  signal?: AbortSignal,
): Promise<undefined>;
export async function resolveCommandSecret(
  value: string | undefined,
  context: string,
  signal?: AbortSignal,
): Promise<string | undefined>;
export async function resolveCommandSecret(
  value: string | undefined,
  context: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined;
  }
  if (value.startsWith("!!")) {
    return interpolateEnvVars(value.slice(1));
  }
  if (!value.startsWith("!")) {
    return interpolateEnvVars(value);
  }
  return await runCommandSecret(value.slice(1), context, signal);
}

/** Resolve command markers in a configured record concurrently without mutating the input. */
export async function resolveCommandSecretsRecord(
  values: Record<string, string> | undefined,
  context: (key: string) => string,
  signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
  if (!values) {
    return undefined;
  }
  const controller = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const entries = await Promise.all(
      Object.entries(values).map(
        async ([key, value]) =>
          [key, await resolveCommandSecret(value, context(key), effectiveSignal)] as const,
      ),
    );
    return Object.fromEntries(entries);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

export function hasServerUrl(definition: Pick<ServerEntry, "url">): boolean {
  return typeof definition.url === "string" && definition.url.trim() !== "";
}

export function resolveServerUrl(definition: Pick<ServerEntry, "url">): string | undefined {
  const configuredUrl: unknown = definition.url;
  if (
    configuredUrl === null ||
    configuredUrl === undefined ||
    (typeof configuredUrl === "string" && !hasServerUrl(definition))
  ) {
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
  if (record === undefined || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const cloned = structuredClone(record);
  if (cloned.type === undefined) {
    cloned.type = "object";
  }
  if (cloned.properties === undefined && cloned.type === "object") {
    cloned.properties = {};
  }
  return cloned;
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
