import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { constants, createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  auth,
  OAuthError,
  OAuthErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  completeAuthFromInput,
  createOAuthRuntime,
  extractOAuthConfig,
  shutdownOAuth,
  startAuth,
} from "../mcp-auth-flow.ts";
import { clearAllCredentials, getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { ensureCallbackServer } from "../mcp-callback-server.ts";
import { getOAuthCallbackPort, McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { McpServerManager } from "../server-manager.ts";
import sharedDocument from "../docs/client-metadata.json" with { type: "json" };
import type { OAuthConfig, ServerEntry } from "../types.ts";
import {
  clientCapabilities,
  decodeJwt,
  machineDocumentSchema,
  machineMessageSchema,
  machineResult,
  MachineHttpServer,
  machineJson,
  privateKeyClaimsSchema,
  readMachineBody,
  requiredFormValue,
  type MachineMessage,
} from "./fixtures/oauth-machine-wire.ts";

const browser = vi.hoisted(() => ({ open: vi.fn<() => void>() }));
vi.mock("open", () => ({ default: browser.open }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
  browser.open.mockReset();
});
function key(algorithm = "ES256") {
  let pair: ReturnType<typeof generateKeyPairSync>;
  if (algorithm.startsWith("Ed")) {
    pair = generateKeyPairSync("ed25519");
  } else if (algorithm.startsWith("ES")) {
    pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  } else {
    pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  }
  return {
    pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: pair.privateKey.export({ format: "jwk" }),
    publicJwk: pair.publicKey.export({ format: "jwk" }),
    algorithm,
  };
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pi-jwt-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Claims = z.infer<typeof privateKeyClaimsSchema>;
type SigningFixtureConfig = Omit<OAuthConfig, "privateKeyJwt"> & {
  privateKeyJwt?: OAuthConfig["privateKeyJwt"];
};
async function fixture(config: SigningFixtureConfig = {}, pair = key()) {
  const name = `jwt-${crypto.randomUUID()}`;
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  manager.setOAuthRuntime(runtime);
  const id =
    config.clientId ??
    (typeof config.clientMetadataUrl === "string"
      ? config.clientMetadataUrl
      : "configured-jwt-client");
  const { privateKeyJwt, ...options } = config;
  const signing =
    "privateKeyJwt" in config ? privateKeyJwt : { privateKey: pair.pem, algorithm: pair.algorithm };
  const oauth: OAuthConfig = {
    clientId: id,
    grantType: "client_credentials",
    ...options,
    ...(signing === undefined ? {} : { privateKeyJwt: signing }),
  };
  if (
    typeof config.clientMetadataUrl === "string" &&
    config.clientMetadataUrl !== "" &&
    config.clientId === undefined
  ) {
    delete oauth.clientId;
  }
  let origin = "";
  let verificationKey = pair.publicJwk;
  let issuer: string | undefined;
  let publicMcp = false;
  const exchanges: Array<{
    params: URLSearchParams;
    authorization?: string | undefined;
    claims?: Claims;
    header?: Record<string, unknown>;
  }> = [];
  const requests: MachineMessage[] = [];
  const authorizations: URL[] = [];
  const documentFetches: string[] = [];
  const registrations: object[] = [];
  const codes = new Map<string, URL>();
  const refreshes = new Set<string>();
  const tokens = new Set<string>();
  function metadata(url: URL, res: ServerResponse): boolean {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      machineJson(res, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["tools"],
      });
      return true;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      machineJson(res, {
        issuer: issuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
        token_endpoint_auth_signing_alg_values_supported: [pair.algorithm],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      });
      return true;
    }
    // The AS hosts this document. The adapter never fetches the HTTPS client_id.
    if (url.pathname === "/document") {
      documentFetches.push(requiredFormValue(url.searchParams, "id"));
      machineJson(res, {
        client_id: id,
        token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [verificationKey] },
      });
      return true;
    }
    if (url.pathname !== "/authorize") {
      return false;
    }
    authorizations.push(url);
    const callback = new URL(requiredFormValue(url.searchParams, "redirect_uri"));
    const code = `code-${authorizations.length}`;
    codes.set(code, url);
    callback.searchParams.set("state", requiredFormValue(url.searchParams, "state"));
    callback.searchParams.set("iss", origin);
    callback.searchParams.set("code", code);
    res.writeHead(302, { location: callback.href }).end();
    return true;
  }
  async function publicKey(params: URLSearchParams) {
    if (!id.startsWith("https:")) {
      return createPublicKey({ key: verificationKey, format: "jwk" });
    }
    const doc = machineDocumentSchema.parse(
      await (
        await fetch(
          `${origin}/document?id=${encodeURIComponent(requiredFormValue(params, "client_id"))}`,
        )
      ).json(),
    );
    assert.equal(doc.client_id, params.get("client_id"));
    assert.equal(doc.token_endpoint_auth_method, "private_key_jwt");
    const first = doc.jwks.keys[0];
    assert(first !== undefined);
    return createPublicKey({ key: first, format: "jwk" });
  }
  async function recordAndValidateAssertion(
    params: URLSearchParams,
    authorization: string | undefined,
  ) {
    const exchange: (typeof exchanges)[number] = { params, authorization };
    exchanges.push(exchange);
    if (!oauth.privateKeyJwt) {
      assert.deepEqual(
        {
          id: params.get("client_id"),
          assertion: params.has("client_assertion"),
          secret: params.has("client_secret"),
        },
        { id, assertion: false, secret: false },
      );
      return;
    }
    const decoded = decodeJwt(requiredFormValue(params, "client_assertion"));
    const header = decoded.header;
    const claims = privateKeyClaimsSchema.parse(decoded.payload);
    exchange.header = header;
    exchange.claims = claims;
    const valid = verify(
      pair.algorithm.startsWith("Ed") ? null : "sha256",
      decoded.input,
      {
        key: await publicKey(params),
        dsaEncoding: "ieee-p1363",
        ...(pair.algorithm.startsWith("PS")
          ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
          : {}),
      },
      decoded.signature,
    );
    assert(valid, "fixture JWT signature");
    assert(claims.exp > Date.now() / 1000, "fixture JWT expiry");
    assert.deepEqual(
      {
        algorithm: header.alg,
        type: header.typ,
        kid: header.kid,
        issuer: claims.iss,
        subject: claims.sub,
        audience: claims.aud,
        client: params.get("client_id"),
        resource: params.get("resource"),
        secret: params.has("client_secret"),
        authorization,
        assertionType: params.get("client_assertion_type"),
      },
      {
        algorithm: pair.algorithm,
        type: "JWT",
        kid: undefined,
        issuer: id,
        subject: id,
        audience: oauth.privateKeyJwt.audience ?? origin,
        client: id,
        resource: `${origin}/mcp`,
        secret: false,
        authorization: undefined,
        assertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      },
    );
  }
  function validateGrant(params: URLSearchParams) {
    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      const authorization = codes.get(requiredFormValue(params, "code"));
      assert(authorization !== undefined, "fixture authorization code");
      assert.equal(authorization.searchParams.get("client_id"), id);
      assert.equal(
        authorization.searchParams.get("code_challenge"),
        createHash("sha256").update(requiredFormValue(params, "code_verifier")).digest("base64url"),
      );
      assert.equal(authorization.searchParams.get("redirect_uri"), params.get("redirect_uri"));
    } else if (grant === "refresh_token") {
      assert(refreshes.has(requiredFormValue(params, "refresh_token")), "fixture refresh token");
    } else {
      assert.equal(grant, "client_credentials");
    }
  }
  const server = new MachineHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (metadata(url, res)) {
      return;
    }
    const data = await readMachineBody(req);
    if (url.pathname === "/register") {
      registrations.push(z.record(z.string(), z.unknown()).parse(JSON.parse(data)));
      machineJson(res, { error: "registration_not_supported" }, 400);
      return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(data);
      try {
        await recordAndValidateAssertion(params, req.headers.authorization);
        validateGrant(params);
      } catch {
        machineJson(
          res,
          { error: "invalid_request", error_description: "fixture rejected client assertion" },
          400,
        );
        return;
      }
      const accessToken = `access-${exchanges.length}`;
      const refreshToken = `refresh-${exchanges.length}`;
      tokens.add(accessToken);
      refreshes.add(refreshToken);
      machineJson(res, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "tools",
      });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const message = machineMessageSchema.parse(JSON.parse(data));
    requests.push(message);
    if (!publicMcp && !tokens.has(req.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
      res
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    assert("id" in message, "Expected an MCP request");
    machineJson(res, {
      jsonrpc: "2.0",
      id: message.id,
      result: machineResult(message.method, "jwt", "signed tool"),
    });
  });
  origin = await server.listen();
  const definition: ServerEntry & { url: string } = { url: `${origin}/mcp`, auth: "oauth", oauth };
  const start = () => startAuth(name, definition.url, definition, { runtime });
  const stored = () => getAuthForUrl(name, definition.url);
  cleanups.push(async () => {
    const testName = expect.getState().currentTestName;
    if (process.env.JWT_PROOF_FILE !== undefined) {
      appendFileSync(
        process.env.JWT_PROOF_FILE,
        `${JSON.stringify({
          test: testName,
          node: process.version,
          execPath: process.execPath,
          exchanges: exchanges.map((e) => ({
            grant: e.params.get("grant_type"),
            claims: e.claims,
            header: e.header,
            hasSecret: e.params.has("client_secret"),
            hasBasic: e.authorization !== undefined,
          })),
          requests,
          authorizations: authorizations.length,
          documentFetches,
          registrations: registrations.length,
        })}\n`,
      );
    }
    await manager.closeAll();
    await shutdownOAuth(runtime);
    clearAllCredentials(name);
    await server.close();
  });
  if (oauth.grantType === "authorization_code" && oauth.redirectUri === undefined) {
    await ensureCallbackServer({ callbackHost: "127.0.0.1", callbackPath: "/callback" });
    oauth.redirectUri = `http://127.0.0.1:${getOAuthCallbackPort()}/callback`;
  }
  return {
    name,
    origin,
    pair,
    id,
    definition,
    oauth,
    runtime,
    manager,
    exchanges,
    requests,
    authorizations,
    registrations,
    documentFetches,
    stored,
    start,
    provider: (signal?: AbortSignal) =>
      new McpOAuthProvider(
        name,
        definition.url,
        extractOAuthConfig(definition),
        {
          onRedirect: () => {
            browser.open();
          },
        },
        {},
        signal,
        "fixture-state",
      ),
    rotate: (next: ReturnType<typeof key>) => {
      verificationKey = next.publicJwk;
    },
    changeIssuer: (next: string) => {
      issuer = next;
    },
    publicMcp: () => {
      publicMcp = true;
    },
    expire: () => tokens.clear(),
    connect: () => manager.connect(name, definition),
    login: async () => {
      const { authorizationUrl } = await start();
      const location = (await fetch(authorizationUrl, { redirect: "manual" })).headers.get(
        "location",
      );
      assert(location !== null);
      expect((await fetch(location)).status).toBe(200);
      expect(await completeAuthFromInput(name, location, { runtime })).toBe("authenticated");
    },
  };
}

function holdNativeSigning(
  transport: Pick<StreamableHTTPClientTransport, "send"> = StreamableHTTPClientTransport.prototype,
) {
  const events: string[] = [];
  const sends = new Set<Promise<void>>();
  let began!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  const signer = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    events.push("sign-start");
    began();
    await gate;
    const signature = await sign(...args);
    events.push("sign-finished");
    return signature;
  });
  const send = transport.send;
  const sender = vi.spyOn(transport, "send").mockImplementation(async function (
    this: StreamableHTTPClientTransport,
    ...args
  ) {
    events.push("native-send-start");
    const pending = send.apply(this, args);
    sends.add(pending);
    try {
      await pending;
    } finally {
      sends.delete(pending);
      events.push("native-send-settled");
    }
  });
  return {
    started,
    events,
    pending: () => sends.size,
    finish: async () => {
      release();
      // Public connect/call promises may reject before the detached native auth exchange finishes.
      while (sends.size > 0) {
        await Promise.allSettled(sends);
      }
    },
    restore: () => {
      sender.mockRestore();
      signer.mockRestore();
    },
  };
}

it.each(["ES256", "RS256", "PS256", "EdDSA", "Ed25519"])(
  "authenticates native %s signatures then uses the MCP tool",
  async (algorithm) => {
    const pair = key(algorithm);
    pair.jwk.kid = "fixture-kid";
    const f = await fixture(
      {
        privateKeyJwt: { privateKey: algorithm.startsWith("Ed") ? pair.jwk : pair.pem, algorithm },
      },
      pair,
    );
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect((await f.connect()).status).toBe("connected");
    expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({
      content: [{ text: "signed tool" }],
    });
    const first = f.exchanges[0];
    assert(first?.claims !== undefined);
    const { claims, params } = first;
    expect(claims).toMatchObject({ iss: f.id, sub: f.id, aud: f.origin });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.jti).toBeTruthy();
    expect(params.get("scope")).toBe("tools");
    expect(f.registrations).toHaveLength(0);
    expect(f.authorizations).toHaveLength(0);
    expect(JSON.stringify(f.stored())).not.toContain(pair.pem);
    expect(JSON.stringify(f.stored())).not.toContain(pair.jwk.d);
    expect(JSON.stringify(f.stored())).not.toContain(params.get("client_assertion"));
  },
);

it.each(["PEM", "JWK"])(
  "resolves a %s command afresh after test-key rotation, with SDK-owned claims",
  async (format) => {
    const dir = scratch(),
      file = join(dir, "key"),
      counter = join(dir, "reads");
    const pair = key();
    writeFileSync(file, format === "PEM" ? pair.pem : JSON.stringify(pair.jwk));
    const f = await fixture(
      {
        privateKeyJwt: {
          privateKey: `!printf x >> '${counter}'; cat '${file}'`,
          algorithm: "ES256",
          audience: "urn:jwt-audience",
          lifetimeSeconds: 90,
          claims: {
            role: "test",
            iss: "wrong",
            sub: "wrong",
            aud: "wrong",
            iat: 1,
            exp: 2,
            jti: "wrong",
          },
        },
      },
      pair,
    );
    const provider = f.provider();
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(JSON.stringify(provider.clientMetadata)).not.toContain(file);
    expect(extractOAuthConfig(f.definition).privateKeyJwt?.privateKey).toBe(
      f.oauth.privateKeyJwt?.privateKey,
    );
    await provider.clientInformation();
    void provider.clientMetadata;
    expect(existsSync(counter)).toBe(false);
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    const next = key();
    f.rotate(next);
    writeFileSync(file, format === "PEM" ? next.pem : JSON.stringify(next.jwk));
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(readFileSync(counter, "utf8")).toBe("xx");
    const [first, second] = f.exchanges;
    assert(first !== undefined && second !== undefined);
    expect(first.params.get("client_assertion")).not.toBe(second.params.get("client_assertion"));
    for (const { claims } of f.exchanges) {
      expect(claims).toMatchObject({ iss: f.id, sub: f.id, aud: "urn:jwt-audience", role: "test" });
      assert(claims !== undefined);
      expect(claims.exp - claims.iat).toBe(90);
      expect(claims.jti).not.toBe("wrong");
      expect(claims.iat).toBeGreaterThan(2);
    }
  },
);

it.each(["${JWT_TEST_KEY}", "$env:JWT_TEST_KEY", "{env:JWT_TEST_KEY}"])(
  "resolves JWK environment source %s only at authentication",
  async (source) => {
    const pair = key();
    const f = await fixture(
      { privateKeyJwt: { privateKey: source, algorithm: pair.algorithm } },
      pair,
    );
    const provider = f.provider();
    expect(extractOAuthConfig(f.definition).privateKeyJwt?.privateKey).toBe(source);
    process.env.JWT_TEST_KEY = JSON.stringify(pair.jwk);
    try {
      expect(await auth(provider, { serverUrl: f.definition.url })).toBe("AUTHORIZED");
    } finally {
      delete process.env.JWT_TEST_KEY;
    }
  },
);

it.each([false, true])("signs browser PKCE and refresh with custom document=%s", async (custom) => {
  const f = await fixture({
    grantType: "authorization_code",
    ...(custom ? { clientMetadataUrl: "https://jwt.example/client.json" } : {}),
  });
  await f.login();
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.exchanges.map((e) => e.params.get("grant_type"))).toEqual([
    "authorization_code",
    "refresh_token",
  ]);
  expect(f.exchanges.every((e) => e.claims?.iss === f.id && e.claims.sub === f.id)).toBe(true);
  expect(f.authorizations).toHaveLength(1);
  expect(f.registrations).toHaveLength(0);
  expect(f.documentFetches).toHaveLength(custom ? 2 : 0);
  expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({
    content: [{ text: "signed tool" }],
  });
});

it("round-trips private-key custom CIMD client_credentials without the shared document", async () => {
  const f = await fixture({ clientMetadataUrl: "https://jwt.example/machine.json" });
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  f.oauth.clientMetadataUrl = "https://jwt.example/changed.json";
  expect(await f.start()).toEqual({ authorizationUrl: "" });
  expect(f.stored()?.clientInfo).toMatchObject({
    clientId: f.id,
    registrationType: "cimd",
    redirectUris: [],
  });
  expect(f.exchanges.every((e) => e.claims?.iss === f.id)).toBe(true);
  expect(f.documentFetches).toEqual([f.id, f.id]);
  expect(f.registrations).toHaveLength(0);
});

it.each([
  [
    "!printf 'COMMAND_SECRET_SENTINEL' >&2; exit 7",
    ["privateKeyJwt", "command exited with code 7"],
  ],
  ["!true", ["privateKeyJwt", "command returned empty output"]],
  ["!printf '{PRIVATE_KEY_SENTINEL}'", ["privateKeyJwt"]],
  ["!printf 'PRIVATE_KEY_SENTINEL'", ["privateKeyJwt"]],
  ["!printf '[]'", ["privateKeyJwt"]],
  ["!printf 'COMMAND_SECRET_SENTINEL'\0", ["privateKeyJwt"]],
] as const)(
  "fails refresh privately without token request, consent or invalidation: case %#",
  async (source, messages) => {
    const f = await fixture({ grantType: "authorization_code" });
    await f.login();
    const before = f.stored();
    assert(f.oauth.privateKeyJwt !== undefined);
    f.oauth.privateKeyJwt.privateKey = source;
    const error = await f.start().catch((cause: unknown) => cause);
    assert(error instanceof OAuthError);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
    for (const message of messages) {
      expect(error.message).toContain(message);
    }
    expect(String(error)).not.toContain("SENTINEL");
    expect(error.cause).toBeUndefined();
    expect(f.exchanges).toHaveLength(1);
    expect(f.authorizations).toHaveLength(1);
    expect(f.stored()).toEqual(before);
    expect(browser.open).not.toHaveBeenCalled();
  },
);

it.each(["client", "tokens"])(
  "checks the stored %s issuer before resolving a key",
  async (binding) => {
    const dir = scratch(),
      marker = join(dir, "ran");
    const f = await fixture({
      privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" },
      skipIssuerMetadataValidation: true,
    });
    saveAuthEntry(
      f.name,
      {
        clientInfo: {
          clientId: f.id,
          configPreRegistered: true,
          issuer: binding === "client" ? "https://old.example" : f.origin,
        },
        tokens: {
          accessToken: "old",
          refreshToken: "old",
          issuer: binding === "tokens" ? "https://old.example" : f.origin,
        },
      },
      f.definition.url,
    );
    const before = f.stored();
    await expect(f.start()).rejects.toThrow("issuer changed");
    expect(existsSync(marker)).toBe(false);
    expect(f.exchanges).toHaveLength(0);
    expect(f.stored()).toEqual(before);
  },
);

it("retains strict discovered issuer validation on the new signing path", async () => {
  const dir = scratch(),
    marker = join(dir, "ran");
  const f = await fixture({
    privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" },
  });
  f.changeIssuer("https://wrong.example");
  await expect(f.start()).rejects.toThrow(/issuer/i);
  expect(existsSync(marker)).toBe(false);
  expect(f.exchanges).toHaveLength(0);
});

it.each(["abort", "deactivate"])(
  "stops native async signing on %s before any token request or write",
  async (stop) => {
    const f = await fixture();
    const controller = new AbortController();
    const provider = f.provider(controller.signal);
    const original = crypto.subtle.sign.bind(crypto.subtle);
    let began!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      began();
      await gate;
      return original(...args);
    });
    try {
      const pending = auth(provider, { serverUrl: f.definition.url }).catch(
        (error: unknown) => error,
      );
      await started;
      const before = f.stored();
      if (stop === "abort") {
        controller.abort();
      } else {
        provider.deactivate();
      }
      release();
      const error = await pending;
      assert(error instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(f.exchanges).toHaveLength(0);
      expect(f.stored()).toEqual(before);
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(0);
    } finally {
      release();
      spy.mockRestore();
    }
  },
);

it.each(["auto", "legacy"] as const)(
  "lets native %s encode configured client-credentials capabilities for ordinary and discovery clients",
  async (protocolVersion) => {
    const f = await fixture();
    f.definition.protocolVersion = protocolVersion;
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(await (await f.connect()).client.callTool({ name: "echo" })).toMatchObject({
      content: [{ text: "signed tool" }],
    });
    const handshakes = f.requests.filter(
      (r) => r.method === (protocolVersion === "auto" ? "server/discover" : "initialize"),
    );
    expect(handshakes.length).toBeGreaterThanOrEqual(2);
    for (const r of handshakes) {
      expect(clientCapabilities(r, protocolVersion)?.extensions).toEqual({
        "io.modelcontextprotocol/oauth-client-credentials": {},
      });
    }
  },
);

it.each([
  [false, undefined, false],
  ["bearer", undefined, false],
  [undefined, { "X-Fixture": "test" }, false],
  [undefined, undefined, true],
  ["oauth", { "X-Fixture": "test" }, true],
] as const)(
  "advertises ordinary machine auth only when OAuth is enabled: auth=%s headers=%j",
  async (authMode, headers, enabled) => {
    const f = await fixture();
    f.publicMcp();
    if (authMode === undefined) {
      delete f.definition.auth;
    } else {
      f.definition.auth = authMode;
    }
    if (headers === undefined) {
      delete f.definition.headers;
    } else {
      f.definition.headers = headers;
    }
    expect((await f.connect()).status).toBe("connected");
    const discover = f.requests.find((r) => r.method === "server/discover");
    assert(discover !== undefined);
    expect(clientCapabilities(discover)?.extensions).toEqual(
      enabled ? { "io.modelcontextprotocol/oauth-client-credentials": {} } : undefined,
    );
    expect(f.exchanges).toHaveLength(0);
  },
);

it("does not resolve commands during discovery or declare machine auth for browser clients", async () => {
  const dir = scratch(),
    marker = join(dir, "ran");
  const f = await fixture({
    grantType: "authorization_code",
    clientMetadataUrl: "https://jwt.example/browser.json",
    privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" },
  });
  f.publicMcp();
  const { authorizationUrl } = await f.start();
  expect(authorizationUrl).toBeTruthy();
  expect((await f.connect()).status).toBe("connected");
  expect(existsSync(marker)).toBe(false);
  for (const r of f.requests) {
    expect(clientCapabilities(r)?.extensions).toBeUndefined();
  }
});

it("keeps native ordinary-versus-explicit scope precedence without changing step-up policy", async () => {
  const ordinary = await fixture({ scope: "configured-scope" });
  expect(await (await ordinary.connect()).client.callTool({ name: "echo" })).toMatchObject({
    content: [{ text: "signed tool" }],
  });
  expect(ordinary.exchanges[0]?.params.get("scope")).toBe("tools");
  expect(ordinary.exchanges[0]?.params.get("resource")).toBe(`${ordinary.origin}/mcp`);
  const explicit = await fixture({ scope: "configured-scope" });
  await explicit.start();
  expect(explicit.exchanges[0]?.params.get("scope")).toBe("configured-scope");
});

it("stops failed signing during ordinary browser refresh without consent or credential invalidation", async () => {
  const f = await fixture({ grantType: "authorization_code" });
  await f.login();
  const connection = await f.connect();
  const before = f.stored();
  f.expire();
  assert(f.oauth.privateKeyJwt !== undefined);
  f.oauth.privateKeyJwt.privateKey = key("RS256").pem; // Real incompatible key, not a mocked signer.
  await expect(connection.client.callTool({ name: "echo" })).rejects.toThrow(/privateKeyJwt/);
  expect(f.exchanges).toHaveLength(1);
  expect(f.authorizations).toHaveLength(1);
  expect(f.stored()).toEqual(before);
  expect(browser.open).not.toHaveBeenCalled();
});

it.each([
  ["auto", "close"],
  ["auto", "signal"],
  ["auto", "shutdown"],
  ["legacy", "close"],
  ["legacy", "signal"],
  ["legacy", "shutdown"],
] as const)(
  "settles native %s auth after %s without late token or tool dispatch",
  async (protocolVersion, mode) => {
    const f = await fixture();
    f.definition.protocolVersion = protocolVersion;
    const other = await fixture();
    const sibling = await f.manager.connect(other.name, other.definition);
    const controller = new AbortController();
    const signing = holdNativeSigning();
    let before: ReturnType<typeof f.stored>;
    try {
      const pending = f.manager
        .connect(f.name, f.definition, mode === "signal" ? controller.signal : undefined)
        .then((c) => c.client.callTool({ name: "echo" }))
        .catch((cause: unknown) => cause);
      await signing.started;
      before = structuredClone(f.stored());
      if (mode === "close") {
        await f.manager.close(f.name);
      } else if (mode === "signal") {
        controller.abort(new Error("individual connect cancelled"));
      } else {
        await shutdownOAuth(f.runtime);
      }
      signing.events.push("cancel-returned");
      const cancellations: unknown[] = [];
      if (mode !== "shutdown") {
        cancellations.push(await pending);
      }
      expect(signing.pending()).toBeGreaterThan(0);
      await signing.finish();
      cancellations.push(await pending);
      for (const cancellation of cancellations) {
        expect(cancellation).toBeInstanceOf(Error);
      }
      expect(signing.pending()).toBe(0);
      expect(signing.events.at(-1)).toBe("native-send-settled");
      expect(f.exchanges).toHaveLength(0);
      expect(f.stored()).toEqual(before);
      expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(0);
      expect(f.manager.getConnection(f.name)).toBeUndefined();
      expect(f.runtime.signal.aborted).toBe(mode === "shutdown");
      const survivors = [];
      if (mode !== "shutdown") {
        other.expire();
        survivors.push({
          result: await sibling.client.callTool({ name: "echo" }),
          exchanges: other.exchanges.length,
        });
      }
      expect(survivors).toHaveLength(mode === "shutdown" ? 0 : 1);
      for (const survivor of survivors) {
        expect(survivor.result).toMatchObject({ content: [{ text: "signed tool" }] });
        expect(survivor.exchanges).toBe(2);
      }
    } finally {
      await signing.finish();
      signing.restore();
      const testName = expect.getState().currentTestName;
      if (process.env.JWT_PROOF_FILE !== undefined) {
        appendFileSync(
          process.env.JWT_PROOF_FILE,
          `${JSON.stringify({
            test: testName,
            cancellation: mode,
            protocolVersion,
            nativeEvents: signing.events,
            pendingNativeSends: signing.pending(),
            tokenPosts: f.exchanges.length,
            storageChanged: JSON.stringify(before) !== JSON.stringify(f.stored()),
            runtimeAborted: f.runtime.signal.aborted,
          })}\n`,
        );
      }
    }
  },
);

it("stops detached refresh after closing an established connection without replacing its tokens", async () => {
  const f = await fixture();
  const connection = await f.connect();
  f.expire();
  const signing = holdNativeSigning(connection.transport);
  try {
    const pending = connection.client.callTool({ name: "echo" }).catch((cause: unknown) => cause);
    await signing.started;
    const before = structuredClone(f.stored());
    const requests = f.requests.length;
    await f.manager.close(f.name);
    expect(await pending).toBeInstanceOf(Error);
    expect(signing.pending()).toBeGreaterThan(0);
    let stopped = false;
    const stopping = f.manager.closeAll().finally(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stopped).toBe(false);
    await signing.finish();
    await stopping;
    expect(f.exchanges).toHaveLength(1);
    expect(f.stored()).toEqual(before);
    expect(f.requests).toHaveLength(requests);
    expect(f.runtime.signal.aborted).toBe(false);
  } finally {
    await signing.finish();
    signing.restore();
  }
});

it("does not bind a completed connect caller's signal to the provider lifetime", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const connection = await f.manager.connect(f.name, f.definition, controller.signal);
  controller.abort();
  f.expire();
  expect(await connection.client.callTool({ name: "echo" })).toMatchObject({
    content: [{ text: "signed tool" }],
  });
  expect(f.exchanges).toHaveLength(2);
  expect(f.runtime.signal.aborted).toBe(false);
});

it("keeps native auth alive for the surviving shared reconnect caller", async () => {
  const f = await fixture();
  const stale = await f.connect();
  f.expire();
  const controller = new AbortController();
  const signing = holdNativeSigning();
  try {
    const first = f.manager
      .reconnect(f.name, f.definition, stale, controller.signal)
      .catch((cause: unknown) => cause);
    await signing.started;
    controller.abort(new Error("stop waiting"));
    expect(await first).toBeInstanceOf(Error);
    expect(signing.pending()).toBeGreaterThan(0);
    const second = f.manager.reconnect(f.name, f.definition, stale);
    await signing.finish();
    const fresh = await second;
    expect(fresh).not.toBe(stale);
    expect(f.manager.getConnection(f.name)).toBe(fresh);
    f.expire();
    expect(await fresh.client.callTool({ name: "echo" })).toMatchObject({
      content: [{ text: "signed tool" }],
    });
    expect(f.exchanges).toHaveLength(3);
    expect(f.runtime.signal.aborted).toBe(false);
  } finally {
    await signing.finish();
    signing.restore();
  }
});

it("drains accepted native authentication before retiring its transport, leaving the replacement usable", async () => {
  const f = await fixture();
  const stale = await f.connect();
  f.expire();
  const signing = holdNativeSigning();
  const closeTransport = stale.transport.close.bind(stale.transport);
  let closed!: () => void;
  const didClose = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const closing = vi.spyOn(stale.transport, "close").mockImplementation(async () => {
    await closeTransport();
    closed();
  });
  try {
    const accepted = stale.client.callTool({ name: "echo" });
    await signing.started;
    f.manager.retire(f.name, stale);
    expect(closing).not.toHaveBeenCalled();
    await signing.finish();
    expect(await accepted).toMatchObject({ content: [{ text: "signed tool" }] });
    await didClose;
    expect(closing).toHaveBeenCalledTimes(1);
    const fresh = await f.connect();
    expect(fresh).not.toBe(stale);
    f.expire();
    expect(await fresh.client.callTool({ name: "echo" })).toMatchObject({
      content: [{ text: "signed tool" }],
    });
    expect(f.exchanges).toHaveLength(3);
    expect(f.runtime.signal.aborted).toBe(false);
  } finally {
    await signing.finish();
    signing.restore();
    closing.mockRestore();
  }
});

it("does not migrate a real saved shared browser login into private-key auth after a custom URL change", async () => {
  const f = await fixture({
    grantType: "authorization_code",
    clientMetadataUrl: sharedDocument.client_id,
    privateKeyJwt: undefined,
  });
  await f.login();
  const before = f.stored();
  expect(before?.clientInfo).toMatchObject({
    clientId: sharedDocument.client_id,
    registrationType: "cimd",
  });
  const dir = scratch(),
    marker = join(dir, "ran");
  f.oauth.clientMetadataUrl = "https://jwt.example/replacement.json";
  f.oauth.privateKeyJwt = { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" };
  const error = await f.start().catch((cause: unknown) => cause);
  assert(error instanceof OAuthError);
  expect(error).toBeInstanceOf(OAuthError);
  expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(existsSync(marker)).toBe(false);
  expect(f.exchanges).toHaveLength(1);
  expect(f.authorizations).toHaveLength(1);
  expect(f.stored()).toEqual(before);
});

it("refuses keyless machine authentication with a real saved shared browser registration", async () => {
  const f = await fixture({
    grantType: "authorization_code",
    clientMetadataUrl: sharedDocument.client_id,
    privateKeyJwt: undefined,
  });
  await f.login();
  const before = f.stored();
  f.oauth.grantType = "client_credentials";
  const error = await f.start().catch((cause: unknown) => cause);
  assert(error instanceof OAuthError);
  expect(error).toBeInstanceOf(OAuthError);
  expect(error.code).toBe(OAuthErrorCode.InvalidRequest);
  expect(error.message).toContain("shared browser registration");
  expect(f.exchanges).toHaveLength(1);
  expect(f.authorizations).toHaveLength(1);
  expect(f.stored()).toEqual(before);
});

it.each(["configured", "opaque-dcr"])(
  "does not classify a %s client by its URL-shaped ID",
  async (kind) => {
    const f = await fixture({
      clientId: sharedDocument.client_id,
      clientMetadataUrl: "https://jwt.example/unused.json",
    });
    if (kind === "opaque-dcr") {
      delete f.oauth.clientId;
      saveAuthEntry(
        f.name,
        {
          clientInfo: { clientId: f.id, issuer: f.origin, redirectUris: [] },
          tokens: { accessToken: "old", issuer: f.origin },
        },
        f.definition.url,
      );
    }
    expect(await f.start()).toEqual({ authorizationUrl: "" });
    expect(f.exchanges[0]?.claims).toMatchObject({ iss: f.id, sub: f.id });
    expect(f.stored()?.clientInfo?.registrationType).toBeUndefined();
  },
);

it.each(["shared", "secret"])(
  "refuses a stored %s client before signing without rewriting credentials",
  async (kind) => {
    const dir = scratch(),
      marker = join(dir, "ran");
    const f = await fixture({
      clientMetadataUrl: "https://jwt.example/client.json",
      privateKeyJwt: { privateKey: `!touch '${marker}'; printf sentinel`, algorithm: "ES256" },
    });
    saveAuthEntry(
      f.name,
      {
        clientInfo: {
          clientId: kind === "shared" ? sharedDocument.client_id : "stored",
          issuer: f.origin,
          redirectUris: [],
          ...(kind === "secret"
            ? { clientSecret: "SECRET_SENTINEL" }
            : { registrationType: "cimd" }),
        },
        tokens: { accessToken: "old", issuer: f.origin },
      },
      f.definition.url,
    );
    const before = f.stored();
    await expect(f.start()).rejects.toThrow(/privateKeyJwt/);
    expect(existsSync(marker)).toBe(false);
    expect(f.exchanges).toHaveLength(0);
    expect(f.stored()).toEqual(before);
  },
);
