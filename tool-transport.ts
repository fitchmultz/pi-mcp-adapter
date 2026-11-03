import { AsyncLocalStorage } from "node:async_hooks";
import {
  SdkError,
  SdkHttpError,
  SdkErrorCode,
  type FetchLike,
  type Transport,
} from "@modelcontextprotocol/client";
import { abortable } from "./abort.ts";

const toolTransportFailures = new WeakSet<object>();
export function isToolTransportFailure(error: unknown): boolean {
  return error instanceof Error && toolTransportFailures.has(error);
}
const interruptedToolCalls = new WeakSet<object>();
export function isInterruptedToolCall(error: unknown): boolean {
  return error instanceof Error && interruptedToolCalls.has(error);
}
type ToolCallOutcome = { pending: boolean; cleanup: Set<() => void> };
const toolCallOutcome = new AsyncLocalStorage<ToolCallOutcome>();

/** Interrupted outcome reporting is separate from the transport retry policy. */
export async function trackToolCallOutcome<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const outcome: ToolCallOutcome = { pending: false, cleanup: new Set() };
  return toolCallOutcome.run(outcome, async () => {
    try {
      return await fn();
    } catch (error) {
      if (outcome.pending && isInterruptedFailure(error, signal)) {
        // Abort reasons can be shared by calls that never reached dispatch.
        const interrupted = new Error(error.message, { cause: error });
        interruptedToolCalls.add(interrupted);
        throw interrupted;
      }
      throw error;
    } finally {
      for (const cleanup of outcome.cleanup) {
        cleanup();
      }
    }
  });
}

function isInterruptedFailure(error: unknown, signal?: AbortSignal): error is Error {
  return (
    error instanceof Error &&
    (signal?.aborted === true ||
      (error instanceof SdkError &&
        (error.code === SdkErrorCode.RequestTimeout ||
          error.code === SdkErrorCode.ConnectionClosed)))
  );
}

type SendMessage = Parameters<Transport["send"]>[0];
type SendOptions = Parameters<Transport["send"]>[1];

class ToolSend {
  readonly id: string | number;
  readonly outcome = toolCallOutcome.getStore();
  streaming = false;
  responseReceived = false;
  bodyFailure: Error | undefined;
  otherFailure: Error | undefined;
  finishSend: (() => void) | undefined;
  private readonly http: boolean;

  constructor(id: string | number, http: boolean) {
    this.id = id;
    this.http = http;
    if (!http && this.outcome) {
      this.outcome.pending = true;
    }
  }

  beginFetch(toolPost: boolean): void {
    if (toolPost && this.outcome) {
      this.outcome.pending = true;
    }
  }

  response(
    response: Response,
    toolPost: boolean,
    signal: AbortSignal | null | undefined,
  ): Response {
    if (toolPost && !response.ok && response.status < 500 && this.outcome) {
      this.outcome.pending = false;
    }
    if (!response.body || !observesBody(response, toolPost)) {
      return response;
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    this.streaming = response.ok && mediaType === "text/event-stream";
    const body = new ToolResponseBody(this, response.body.getReader(), signal);
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => body.pull(controller),
        cancel: (reason: unknown) => body.cancel(reason),
      }),
      response,
    );
  }

  private streamEnd(
    options: SendOptions,
    resolve: () => void,
    reject: (error: unknown) => void,
  ): void {
    options?.onRequestStreamEnd?.();
    const error = this.otherFailure ?? this.bodyFailure;
    if (!this.responseReceived && error) {
      if (!this.otherFailure) {
        toolTransportFailures.add(error);
      }
      reject(error);
    } else {
      resolve();
    }
  }

  async observe(
    send: Transport["send"],
    message: SendMessage,
    options: SendOptions,
  ): Promise<void> {
    try {
      if (!options?.requestSignal) {
        await toolSend.run(this, () => send(message, options));
        return;
      }
      await abortable(
        new Promise<void>((resolve, reject) => {
          this.finishSend = resolve;
          void toolSend
            .run(this, () =>
              send(message, {
                ...options,
                onRequestStreamEnd: () => this.streamEnd(options, resolve, reject),
              }),
            )
            .then(() => {
              if (!this.streaming) {
                resolve();
              }
            }, reject);
        }),
        options.requestSignal,
      );
    } catch (error) {
      if (!this.http && this.outcome) {
        this.outcome.pending = false;
      }
      throw error;
    } finally {
      this.finishSend = undefined;
    }
  }
}

const toolSend = new AsyncLocalStorage<ToolSend | undefined>();

function isToolPost(init: RequestInit | undefined, pending: ToolSend | undefined): boolean {
  if (!pending || init?.method !== "POST" || typeof init.body !== "string") {
    return false;
  }
  try {
    const request: unknown = JSON.parse(init.body);
    return matchesToolRequest(request, pending.id);
  } catch {
    // Non-JSON requests are not tool dispatches.
    return false;
  }
}

function matchesToolRequest(request: unknown, id: string | number): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "method" in request &&
    request.method === "tools/call" &&
    "id" in request &&
    request.id === id
  );
}

function observesBody(response: Response, toolPost: boolean): boolean {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return response.ok
    ? mediaType === "text/event-stream" || (toolPost && mediaType === "application/json")
    : toolPost && response.status >= 500;
}

class ToolResponseBody {
  private readonly pending: ToolSend;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly signal: AbortSignal | null | undefined;

  constructor(
    pending: ToolSend,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal | null | undefined,
  ) {
    this.pending = pending;
    this.reader = reader;
    this.signal = signal;
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      const { done, value } = await this.reader.read();
      if (done) {
        controller.close();
        this.reader.releaseLock();
      } else {
        controller.enqueue(value);
      }
    } catch (error) {
      // Native intentional closure suppresses onRequestStreamEnd.
      if (this.signal?.aborted === true) {
        this.pending.finishSend?.();
      } else if (error instanceof Error) {
        this.pending.bodyFailure = error;
        if (!this.pending.streaming) {
          interruptedToolCalls.add(error);
        }
      }
      controller.error(error);
      this.reader.releaseLock();
    }
  }

  cancel(reason: unknown): Promise<void> {
    return this.reader.cancel(reason).finally(() => this.reader.releaseLock());
  }
}

/** Retain fetch/body-error origin without parsing or buffering the response. */
export const trackToolTransportFailure: FetchLike = async (input, init) => {
  const pending = toolSend.getStore();
  if (pending) {
    pending.bodyFailure = undefined;
  }
  const toolPost = isToolPost(init, pending);
  pending?.beginFetch(toolPost);
  try {
    const response = await fetch(input, init);
    return pending?.response(response, toolPost, init?.signal) ?? response;
  } catch (error) {
    if (isToolFetchFailure(error, init)) {
      toolTransportFailures.add(error);
    }
    throw error;
  }
};

function isToolFetchFailure(error: unknown, init: RequestInit | undefined): error is Error {
  return (
    error instanceof Error &&
    init?.signal?.aborted !== true &&
    init?.method === "POST" &&
    new Headers(init.headers).get("Mcp-Method") === "tools/call"
  );
}

function hasProtocolErrorBody(error: SdkHttpError): boolean {
  try {
    const body: unknown = JSON.parse(String(error.data.text));
    return (
      typeof body === "object" &&
      body !== null &&
      "jsonrpc" in body &&
      body.jsonrpc === "2.0" &&
      "error" in body &&
      body.error !== undefined
    );
  } catch {
    // A failed/non-JSON body cannot establish an MCP error response.
    return false;
  }
}

class ToolTransportObserver {
  private readonly requests = new Map<string | number, ToolSend>();
  private readonly transport: Transport;
  private readonly http: boolean;

  constructor(transport: Transport, http: boolean) {
    this.transport = transport;
    this.http = http;
  }

  attach(): void {
    const onmessage = this.transport.onmessage;
    this.transport.onmessage = (message, extra) => {
      this.receive(message);
      onmessage?.(message, extra);
    };
    const onerror = this.transport.onerror;
    this.transport.onerror = (error) => {
      const pending = toolSend.getStore();
      // Reader failures precede SDK reporting; earlier parser errors are not retryable.
      if (pending && !pending.bodyFailure) {
        pending.otherFailure ??= error;
      }
      onerror?.(error);
    };
    const send = this.transport.send.bind(this.transport);
    this.transport.send = (message, options) => this.send(send, message, options);
  }

  private receive(message: SendMessage): void {
    if (
      !("id" in message) ||
      message.id === undefined ||
      !("result" in message || "error" in message)
    ) {
      return;
    }
    const pending = this.requests.get(message.id) ?? toolSend.getStore();
    if (!pending || message.id !== pending.id) {
      return;
    }
    pending.responseReceived = true;
    if (pending.outcome) {
      pending.outcome.pending = false;
    }
    this.requests.delete(pending.id);
    pending.finishSend?.();
  }

  private createPending(id: string | number): ToolSend {
    const pending = new ToolSend(id, this.http);
    if (pending.outcome) {
      this.requests.set(id, pending);
      pending.outcome.cleanup.add(() => this.requests.delete(id));
    }
    return pending;
  }

  private async send(
    send: Transport["send"],
    message: SendMessage,
    options: SendOptions,
  ): Promise<void> {
    try {
      if (!("method" in message && message.method === "tools/call" && "id" in message)) {
        await toolSend.run(undefined, () => send(message, options));
        return;
      }
      await this.createPending(message.id).observe(send, message, options);
    } catch (error) {
      if (isToolHttpFailure(message, error)) {
        toolTransportFailures.add(error);
      }
      throw error;
    }
  }
}

function isToolHttpFailure(message: SendMessage, error: unknown): error is SdkHttpError {
  return (
    "method" in message &&
    message.method === "tools/call" &&
    error instanceof SdkHttpError &&
    error.code === SdkErrorCode.ClientHttpNotImplemented &&
    error.status >= 500 &&
    error.status < 600 &&
    !hasProtocolErrorBody(error)
  );
}

/** Observe only the originating tool send, not OAuth or catalog requests. */
export function trackToolTransport(transport: Transport, http = false): void {
  const observer = new ToolTransportObserver(transport, http);
  observer.attach();
}
