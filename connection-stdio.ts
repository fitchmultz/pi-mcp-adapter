import type * as ConnectionRuntime from "./connection-runtime.ts";
import type { ServerDefinition } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { resolveConfigPath, resolveCommandSecretsRecord } from "./utils.ts";
import { throwIfAborted } from "./abort.ts";
import { logger } from "./logger.ts";

const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
const MAX_CAPTURED_STDERR_LINES = 3;

function boundedStderrChunk(chunk: Buffer | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    const start = Math.max(0, chunk.byteLength - MAX_CAPTURED_STDERR_BYTES);
    return Buffer.from(chunk.subarray(start));
  }

  // Limit string conversion before encoding; Buffer.from(largeString) would
  // otherwise allocate the entire stderr event before applying the cap.
  const suffix =
    chunk.length > MAX_CAPTURED_STDERR_BYTES ? chunk.slice(-MAX_CAPTURED_STDERR_BYTES) : chunk;
  const bytes = Buffer.from(suffix, "utf8");
  return bytes.byteLength > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_STDERR_BYTES))
    : bytes;
}

function appendStderrTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const bytes = boundedStderrChunk(chunk);
  if (bytes.length === 0) {
    return tail;
  }
  if (tail.length === 0) {
    return bytes;
  }
  const combined = Buffer.concat([tail, bytes]);
  return combined.length > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(combined.subarray(combined.length - MAX_CAPTURED_STDERR_BYTES))
    : combined;
}

export class StdioDiagnostics {
  private tail: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    this.tail = appendStderrTail(this.tail, chunk);
  }

  report(error: unknown): unknown {
    const lines = this.tail
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return error;
    }
    const base = error instanceof Error ? error.message : String(error);
    return new Error(`${base} (${lines.slice(-MAX_CAPTURED_STDERR_LINES).join(" — ")})`, {
      cause: error,
    });
  }
}

export function createStdioConnection(
  runtime: typeof ConnectionRuntime,
  definition: ServerDefinition,
  diagnostics: StdioDiagnostics,
  options: {
    name: string;
    defaultCwd: string | undefined;
    signal: AbortSignal | undefined;
    command: string;
    args: string[];
  },
): ConnectionRuntime.StdioClientTransport {
  throwIfAborted(options.signal);
  const cwd = resolveConfigPath(definition.cwd) ?? options.defaultCwd;
  const transport = new runtime.StdioClientTransport({
    command: options.command,
    args: options.args,
    env: resolveEnv(definition.env, options.name),
    ...(cwd !== undefined ? { cwd } : {}),
    stderr: definition.debug === true ? "inherit" : "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => diagnostics.append(chunk));
  return transport;
}

export async function resolveStdioCommand(
  command: string,
  args: string[],
  options: { name: string; signal: AbortSignal | undefined },
): Promise<{ command: string; args: string[] }> {
  const resolved = await resolveNpxBinary(command, args, options.signal);
  if (!resolved) {
    return { command, args };
  }
  logger.debug(`${options.name} resolved to ${resolved.binPath} (skipping npm parent)`);
  return {
    command: resolved.isJs ? "node" : resolved.binPath,
    args: resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs,
  };
}

function resolveEnv(
  env: Record<string, string> | undefined,
  serverName: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  const overrides = resolveCommandSecretsRecord(
    env,
    (key) => `MCP server "${serverName}" stdio env "${key}"`,
  );
  return overrides ? { ...resolved, ...overrides } : resolved;
}
