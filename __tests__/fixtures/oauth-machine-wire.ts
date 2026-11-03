import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ClientCapabilitiesSchema,
  DiscoverRequestSchema,
  InitializeRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  OAuthClientInformationSchema,
  OAuthClientMetadataSchema,
  type JSONObjectSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod";

export const machineMessageSchema = JSONRPCRequestSchema.or(JSONRPCNotificationSchema);
export type MachineMessage = z.infer<typeof machineMessageSchema>;

export function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = form.get(name);
  assert(value !== null, `Missing OAuth fixture parameter: ${name}`);
  return value;
}

export function machineResult(
  method: string,
  name: string,
  text: string,
): z.infer<typeof JSONObjectSchema> {
  switch (method) {
    case "initialize":
      return {
        resultType: "complete",
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1" },
      };
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      };
    case "tools/list":
      return {
        resultType: "complete",
        ttlMs: 10000,
        cacheScope: "private",
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      };
    default:
      return { resultType: "complete", content: [{ type: "text", text }] };
  }
}

// The SDK's registration schema leaves jwks as any. Validate the public key
// used by these fixtures; Node crypto remains responsible for key validity.
const publicKeySchema = z.discriminatedUnion("kty", [
  z.object({ kty: z.literal("EC"), crv: z.string(), x: z.string(), y: z.string() }),
  z.object({ kty: z.literal("RSA"), n: z.string(), e: z.string() }),
  z.object({ kty: z.literal("OKP"), crv: z.string(), x: z.string() }),
]);
export const machineDocumentSchema = OAuthClientInformationSchema.pick({ client_id: true }).extend({
  token_endpoint_auth_method: OAuthClientMetadataSchema.shape.token_endpoint_auth_method,
  jwks: z.object({ keys: z.array(publicKeySchema) }),
});
export const jwtClaimsSchema = z.looseObject({ iss: z.string(), sub: z.string(), aud: z.string() });
export const privateKeyClaimsSchema = jwtClaimsSchema.extend({
  iat: z.number(),
  exp: z.number(),
  jti: z.string(),
});
const jwtHeaderSchema = z.looseObject({
  alg: z.string(),
  typ: z.string(),
  kid: z.string().optional(),
});

export function decodeJwt(token: string): {
  input: Buffer;
  signature: Buffer;
  header: z.infer<typeof jwtHeaderSchema>;
  payload: unknown;
} {
  const [header, payload, signature] = z
    .tuple([z.string(), z.string(), z.string()])
    .parse(token.split("."));
  return {
    input: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, "base64url"),
    header: jwtHeaderSchema.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

export function clientCapabilities(
  message: MachineMessage,
  protocol: "auto" | "legacy" = "auto",
): z.infer<typeof ClientCapabilitiesSchema> | undefined {
  if (protocol === "legacy") {
    return InitializeRequestSchema.parse(message).params.capabilities;
  }
  const request = DiscoverRequestSchema.pick({ params: true }).parse(message);
  return ClientCapabilitiesSchema.optional().parse(
    request.params?._meta?.["io.modelcontextprotocol/clientCapabilities"],
  );
}

export async function readMachineBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    assert(Buffer.isBuffer(value));
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function machineJson(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
}

/** Own async request errors and verify them when closing the real HTTP server. */
export class MachineHttpServer {
  origin = "";
  readonly #errors: unknown[] = [];
  readonly #server;

  constructor(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
    this.#server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        this.#errors.push(error);
        response.destroy();
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    assert(address !== null && typeof address !== "string", "Fixture did not bind");
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
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
    assert.deepEqual(this.#errors, [], "Machine OAuth fixture request handler failed");
  }
}
