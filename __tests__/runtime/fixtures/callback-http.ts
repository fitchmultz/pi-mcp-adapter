import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import {
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  JSONRPCRequestSchema,
  type JSONRPCResponseSchema,
  type JSONObjectSchema,
  type ServerCapabilitiesSchema,
  SubscriptionsListenRequestSchema,
} from "@modelcontextprotocol/core";
import type { z } from "zod";
import { saveAuthEntry, updateTokens } from "../../../mcp-auth.ts";
import type { McpConfig, ServerDefinition } from "../../../types.ts";
import {
  MachineHttpServer,
  machineJson,
  readMachineBody,
} from "../../fixtures/oauth-machine-wire.ts";

export const samplingRequest = {
  messages: [{ role: "user", content: { type: "text", text: "Synthetic sample" } }],
  maxTokens: 8,
};
export const elicitationRequest = {
  mode: "form",
  message: "Synthetic question",
  requestedSchema: { type: "object", properties: {} },
};

export interface CallbackFixtureOptions {
  oauth?: boolean;
  capabilities?: z.infer<typeof ServerCapabilitiesSchema>;
  session?: boolean;
  legacy?: boolean;
  inbound?: boolean;
  input?: "sampling" | "elicitation";
}

type CallbackReply = z.infer<typeof JSONRPCResponseSchema>;
export interface CallbackHttpFixture {
  name: string;
  url: string;
  origin: string;
  config: McpConfig;
  definition: ServerDefinition;
  methods: string[];
  notifications: string[];
  updateCatalogs: (name?: string) => void;
  holdNextCatalog: (catalog: "tools" | "resources" | "prompts") => {
    started: Promise<null>;
    release: () => void;
  };
  calls: () => number;
  refreshes: () => number;
  streamReady: () => boolean;
  notify: (method: string, params: z.infer<typeof JSONObjectSchema>) => void;
  gets: () => number;
  unauthorized: () => number;
  rejectNextGet: () => void;
  endStream: () => void;
  clientCapabilities: () => unknown;
  finishInput: () => void;
  callback: (
    method: string,
    params: z.infer<typeof JSONObjectSchema>,
  ) => {
    response: Promise<CallbackReply>;
    cancel: () => void;
  };
  delay: (method: string) => void;
  started: () => boolean;
  release: () => void;
  expire: () => void;
  close: () => Promise<void>;
}

/** Real callback replies, subscriptions and token bodies held across native shutdown. */
export async function createCallbackHttpFixture(
  directory: string,
  options: CallbackFixtureOptions = {},
): Promise<CallbackHttpFixture> {
  let token = "SYNTHETIC-INITIAL";
  let input = options.input;
  let delayed: { method: string; gate: PromiseWithResolvers<void> } | undefined;
  let started = false;
  let callCount = 0;
  let updatedCatalogs: string | undefined;
  const heldCatalogs = new Map<
    string,
    { started: PromiseWithResolvers<null>; done: PromiseWithResolvers<null> }
  >();
  const catalogHolds: PromiseWithResolvers<null>[] = [];
  let refreshCount = 0;
  let getCount = 0;
  let unauthorizedCount = 0;
  let rejectGet = false;
  const methods: string[] = [];
  let stream: ServerResponse | undefined;
  let callbackId = 0;
  let subscriptionId: string | number | undefined;
  let advertisedClientCapabilities: unknown;
  const replies = new Map<string, (value: CallbackReply) => void>();
  const notifications: string[] = [];
  const http = new MachineHttpServer(handle);
  const origin = await http.listen();
  const name = "fixture-" + crypto.randomUUID();
  const url = origin + "/mcp";
  const definition: ServerDefinition = {
    url,
    auth: options.oauth === true ? "oauth" : false,
    requestTimeoutMs: 3000,
    ...(options.legacy === true || options.session === true || options.inbound === true
      ? { protocolVersion: "legacy" }
      : {}),
    ...(options.oauth === true
      ? { oauth: { clientId: "SYNTHETIC-CLIENT", clientSecret: "SYNTHETIC-CLIENT-SECRET" } }
      : {}),
  };
  const config: McpConfig = {
    mcpServers: { [name]: definition },
    settings: {
      toolPrefix: "none",
      trace: { enabled: true, file: join(directory, "trace.jsonl") },
    },
  };
  if (options.oauth === true) {
    saveAuthEntry(
      { serverName: name, serverUrl: url },
      {
        tokens: {
          accessToken: token,
          refreshToken: "SYNTHETIC-REFRESH",
          expiresAt: Date.now() / 1000 + 3600,
          issuer: origin,
        },
      },
    );
  }

  async function block(method: string): Promise<void> {
    const held = delayed;
    if (held?.method === method) {
      started = true;
      await held.gate.promise;
    }
  }

  function metadata(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.url?.startsWith("/.well-known/oauth-protected-resource") === true) {
      machineJson(response, { resource: url, authorization_servers: [origin] });
      return true;
    }
    if (request.url?.startsWith("/.well-known/oauth-authorization-server") === true) {
      machineJson(response, {
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      return true;
    }
    return false;
  }

  function unauthorized(response: ServerResponse): void {
    response
      .writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      })
      .end();
  }

  async function handleGet(response: ServerResponse): Promise<void> {
    getCount++;
    await block("GET");
    if (options.inbound !== true) {
      response.writeHead(405).end();
      return;
    }
    if (rejectGet) {
      rejectGet = false;
      unauthorized(response);
      return;
    }
    stream = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (metadata(request, response)) {
      return;
    }
    if (request.method === "GET") {
      await handleGet(response);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const text = await readMachineBody(request);
    if (request.url === "/token") {
      methods.push("token");
      await block("token");
      refreshCount++;
      machineJson(response, {
        access_token: token,
        refresh_token: "SYNTHETIC-REFRESH-UPDATED",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    const message = JSONRPCMessageSchema.parse(JSON.parse(text));
    if (!("method" in message)) {
      replies.get(String(message.id))?.(message);
      replies.delete(String(message.id));
      await block("callback-reply");
      response.writeHead(202).end();
      return;
    }
    methods.push(message.method);
    await block(message.method);
    if (options.oauth === true && request.headers.authorization !== `Bearer ${token}`) {
      unauthorizedCount++;
      unauthorized(response);
      return;
    }
    if (message.method.startsWith("notifications/")) {
      response.writeHead(202).end();
      return;
    }
    const body = JSONRPCRequestSchema.parse(message);
    if (body.method === "subscriptions/listen") {
      const subscription = SubscriptionsListenRequestSchema.parse(body);
      stream = response;
      subscriptionId = body.id;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: subscription.params.notifications,
            _meta: { [SUBSCRIPTION_ID_META_KEY]: body.id },
          },
        })}\n\n`,
      );
      return;
    }
    const value = result(body);
    const held = heldCatalogs.get(body.method);
    if (held) {
      heldCatalogs.delete(body.method);
      held.started.resolve(null);
      await held.done.promise;
    }
    response
      .writeHead(200, {
        "content-type": "application/json",
        ...(options.session === true ? { "mcp-session-id": "synthetic-session" } : {}),
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: value }));
  }

  function result(body: z.infer<typeof JSONRPCRequestSchema>): unknown {
    switch (body.method) {
      case "initialize":
        advertisedClientCapabilities = InitializeRequestSchema.parse(body).params.capabilities;
        return {
          protocolVersion: "2025-11-25",
          capabilities: options.capabilities ?? { tools: {} },
          serverInfo: { name: "synthetic", version: "1" },
        };
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: options.capabilities ?? { tools: {} },
        };
      case "tools/call":
        callCount++;
        if (input !== undefined && body.params?.inputResponses === undefined) {
          return {
            resultType: "input_required",
            requestState: "synthetic-state",
            inputRequests: {
              answer: {
                method: input === "sampling" ? "sampling/createMessage" : "elicitation/create",
                params: input === "sampling" ? samplingRequest : elicitationRequest,
              },
            },
          };
        }
        break;
      case "tools/list":
        return {
          resultType: "complete",
          ttlMs: 1000,
          cacheScope: "private",
          tools: [{ name: updatedCatalogs ?? "echo", inputSchema: { type: "object" } }],
        };
      case "resources/list":
        return {
          resultType: "complete",
          resources:
            updatedCatalogs !== undefined
              ? [{ uri: `file://${updatedCatalogs}`, name: updatedCatalogs }]
              : [],
        };
      case "prompts/list":
        return {
          resultType: "complete",
          prompts: updatedCatalogs !== undefined ? [{ name: updatedCatalogs }] : [],
        };
      case "completion/complete":
        return {
          resultType: "complete",
          completion: { values: ["synthetic"], total: 1, hasMore: false },
        };
      case "logging/setLevel":
      case "resources/subscribe":
      case "resources/unsubscribe":
        return { resultType: "complete" };
    }
    return { resultType: "complete", content: [{ type: "text", text: "SYNTHETIC-OK" }] };
  }

  function notify(method: string, params: z.infer<typeof JSONObjectSchema>): void {
    assert.ok(stream, "No native GET stream");
    notifications.push(method);
    stream.write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          ...(subscriptionId !== undefined
            ? { _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } }
            : {}),
        },
      })}\n\n`,
    );
  }

  return {
    name,
    url,
    origin,
    config,
    definition,
    methods,
    notifications,
    updateCatalogs: (catalogName = "updated") => {
      updatedCatalogs = catalogName;
    },
    holdNextCatalog: (catalog) => {
      const requestStarted = Promise.withResolvers<null>();
      const done = Promise.withResolvers<null>();
      heldCatalogs.set(`${catalog}/list`, { started: requestStarted, done });
      catalogHolds.push(done);
      return { started: requestStarted.promise, release: () => done.resolve(null) };
    },
    calls: () => callCount,
    refreshes: () => refreshCount,
    streamReady: () => stream !== undefined,
    notify,
    gets: () => getCount,
    unauthorized: () => unauthorizedCount,
    rejectNextGet: () => {
      rejectGet = true;
    },
    endStream: () => {
      assert.ok(stream, "No native GET stream");
      stream.end("retry: 1\n\n");
    },
    clientCapabilities: () => advertisedClientCapabilities,
    finishInput: () => {
      input = undefined;
    },
    callback: (method, params) => {
      assert.ok(stream, "No native GET stream");
      const id = `callback-${++callbackId}`;
      const completed = Promise.withResolvers<CallbackReply>();
      replies.set(id, completed.resolve);
      stream.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n\n`,
      );
      return {
        response: completed.promise,
        cancel: () =>
          notify("notifications/cancelled", { requestId: id, reason: "synthetic cancellation" }),
      };
    },
    delay: (method) => {
      delayed = { method, gate: Promise.withResolvers() };
      started = false;
    },
    started: () => started,
    release: () => {
      const held = delayed;
      delayed = undefined;
      held?.gate.resolve();
    },
    expire: () => {
      token = "SYNTHETIC-UPDATED";
      updateTokens(
        { serverName: name, serverUrl: url },
        {
          accessToken: "SYNTHETIC-INITIAL",
          refreshToken: "SYNTHETIC-REFRESH",
          expiresAt: 1,
          issuer: origin,
        },
      );
    },
    close: async () => {
      delayed?.gate.resolve();
      for (const held of catalogHolds) {
        held.resolve(null);
      }
      await http.close();
    },
  };
}
