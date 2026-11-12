import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import {
  CallToolRequestSchema,
  JSONRPCMessageSchema,
  type JSONRPCRequestSchema,
  OAuthClientMetadataSchema,
  type ToolSchema,
} from "@modelcontextprotocol/core";
import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/client";

export type RecoveryEra = "legacy" | "modern";
type JSONRPCRequest = z.infer<typeof JSONRPCRequestSchema>;
export const recoveryTools: z.infer<typeof ToolSchema>[] = ["write", "effect"].map((name) => ({
  name,
  inputSchema: { type: "object" },
}));
export const content = (text: string): Pick<CallToolResult, "content"> => ({
  content: [{ type: "text", text }],
});
export const scopes = (scope: string | null | undefined): string[] =>
  (scope ?? "")
    .split(" ")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

type RecoveryControls = {
  protectedMethod: string;
  challengeStatus: number;
  refresh: boolean;
  issuedScope: string | null | undefined;
  holdEffect: boolean;
  releaseEffect: () => void;
  effectCount: number;
  requiredScope: string | undefined;
  toolStatuses: number[];
  tokenFailure: boolean;
  genericForbidden: boolean;
  metadataAbsent: boolean;
  issuerRequired: boolean;
  protectScope: boolean;
  notifications: boolean;
  stream: ServerResponse | undefined;
  holdDiscovery: boolean;
  discoveryHeld: boolean;
  holdToken: boolean;
  releaseToken: () => void;
  holdRegistration: boolean;
  registrationHeld: boolean;
  releaseRegistration: () => void;
  holdCatalog: boolean;
  releaseCatalog: () => void;
  catalogHeld: boolean;
  issuerPath: string;
  offlineAccess: boolean;
  accessScope: string;
  advertisedScopes: string[];
  catalogFailure: { method: string; status: number } | undefined;
  holdResource: boolean;
  resourceHeld: boolean;
  rejectResource: () => void;
  holdAnonymous: boolean;
  anonymousHeld: boolean;
  releaseAnonymous: () => void;
};
type WireRequest = { method: string; token: string | undefined; name: string | undefined };

function noop(): void {
  // Hold controls are inert until the corresponding HTTP request arrives.
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    assert(Buffer.isBuffer(value));
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Real OAuth and MCP endpoints, including accepted bodies held across reconnection. */
export class OAuthRecoveryHttp {
  origin = "";
  readonly requests: WireRequest[] = [];
  readonly http: Array<{ method: string | undefined; path: string }> = [];
  readonly authorizations: URL[] = [];
  readonly exchanges: URLSearchParams[] = [];
  readonly controls: RecoveryControls = {
    protectedMethod: "",
    challengeStatus: 401,
    refresh: false,
    issuedScope: undefined,
    holdEffect: false,
    releaseEffect: noop,
    effectCount: 0,
    requiredScope: "write",
    toolStatuses: [],
    tokenFailure: false,
    genericForbidden: false,
    metadataAbsent: false,
    issuerRequired: true,
    protectScope: false,
    notifications: false,
    stream: undefined,
    holdDiscovery: false,
    discoveryHeld: false,
    holdToken: false,
    releaseToken: noop,
    holdRegistration: false,
    registrationHeld: false,
    releaseRegistration: noop,
    holdCatalog: false,
    releaseCatalog: noop,
    catalogHeld: false,
    issuerPath: "",
    offlineAccess: false,
    accessScope: "write",
    advertisedScopes: ["basic"],
    catalogFailure: undefined,
    holdResource: false,
    resourceHeld: false,
    rejectResource: noop,
    holdAnonymous: false,
    anonymousHeld: false,
    releaseAnonymous: noop,
  };
  readonly #era: RecoveryEra;
  readonly #errors: unknown[] = [];
  readonly #codes = new Map<string, URL>();
  readonly #tokens = new Map<string, string>([
    ["basic-token", "basic"],
    ["wide-token", "basic write"],
  ]);
  #sessions = 0;
  #codeNumber = 0;
  readonly #server = createServer((request, response) => {
    this.#handle(request, response).catch((error: unknown) => {
      this.#errors.push(error);
      response.destroy();
    });
  });

  constructor(era: RecoveryEra) {
    this.#era = era;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    assert(address !== null && typeof address !== "string", "Fixture did not bind");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    assert.deepEqual(this.#errors, [], "OAuth fixture request handler failed");
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    this.http.push({ method: request.method, path: url.pathname });
    if (this.#metadata(url, response)) {
      return;
    }
    if (url.pathname === "/authorize") {
      this.#authorize(url, response);
      return;
    }
    const body = await readBody(request);
    if (url.pathname === "/register") {
      const registration = {
        client_id: "fixture",
        ...OAuthClientMetadataSchema.parse(JSON.parse(body)),
      };
      if (this.controls.holdRegistration) {
        this.controls.registrationHeld = true;
        this.controls.releaseRegistration = () => json(response, registration, 201);
      } else {
        json(response, registration, 201);
      }
      return;
    }
    if (url.pathname === "/token") {
      this.#token(new URLSearchParams(body), request, response);
      return;
    }
    if (request.method === "GET" && this.controls.notifications) {
      this.controls.stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": ready\n\n");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 202 : 405).end();
      return;
    }
    const message = JSONRPCMessageSchema.parse(JSON.parse(body));
    assert("method" in message, "Expected a native MCP request or notification");
    if (message.method.startsWith("notifications/")) {
      response.writeHead(202).end();
      return;
    }
    assert("id" in message, "Expected a native MCP request id");
    this.#mcp(message, request, response);
  }

  #metadata(url: URL, response: ServerResponse): boolean {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, {
        resource: `${this.origin}/mcp`,
        authorization_servers: [`${this.origin}${this.controls.issuerPath}`],
        scopes_supported: this.controls.advertisedScopes,
      });
      return true;
    }
    if (
      this.controls.metadataAbsent &&
      (url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.includes("openid-configuration"))
    ) {
      response.writeHead(404).end();
      return true;
    }
    if (!url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return false;
    }
    json(response, {
      issuer: `${this.origin}${this.controls.issuerPath}`,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      registration_endpoint: `${this.origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      authorization_response_iss_parameter_supported: this.controls.issuerRequired,
      ...(this.controls.offlineAccess
        ? { scopes_supported: ["basic", "write", "offline_access"] }
        : {}),
    });
    return true;
  }

  #authorize(url: URL, response: ServerResponse): void {
    this.authorizations.push(url);
    const code = `code-${++this.#codeNumber}`;
    this.#codes.set(code, url);
    const redirect = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    assert(redirect !== null && state !== null, "Authorization needs a redirect and state");
    const callback = new URL(redirect);
    callback.search = new URLSearchParams({ code, state, iss: this.origin }).toString();
    response.writeHead(302, { location: callback.href }).end();
  }

  #token(params: URLSearchParams, request: IncomingMessage, response: ServerResponse): void {
    this.exchanges.push(params);
    if (this.controls.tokenFailure) {
      request.socket.destroy();
      return;
    }
    const code = params.get("code");
    const authorization = code === null ? undefined : this.#codes.get(code);
    if (params.get("grant_type") === "authorization_code") {
      const challenge = createHash("sha256")
        .update(params.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        code === null ||
        !authorization ||
        challenge !== authorization.searchParams.get("code_challenge") ||
        params.get("redirect_uri") !== authorization.searchParams.get("redirect_uri")
      ) {
        json(response, { error: "invalid_grant" }, 400);
        return;
      }
      this.#codes.delete(code);
    }
    const requested = authorization?.searchParams.get("scope") ?? params.get("scope") ?? "basic";
    const scope = this.controls.issuedScope === undefined ? requested : this.controls.issuedScope;
    const token = `issued-${this.exchanges.length}`;
    this.#tokens.set(token, scope ?? "basic");
    const sendToken = () => {
      json(response, {
        access_token: token,
        token_type: "Bearer",
        expires_in: 3600,
        ...(scope !== null ? { scope } : {}),
        ...(this.controls.refresh ? { refresh_token: "refresh-basic" } : {}),
      });
    };
    if (this.controls.holdToken) {
      this.controls.releaseToken = sendToken;
    } else {
      sendToken();
    }
  }

  #challenge(response: ServerResponse, status: number): void {
    const permission =
      this.controls.requiredScope === undefined ? "" : `scope="${this.controls.requiredScope}", `;
    response
      .writeHead(status, {
        "www-authenticate": `Bearer ${status === 403 ? `error="insufficient_scope", ${permission}` : 'scope="basic", '}resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
      })
      .end();
  }

  #rejectWrite(
    request: IncomingMessage,
    response: ServerResponse,
    token: string | undefined,
  ): boolean {
    if ((token === undefined || token === "") && this.controls.holdAnonymous) {
      this.controls.holdAnonymous = false;
      this.controls.anonymousHeld = true;
      this.controls.releaseAnonymous = () => {
        this.#challenge(response, this.controls.challengeStatus);
      };
      return true;
    }
    if (this.controls.genericForbidden) {
      response.writeHead(403).end("Forbidden");
      return true;
    }
    const status = this.controls.toolStatuses.shift();
    if (status === 0) {
      request.socket.destroy();
      return true;
    }
    if (status === 401 || status === 403) {
      this.#challenge(response, status);
      return true;
    }
    if (status !== undefined) {
      response.writeHead(status).end("fixture failure");
      return true;
    }
    return false;
  }

  #mcp(body: JSONRPCRequest, request: IncomingMessage, response: ServerResponse): void {
    const method = body.method;
    const paramName = body.params?.name;
    let name = typeof paramName === "string" ? paramName : undefined;
    if (method === "tools/call") {
      name = CallToolRequestSchema.parse(body).params.name;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    this.requests.push({ method, token, name });
    if (this.#interceptMcp(method, response)) {
      return;
    }
    const isWrite = method === "tools/call" && name === "write";
    if (isWrite && this.#rejectWrite(request, response, token)) {
      return;
    }
    if (this.#rejectProtected(method, response, token)) {
      return;
    }
    if (isWrite && !scopes(this.#tokens.get(token ?? "")).includes(this.controls.accessScope)) {
      this.#challenge(
        response,
        token !== undefined && token !== "" ? 403 : this.controls.challengeStatus,
      );
      return;
    }
    this.#replyMcp(body, response, name);
  }

  #interceptMcp(method: string, response: ServerResponse): boolean {
    const failure = this.controls.catalogFailure;
    if (failure !== undefined && method === failure.method) {
      response.writeHead(failure.status).end("catalog unavailable");
      return true;
    }
    if (method === "resources/read" && this.controls.holdResource) {
      this.controls.resourceHeld = true;
      this.controls.rejectResource = () => {
        this.#challenge(response, 403);
      };
      return true;
    }
    return false;
  }

  #rejectProtected(method: string, response: ServerResponse, token: string | undefined): boolean {
    if (
      method === this.controls.protectedMethod &&
      (!this.#tokens.has(token ?? "") ||
        (this.controls.protectScope && !scopes(this.#tokens.get(token ?? "")).includes("write")))
    ) {
      this.#challenge(
        response,
        token !== undefined && token !== "" && this.controls.protectScope
          ? 403
          : this.controls.challengeStatus,
      );
      return true;
    }
    return false;
  }

  #result(
    body: JSONRPCRequest,
    response: ServerResponse,
    value: object,
    headers: OutgoingHttpHeaders = {},
  ): void {
    response.writeHead(200, { "content-type": "application/json", ...headers }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { ...(this.#era === "modern" ? { resultType: "complete" } : {}), ...value },
      }),
    );
  }

  #replyMcp(body: JSONRPCRequest, response: ServerResponse, name: string | undefined): void {
    const method = body.method;
    const capabilities = {
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true },
    };
    const catalog = this.#era === "modern" ? { ttlMs: 10000, cacheScope: "private" } : {};
    if (this.controls.holdDiscovery && ["server/discover", "initialize"].includes(method)) {
      this.controls.discoveryHeld = true;
      return;
    }
    if (this.controls.holdCatalog && method === "tools/list") {
      this.controls.catalogHeld = true;
      this.controls.releaseCatalog = () => {
        this.#result(body, response, { tools: recoveryTools, ...catalog });
      };
      return;
    }
    switch (method) {
      case "server/discover":
        this.#result(body, response, { supportedVersions: ["2026-07-28"], capabilities });
        break;
      case "initialize":
        this.#result(
          body,
          response,
          {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "recovery", version: "1" },
            capabilities,
          },
          { "mcp-session-id": `session-${++this.#sessions}` },
        );
        break;
      case "tools/list":
        this.#result(body, response, { tools: recoveryTools, ...catalog });
        break;
      case "resources/list":
        this.#result(body, response, {
          resources: [{ name: "document", uri: "test://document" }],
          ...catalog,
        });
        break;
      case "prompts/list":
        this.#result(body, response, { prompts: [{ name: "prompt" }], ...catalog });
        break;
      case "tools/call":
        assert(name !== undefined);
        this.#callTool(body, response, name);
        break;
      case "prompts/get":
        this.#result(body, response, {
          messages: [{ role: "user", content: { type: "text", text: "prompt" } }],
        });
        break;
      case "resources/read":
        this.#result(body, response, { contents: [{ uri: "test://document", text: "document" }] });
        break;
      default:
        json(response, { error: "unexpected request" }, 500);
    }
  }

  #callTool(body: JSONRPCRequest, response: ServerResponse, name: string): void {
    if (name === "effect") {
      this.controls.effectCount++;
      if (this.controls.holdEffect) {
        response.writeHead(200, { "content-type": "application/json", "x-accepted-effect": "yes" });
        response.write(`{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":`);
        this.controls.releaseEffect = () => {
          response.end(
            `${JSON.stringify({ ...(this.#era === "modern" ? { resultType: "complete" } : {}), ...content("effect") })}}`,
          );
        };
        return;
      }
    }
    this.#result(body, response, content(name));
  }
}
