import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { clearAllCredentials, getAuthBaseDir, getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { createOAuthRuntime, getOAuthRequest } from "../mcp-oauth-runtime.ts";
import { prepareMcpConnection } from "../proxy-connection.ts";
import { withSessionRecovery } from "../session-recovery.ts";
import { McpServerManager } from "../server-manager.ts";
import { createTestState } from "./test-state.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  machineResult,
  readMachineBody,
} from "./fixtures/oauth-machine-wire.ts";

interface RefreshServerConfig {
  validAccessTokens: Set<string>;
  activeRefreshToken: string;
  rotateRefreshToken: boolean;
  omitRefreshToken: boolean;
  omitScope: boolean;
  tokenDelayMs: number;
  onTokenRequest?: (params: URLSearchParams) => "invalid_grant" | undefined;
}

class RefreshTestServer {
  origin = "";
  tokenRequests: URLSearchParams[] = [];
  unauthorizedCount = 0;
  invalidGrantCount = 0;
  callAuthorizations: Array<string | undefined> = [];
  readonly config: RefreshServerConfig;
  readonly #http: MachineHttpServer;
  #tokenSequence = 1;

  constructor(overrides: Partial<RefreshServerConfig> = {}) {
    this.config = {
      validAccessTokens: new Set(["access-1"]),
      activeRefreshToken: "refresh-1",
      rotateRefreshToken: true,
      omitRefreshToken: false,
      omitScope: false,
      tokenDelayMs: 0,
      ...overrides,
    };
    this.#http = new MachineHttpServer((req, res) => this.#handle(req, res));
  }

  async listen(): Promise<string> {
    this.origin = await this.#http.listen();
    return `${this.origin}/mcp`;
  }

  async close(): Promise<void> {
    await this.#http.close();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      machineJson(res, {
        resource: `${this.origin}/mcp`,
        authorization_servers: [this.origin],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      machineJson(res, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register") {
      const body = OAuthClientMetadataSchema.parse(JSON.parse(await readMachineBody(req)));
      machineJson(res, { client_id: "registered-client", ...body }, 201);
      return;
    }
    if (url.pathname === "/token") {
      await this.#handleToken(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 202 : 405).end();
      return;
    }
    await this.#handleMcp(req, res);
  }

  async #handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readMachineBody(req));
    this.tokenRequests.push(params);
    if (this.config.tokenDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, this.config.tokenDelayMs);
      });
    }
    const override = this.config.onTokenRequest?.(params);
    const refreshToken = params.get("refresh_token");
    if (override === "invalid_grant" || refreshToken !== this.config.activeRefreshToken) {
      this.invalidGrantCount += 1;
      machineJson(
        res,
        { error: "invalid_grant", error_description: "Refresh token already used or revoked" },
        400,
      );
      return;
    }
    this.#tokenSequence += 1;
    const nextAccess = `access-${this.#tokenSequence}`;
    this.config.validAccessTokens.add(nextAccess);
    const payload: Record<string, unknown> = {
      access_token: nextAccess,
      token_type: "Bearer",
      expires_in: 3600,
    };
    if (!this.config.omitRefreshToken) {
      const nextRefresh = this.config.rotateRefreshToken
        ? `refresh-${this.#tokenSequence}`
        : this.config.activeRefreshToken;
      this.config.activeRefreshToken = nextRefresh;
      payload.refresh_token = nextRefresh;
    }
    if (!this.config.omitScope) {
      payload.scope = "read write";
    }
    machineJson(res, payload);
  }

  async #handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = machineMessageSchema.parse(JSON.parse(await readMachineBody(req)));
    const authHeader = req.headers.authorization;
    const token =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : undefined;
    if (body.method === "tools/call") {
      this.callAuthorizations.push(token);
    }
    if (token === undefined || !this.config.validAccessTokens.has(token)) {
      this.unauthorizedCount += 1;
      res
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"`,
        })
        .end("Unauthorized");
      return;
    }
    if (!("id" in body)) {
      res.writeHead(202).end();
      return;
    }
    const label =
      body.method === "tools/call" && body.params !== undefined && "arguments" in body.params
        ? JSON.stringify(body.params.arguments)
        : "ok";
    machineJson(res, {
      jsonrpc: "2.0",
      id: body.id,
      result: machineResult(body.method, "refresh-fixture", `ok:${label}`),
    });
  }
}

const workerScript = fileURLToPath(new URL("./fixtures/oauth-refresh-worker.ts", import.meta.url));

const workerReadySchema = z.object({ ready: z.literal(true), workerId: z.string() });
const workerResultSchema = z.object({
  ok: z.literal(true),
  workerId: z.string(),
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
  stored: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
    })
    .optional(),
});
const cacheWorkerResultSchema = z.object({
  ok: z.literal(true),
  readsAfterConnect: z.number(),
  readsAfterCalls: z.number(),
  results: z.array(z.unknown()),
});

class RefreshWorkerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [workerScript, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  async waitForLine(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const check = () => {
        const newline = this.buffer.indexOf("\n");
        if (newline !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          cleanup();
          resolve(line);
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Worker exited early (${String(code)}): ${this.stderr}`));
      };
      const cleanup = () => {
        this.child.stdout.off("data", check);
        this.child.off("exit", onExit);
      };
      this.child.stdout.on("data", check);
      this.child.once("exit", onExit);
      check();
    });
  }

  async waitForExit(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.child.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Worker failed (${String(code)}): ${this.stderr}`));
          return;
        }
        resolve(this.buffer.trim());
      });
    });
  }

  release(): void {
    this.child.stdin.end("g");
  }

  kill(): void {
    this.child.kill();
  }
}

async function seedFakeKeyring(
  env: NodeJS.ProcessEnv,
  identity: { serverName: string; serverUrl: string },
  entry: Record<string, unknown>,
): Promise<void> {
  const inline = `
    import { registerHooks } from "node:module";
    import { fileURLToPath } from "node:url";
    process.dlopen = () => { throw new Error("forbidden"); };
    delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    const binding = fileURLToPath(${JSON.stringify(new URL("./fixtures/android-keyring-test-binding.cjs", import.meta.url).href)});
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@napi-rs/keyring") return nextResolve(binding, context);
        return nextResolve(specifier, context);
      },
    });
    const auth = await import(${JSON.stringify(new URL("../mcp-auth.ts", import.meta.url).href)});
    auth.saveAuthEntry(${JSON.stringify(identity)}, ${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", inline], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Seed worker failed (${String(code)}): ${stderr}`));
      }
    });
  });
}

describe("OAuth refresh coordination and MCP-204 recovery", () => {
  const managers: McpServerManager[] = [];
  const servers: RefreshTestServer[] = [];
  const rawServers: MachineHttpServer[] = [];
  const tempDirs: string[] = [];
  const seededIdentities: Array<{ serverName: string; serverUrl: string }> = [];

  beforeEach(() => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.closeAll();
    }
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const server of rawServers.splice(0)) {
      await server.close();
    }
    for (const identity of seededIdentities.splice(0)) {
      clearAllCredentials(identity);
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function trackManager(): McpServerManager {
    const manager = new McpServerManager();
    managers.push(manager);
    return manager;
  }

  async function startServer(overrides?: Partial<RefreshServerConfig>): Promise<{
    server: RefreshTestServer;
    url: string;
  }> {
    const server = new RefreshTestServer(overrides);
    servers.push(server);
    const url = await server.listen();
    return { server, url };
  }

  function seedInMemory(
    serverName: string,
    serverUrl: string,
    origin: string,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      scope?: string;
    },
  ): void {
    const identity = { serverName, serverUrl };
    seededIdentities.push(identity);
    saveAuthEntry(identity, {
      tokens: { ...tokens, issuer: origin },
      clientInfo: {
        clientId: "test-client",
        redirectUris: ["http://localhost:19876/callback"],
        issuer: origin,
      },
    });
  }

  it("coalesces concurrent intra-process 401 refreshes with strict single-use rotating refresh tokens", async () => {
    const { server, url } = await startServer({ tokenDelayMs: 100 });
    const manager = trackManager();
    const now = Math.floor(Date.now() / 1000);
    seedInMemory("parallel-refresh", url, server.origin, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: now + 3600,
      scope: "read write",
    });

    const connection = await manager.connect("parallel-refresh", { url, auth: "oauth" });
    server.config.validAccessTokens.delete("access-1");

    const results = await Promise.all([
      connection.client.callTool({ name: "echo", arguments: { req: 1 } }),
      connection.client.callTool({ name: "echo", arguments: { req: 2 } }),
      connection.client.callTool({ name: "echo", arguments: { req: 3 } }),
    ]);

    expect(results).toHaveLength(3);
    expect(server.tokenRequests).toHaveLength(1);
    expect(server.invalidGrantCount).toBe(0);
    const stored = getAuthForUrl({ serverName: "parallel-refresh", serverUrl: url })?.tokens;
    expect(stored?.accessToken).toBe("access-2");
    expect(stored?.refreshToken).toBe("refresh-2");
  });

  it("does not wipe newer tokens on invalid_grant when another session rotated them mid-refresh", async () => {
    const { server, url } = await startServer({
      onTokenRequest: () => {
        saveAuthEntry(
          { serverName: "cas-race", serverUrl: url },
          {
            tokens: {
              accessToken: "access-newer",
              refreshToken: "refresh-newer",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
              issuer: server.origin,
            },
            clientInfo: {
              clientId: "test-client",
              redirectUris: ["http://localhost:19876/callback"],
              issuer: server.origin,
            },
          },
        );
        return "invalid_grant";
      },
    });
    const manager = trackManager();
    const now = Math.floor(Date.now() / 1000);
    seedInMemory("cas-race", url, server.origin, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: now + 3600,
    });

    const connection = await manager.connect("cas-race", { url, auth: "oauth" });
    server.config.validAccessTokens.delete("access-1");
    server.config.validAccessTokens.add("access-newer");

    await expect(connection.client.callTool({ name: "echo", arguments: {} })).rejects.toThrow(
      /Refresh token already used or revoked/,
    );

    const stored = getAuthForUrl({ serverName: "cas-race", serverUrl: url })?.tokens;
    expect(stored?.accessToken).toBe("access-newer");
    expect(stored?.refreshToken).toBe("refresh-newer");
  });

  it(
    "serializes concurrent cross-process 401 refreshes over rotating refresh tokens",
    { timeout: 20_000 },
    async () => {
      const { server, url } = await startServer({ tokenDelayMs: 150 });
      const home = mkdtempSync(join(tmpdir(), "mcp-204-cross-proc-"));
      tempDirs.push(home);
      const keyringFile = join(home, "keyring.json");
      writeFileSync(keyringFile, "{}");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
        FITCH_MCP_OAUTH_DIR: join(home, "oauth"),
        PI_MCP_ADAPTER_FAKE_NATIVE_KEYRING: keyringFile,
      };
      delete env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

      const now = Math.floor(Date.now() / 1000);
      await seedFakeKeyring(
        env,
        { serverName: "shared-refresh", serverUrl: url },
        {
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: now + 3600,
            scope: "read write",
            issuer: server.origin,
          },
          clientInfo: {
            clientId: "shared-client",
            redirectUris: ["http://localhost:19876/callback"],
            issuer: server.origin,
          },
        },
      );

      const workerA = new RefreshWorkerProcess(["refresh", url, "worker-a", "shared-refresh"], env);
      const workerB = new RefreshWorkerProcess(["refresh", url, "worker-b", "shared-refresh"], env);

      try {
        const [readyA, readyB] = await Promise.all([workerA.waitForLine(), workerB.waitForLine()]);
        expect(workerReadySchema.parse(JSON.parse(readyA)).workerId).toBe("worker-a");
        expect(workerReadySchema.parse(JSON.parse(readyB)).workerId).toBe("worker-b");

        server.config.validAccessTokens.delete("access-1");

        const exits = Promise.all([workerA.waitForExit(), workerB.waitForExit()]);
        workerA.release();
        workerB.release();

        const [outA, outB] = await exits;
        const parsedA = workerResultSchema.parse(JSON.parse(outA));
        const parsedB = workerResultSchema.parse(JSON.parse(outB));

        expect(parsedA.result.content[0]?.text).toContain("worker-a");
        expect(parsedB.result.content[0]?.text).toContain("worker-b");
        expect(server.tokenRequests).toHaveLength(1);
        expect(server.invalidGrantCount).toBe(0);
        expect(parsedA.stored?.accessToken).toBe("access-2");
        expect(parsedA.stored?.refreshToken).toBe("refresh-2");
        expect(parsedB.stored?.accessToken).toBe("access-2");
        expect(parsedB.stored?.refreshToken).toBe("refresh-2");

        const locksDir = join(home, ".fitch-mcp-adapter", "locks");
        const remainingRefreshLocks = readdirSync(locksDir).filter((name) =>
          name.startsWith("refresh-"),
        );
        expect(remainingRefreshLocks).toEqual([]);
      } finally {
        workerA.kill();
        workerB.kill();
      }
    },
  );

  it("preserves stored refreshToken and scope across multiple refreshes that omit them", async () => {
    const { server, url } = await startServer({
      omitRefreshToken: true,
      omitScope: true,
      rotateRefreshToken: false,
    });
    const manager = trackManager();
    const now = Math.floor(Date.now() / 1000);
    seedInMemory("preserve-refresh", url, server.origin, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: now + 3600,
      scope: "read write",
    });

    const connection = await manager.connect("preserve-refresh", { url, auth: "oauth" });
    server.config.validAccessTokens.delete("access-1");
    await connection.client.callTool({ name: "echo", arguments: { step: 1 } });

    const afterFirst = getAuthForUrl({ serverName: "preserve-refresh", serverUrl: url })?.tokens;
    expect(afterFirst?.accessToken).toBe("access-2");
    expect(afterFirst?.refreshToken).toBe("refresh-1");
    expect(afterFirst?.scope).toBe("read write");

    server.config.validAccessTokens.delete("access-2");
    await connection.client.callTool({ name: "echo", arguments: { step: 2 } });

    const afterSecond = getAuthForUrl({ serverName: "preserve-refresh", serverUrl: url })?.tokens;
    expect(afterSecond?.accessToken).toBe("access-3");
    expect(afterSecond?.refreshToken).toBe("refresh-1");
    expect(afterSecond?.scope).toBe("read write");
    expect(server.tokenRequests).toHaveLength(2);
    expect(server.tokenRequests[1]?.get("refresh_token")).toBe("refresh-1");
  });

  it("proactively refreshes tokens within 60s of expiry before any 401 occurs", async () => {
    const { server, url } = await startServer();
    const manager = trackManager();
    const now = Math.floor(Date.now() / 1000);
    seedInMemory("proactive-refresh", url, server.origin, {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: now + 30,
      scope: "read write",
    });

    const connection = await manager.connect("proactive-refresh", { url, auth: "oauth" });
    await connection.client.callTool({ name: "echo", arguments: { proactive: true } });

    expect(server.tokenRequests).toHaveLength(1);
    expect(server.unauthorizedCount).toBe(0);
    expect(server.callAuthorizations).toEqual(["access-2"]);
    const stored = getAuthForUrl({ serverName: "proactive-refresh", serverUrl: url })?.tokens;
    expect(stored?.accessToken).toBe("access-2");
    expect(stored?.refreshToken).toBe("refresh-2");
  });

  it(
    "reuses cached in-memory tokens across repeated HTTP calls without re-reading the keyring",
    { timeout: 15_000 },
    async () => {
      const { server, url } = await startServer();
      const home = mkdtempSync(join(tmpdir(), "mcp-204-token-cache-"));
      tempDirs.push(home);
      const keyringFile = join(home, "keyring.json");
      writeFileSync(keyringFile, "{}");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
        FITCH_MCP_OAUTH_DIR: join(home, "oauth"),
        PI_MCP_ADAPTER_FAKE_NATIVE_KEYRING: keyringFile,
      };
      delete env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

      await seedFakeKeyring(
        env,
        { serverName: "cached-token", serverUrl: url },
        {
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            issuer: server.origin,
          },
          clientInfo: {
            clientId: "cache-client",
            redirectUris: ["http://localhost:19876/callback"],
            issuer: server.origin,
          },
        },
      );

      const worker = new RefreshWorkerProcess(["cache", url, "cache-worker", "cached-token"], env);
      try {
        const output = await worker.waitForExit();
        const parsed = cacheWorkerResultSchema.parse(JSON.parse(output));
        expect(parsed.results).toHaveLength(4);
        expect(parsed.readsAfterConnect).toBeGreaterThan(0);
        expect(parsed.readsAfterCalls).toBe(parsed.readsAfterConnect);
      } finally {
        worker.kill();
      }
    },
  );

  it("automatically reconnects a needs-auth server when another session saves fresh credentials", async () => {
    const { server, url } = await startServer({ validAccessTokens: new Set(["session-b-token"]) });
    const manager = trackManager();
    const oauthRuntime = createOAuthRuntime();
    manager.setOAuthRuntime(oauthRuntime);
    const definition = { url, auth: "oauth" as const };
    const state = createTestState({
      config: { settings: { autoAuth: false }, mcpServers: { remote: definition } },
      manager,
      oauthRuntime,
    });

    const firstAttempt = await prepareMcpConnection(state, "remote");
    expect(firstAttempt.error?.details).toMatchObject({ error: "auth_required", server: "remote" });
    expect(manager.getConnection("remote")?.status).toBe("needs-auth");

    // Still no fresh credentials: stays in needs-auth without looping.
    const secondAttempt = await prepareMcpConnection(state, "remote");
    expect(secondAttempt.error?.details).toMatchObject({
      error: "auth_required",
      server: "remote",
    });

    // Simulate another Pi session completing OAuth and saving fresh tokens.
    seedInMemory("remote", url, server.origin, {
      accessToken: "session-b-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const recovered = await prepareMcpConnection(state, "remote");
    expect(recovered.error).toBeUndefined();
    expect(recovered.connection?.status).toBe("connected");
    assert(recovered.connection !== undefined);
    const callResult = await recovered.connection.client.callTool({
      name: "echo",
      arguments: { crossSession: true },
    });
    expect(JSON.stringify(callResult)).toContain("crossSession");

    // Also verify withSessionRecovery directly picks up fresh credentials from needs-auth.
    const secondManager = trackManager();
    const secondRuntime = createOAuthRuntime();
    secondManager.setOAuthRuntime(secondRuntime);
    clearAllCredentials({ serverName: "remote", serverUrl: url });
    const stale = await secondManager.connect("remote", definition);
    expect(stale.status).toBe("needs-auth");

    seedInMemory("remote", url, server.origin, {
      accessToken: "session-b-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const recoveryResult = await withSessionRecovery(
      {
        manager: secondManager,
        config: { settings: { autoAuth: false }, mcpServers: { remote: definition } },
      },
      "remote",
      async (conn) => await conn.client.callTool({ name: "echo", arguments: { direct: true } }),
    );
    expect(JSON.stringify(recoveryResult)).toContain("direct");
    expect(secondManager.getConnection("remote")?.status).toBe("connected");
  });

  it("observes OAuth challenges on legacy SSE servers and records challenge metadata", async () => {
    let sseOrigin = "";
    const sseServer = new MachineHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", sseOrigin);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        machineJson(res, {
          resource: `${sseOrigin}/sse`,
          authorization_servers: [sseOrigin],
        });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        machineJson(res, {
          issuer: sseOrigin,
          authorization_endpoint: `${sseOrigin}/authorize`,
          token_endpoint: `${sseOrigin}/token`,
          registration_endpoint: `${sseOrigin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname === "/register") {
        const body = OAuthClientMetadataSchema.parse(JSON.parse(await readMachineBody(req)));
        machineJson(res, { client_id: "sse-client", ...body }, 201);
        return;
      }
      if (req.method === "POST" && url.pathname === "/sse") {
        // Force fallback from Streamable HTTP to legacy SSE transport.
        res.writeHead(405).end("Method Not Allowed");
        return;
      }
      if (req.method === "GET" && url.pathname === "/sse") {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${sseOrigin}/.well-known/oauth-protected-resource", scope="sse:read"`,
          })
          .end("Unauthorized");
        return;
      }
      res.writeHead(404).end();
    });
    rawServers.push(sseServer);
    sseOrigin = await sseServer.listen();
    const sseUrl = `${sseOrigin}/sse`;

    const manager = trackManager();
    const oauthRuntime = createOAuthRuntime();
    manager.setOAuthRuntime(oauthRuntime);

    const connection = await manager.connect("legacy-sse", { url: sseUrl, auth: "oauth" });
    expect(connection.status).toBe("needs-auth");

    const recorded = getOAuthRequest("legacy-sse", sseUrl, getAuthBaseDir(), oauthRuntime);
    expect(recorded).toBeDefined();
    expect(recorded?.discovered?.resourceMetadataUrl?.href).toBe(
      `${sseOrigin}/.well-known/oauth-protected-resource`,
    );
    expect(recorded?.discovered?.scope).toBe("sse:read");
  });
});
