import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  OAuthClientInformationSchema,
  OAuthClientMetadataSchema,
  type JSONObjectSchema,
} from "@modelcontextprotocol/core";
import type { z } from "zod";
import metadataDocument from "../../docs/client-metadata.json" with { type: "json" };
import {
  authenticate,
  completeAuthFromInput,
  createOAuthRuntime,
  shutdownOAuth,
  startAuth,
} from "../../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl } from "../../mcp-auth.ts";
import { ensureCallbackServer } from "../../mcp-callback-server.ts";
import { getOAuthCallbackPort } from "../../mcp-oauth-provider.ts";
import { McpServerManager } from "../../server-manager.ts";
import type { OAuthConfig, ServerEntry } from "../../types.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  readMachineBody,
  requiredFormValue,
} from "./oauth-machine-wire.ts";

const clientDocumentSchema = OAuthClientMetadataSchema.extend({
  grant_types: OAuthClientMetadataSchema.shape.grant_types.unwrap(),
  client_id: OAuthClientInformationSchema.shape.client_id.optional(),
});

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function callbackUri(template = "http://127.0.0.1:PORT/callback"): Promise<string> {
  const url = new URL(template.replace("PORT", "40001"));
  await ensureCallbackServer({
    callbackHost: url.hostname === "[::1]" ? "::1" : url.hostname,
    callbackPath: url.pathname,
  });
  return template.replace("PORT", String(getOAuthCallbackPort()));
}

function allowsRedirect(document: z.infer<typeof clientDocumentSchema>, callback: URL): boolean {
  return document.redirect_uris.some((uri) => {
    const saved = new URL(uri);
    return (
      saved.protocol === callback.protocol &&
      saved.hostname === callback.hostname &&
      saved.pathname === callback.pathname &&
      saved.search === callback.search &&
      (saved.port === callback.port ||
        (document.application_type === "native" &&
          saved.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(saved.hostname)))
    );
  });
}

function mcpResult(method: string): z.infer<typeof JSONObjectSchema> {
  switch (method) {
    case "server/discover":
      return { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } };
    case "tools/list":
      return {
        ttlMs: 10000,
        cacheScope: "private",
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      };
    case "resources/list":
      return {
        ttlMs: 10000,
        cacheScope: "private",
        resources: [{ name: "document", uri: "test://document" }],
      };
    case "resources/read":
      return {
        ttlMs: 10000,
        cacheScope: "private",
        contents: [{ uri: "test://document", text: "authorized resource" }],
      };
    default:
      return { content: [{ type: "text", text: "authorized tool" }] };
  }
}

export class CimdFixture {
  readonly name = `cimd-${crypto.randomUUID()}`;
  readonly manager = new McpServerManager();
  readonly definition: ServerEntry & { url: string };
  readonly documents = new Map<string, unknown>([[metadataDocument.client_id, metadataDocument]]);
  readonly registered = new Map<string, z.infer<typeof clientDocumentSchema>>();
  readonly authorizations: URL[] = [];
  readonly exchanges: URLSearchParams[] = [];
  readonly documentFetches: string[] = [];
  readonly blockedPorts: number[] = [];
  readonly registrations: unknown[] = [];
  readonly requests: Array<{ method: string; token: string | undefined }> = [];
  readonly metadata: Record<string, unknown> = {
    client_id_metadata_document_supported: true,
  };
  readonly #codes = new Map<string, URL>();
  readonly #refreshes = new Map<string, string>();
  readonly #tokens = new Set<string>();
  readonly #blockers: Server[] = [];
  readonly #http = new MachineHttpServer((request, response) =>
    this.#handleRequest(request, response),
  );
  #runtime = createOAuthRuntime();

  constructor(oauth: OAuthConfig = {}) {
    this.definition = { url: "", auth: "oauth", oauth };
    this.manager.setOAuthRuntime(this.#runtime);
  }

  get origin(): string {
    return this.#http.origin;
  }

  async listen(): Promise<void> {
    this.definition.url = `${await this.#http.listen()}/mcp`;
  }

  start(): ReturnType<typeof startAuth> {
    return startAuth(this.name, this.definition.url, this.definition, { runtime: this.#runtime });
  }

  complete(callback: string): ReturnType<typeof completeAuthFromInput> {
    return completeAuthFromInput(this.name, callback, { runtime: this.#runtime });
  }

  async authorize(authorizationUrl: string): Promise<string> {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    assert.equal(response.status, 302);
    const callback = response.headers.get("location");
    assert(callback !== null, "Authorization response needs a callback");
    return callback;
  }

  stored(): ReturnType<typeof getAuthForUrl> {
    return getAuthForUrl(this.name, this.definition.url);
  }

  login(): ReturnType<typeof authenticate> {
    return authenticate(this.name, this.definition.url, this.definition, {
      runtime: this.#runtime,
      onAuthorizationUrl() {
        // The browser mock follows the real authorization and callback HTTP endpoints.
      },
    });
  }

  expire(): void {
    this.#tokens.clear();
  }

  async restart(): Promise<number> {
    const oldPort = getOAuthCallbackPort();
    const authorization = this.authorizations.at(-1);
    assert(authorization !== undefined, "Restart requires a completed authorization");
    const host = new URL(requiredFormValue(authorization.searchParams, "redirect_uri")).hostname;
    await this.manager.closeAll();
    await shutdownOAuth(this.#runtime);
    const blocker = createServer();
    await listen(blocker, oldPort, host === "[::1]" ? "::1" : host);
    this.blockedPorts.push(oldPort);
    this.#blockers.push(blocker);
    this.#runtime = createOAuthRuntime();
    this.manager.setOAuthRuntime(this.#runtime);
    return oldPort;
  }

  connect(): ReturnType<McpServerManager["connect"]> {
    return this.manager.connect(this.name, this.definition);
  }

  async close(test: string | undefined): Promise<void> {
    for (const blocker of this.#blockers.toReversed()) {
      await close(blocker);
    }
    const proofFile = process.env.CIMD_PROOF_FILE;
    if (proofFile !== undefined && proofFile !== "") {
      appendFileSync(
        proofFile,
        `${JSON.stringify({
          test,
          node: process.version,
          execPath: process.execPath,
          authorizations: this.authorizations.map((url) => Object.fromEntries(url.searchParams)),
          exchanges: this.exchanges.map((params) => Object.fromEntries(params)),
          documentFetches: this.documentFetches,
          blockedPorts: this.blockedPorts,
          callbackPort: getOAuthCallbackPort(),
          registrations: this.registrations,
          requests: this.requests,
          stored: this.stored(),
        })}\n`,
      );
    }
    await this.manager.closeAll();
    await shutdownOAuth(this.#runtime);
    clearAllCredentials(this.name);
    await this.#http.close();
  }

  // Only this authorization server resolves the local mapping. client_id stays HTTPS.
  async #client(id: string): Promise<z.infer<typeof clientDocumentSchema> | undefined> {
    const registered = this.registered.get(id);
    if (registered !== undefined) {
      return registered;
    }
    const response = await fetch(`${this.origin}/document?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      return;
    }
    const parsed = clientDocumentSchema.safeParse(await response.json());
    if (
      parsed.success &&
      parsed.data.client_id === id &&
      parsed.data.token_endpoint_auth_method === "none"
    ) {
      return parsed.data;
    }
    return;
  }

  async #authorize(url: URL, response: ServerResponse): Promise<void> {
    this.authorizations.push(url);
    const document = await this.#client(requiredFormValue(url.searchParams, "client_id"));
    const callback = new URL(requiredFormValue(url.searchParams, "redirect_uri"));
    const allowed = document !== undefined && allowsRedirect(document, callback);
    callback.searchParams.set("state", requiredFormValue(url.searchParams, "state"));
    callback.searchParams.set("iss", this.origin);
    if (!allowed) {
      callback.searchParams.set("error", "invalid_client_metadata");
    } else {
      const code = `code-${this.authorizations.length}`;
      this.#codes.set(code, url);
      callback.searchParams.set("code", code);
    }
    response.writeHead(302, { location: callback.href }).end();
  }

  #consumeCode(params: URLSearchParams, id: string): boolean {
    const code = requiredFormValue(params, "code");
    const authorization = this.#codes.get(code);
    const challenge = createHash("sha256")
      .update(params.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      authorization === undefined ||
      authorization.searchParams.get("client_id") !== id ||
      authorization.searchParams.get("code_challenge") !== challenge ||
      authorization.searchParams.get("redirect_uri") !== params.get("redirect_uri")
    ) {
      return false;
    }
    this.#codes.delete(code);
    return true;
  }

  async #token(data: string, response: ServerResponse): Promise<void> {
    const params = new URLSearchParams(data);
    this.exchanges.push(params);
    const id = requiredFormValue(params, "client_id");
    const document = await this.#client(id);
    if (document === undefined) {
      machineJson(response, { error: "invalid_client" }, 400);
      return;
    }
    const grant = requiredFormValue(params, "grant_type");
    if (!document.grant_types.includes(grant) || params.get("resource") !== `${this.origin}/mcp`) {
      machineJson(response, { error: "invalid_request" }, 400);
      return;
    }
    if (
      (grant === "authorization_code" && !this.#consumeCode(params, id)) ||
      (grant === "refresh_token" &&
        this.#refreshes.get(requiredFormValue(params, "refresh_token")) !== id)
    ) {
      machineJson(response, { error: "invalid_grant" }, 400);
      return;
    }
    const token = `access-${this.exchanges.length}`;
    const refresh = `refresh-${this.exchanges.length}`;
    this.#tokens.add(token);
    this.#refreshes.set(refresh, id);
    machineJson(response, {
      access_token: token,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "tools",
    });
  }

  #mcp(data: string, request: IncomingMessage, response: ServerResponse): void {
    const message = machineMessageSchema.parse(JSON.parse(data));
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    this.requests.push({ method: message.method, token });
    if (!this.#tokens.has(token ?? "")) {
      response
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
    }
    machineJson(response, {
      jsonrpc: "2.0",
      id: "id" in message ? message.id : undefined,
      result: { resultType: "complete", ...mcpResult(message.method) },
    });
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      machineJson(response, {
        resource: `${this.origin}/mcp`,
        authorization_servers: [this.origin],
        scopes_supported: ["tools"],
      });
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      machineJson(response, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        ...this.metadata,
      });
      return;
    }
    if (url.pathname === "/document") {
      const id = requiredFormValue(url.searchParams, "id");
      this.documentFetches.push(id);
      const document = this.documents.get(id);
      machineJson(
        response,
        document ?? { error: "unavailable" },
        document === null || document === undefined ? 503 : 200,
      );
      return;
    }
    if (url.pathname === "/authorize") {
      await this.#authorize(url, response);
      return;
    }
    const data = await readMachineBody(request);
    if (url.pathname === "/register") {
      const document: unknown = JSON.parse(data);
      const metadata = clientDocumentSchema.parse(document);
      this.registrations.push(document);
      const id = `https://opaque.example/registration/${this.registrations.length}`;
      this.registered.set(id, metadata);
      machineJson(response, { ...metadata, client_id: id }, 201);
      return;
    }
    if (url.pathname === "/token") {
      await this.#token(data, response);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    this.#mcp(data, request, response);
  }
}
