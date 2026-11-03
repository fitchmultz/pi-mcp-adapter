import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type * as ClientModule from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  machineResult,
  readMachineBody,
} from "./fixtures/oauth-machine-wire.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";

const captures = vi.hoisted(() => {
  const transports: {
    url: URL;
    options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1];
    transport: StreamableHTTPClientTransport;
  }[] = [];
  return { transports };
});

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const sdk = await importOriginal<typeof ClientModule>();
  class CapturedTransport extends sdk.StreamableHTTPClientTransport {
    constructor(...args: ConstructorParameters<typeof sdk.StreamableHTTPClientTransport>) {
      super(...args);
      captures.transports.push({ url: args[0], options: args[1], transport: this });
    }
  }
  return { ...sdk, StreamableHTTPClientTransport: CapturedTransport };
});

describe("McpServerManager HTTP bearer auth", () => {
  let manager: McpServerManager;
  let http: MachineHttpServer;
  let url: string;
  const requests: { path: string | undefined; headers: IncomingHttpHeaders; method: string }[] = [];

  beforeEach(async () => {
    captures.transports.length = 0;
    requests.length = 0;
    manager = new McpServerManager();
    http = new MachineHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const body = machineMessageSchema.parse(JSON.parse(await readMachineBody(req)));
      requests.push({ path: req.url, headers: req.headers, method: body.method });
      assert("id" in body);
      machineJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: machineResult(body.method, "bearer-auth", "authorized"),
      });
    });
    url = `${await http.listen()}/mcp`;
    vi.stubEnv("MCP_TEST_URL", url);
  });

  afterEach(async () => {
    await manager.closeAll();
    await http.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function transport() {
    return requireValue(captures.transports.at(-1));
  }

  function headers(): IncomingHttpHeaders {
    return requireValue(requests.find((request) => request.method === "server/discover")).headers;
  }

  it("interpolates ${VAR} URL placeholders", async () => {
    vi.stubEnv("MCP_TEST_URL", url);
    await manager.connect("remote", { url: "${MCP_TEST_URL}" });

    expect(transport().url.href).toBe(url);
    expect(requests.map((request) => request.path)).toEqual(["/mcp", "/mcp"]);
  });

  it("interpolates $env:VAR URL placeholders", async () => {
    vi.stubEnv("MCP_TEST_URL", url);
    await manager.connect("remote", { url: "$env:MCP_TEST_URL" });

    expect(transport().url.href).toBe(url);
    expect(requests.map((request) => request.path)).toEqual(["/mcp", "/mcp"]);
  });

  it("interpolates {env:VAR} URL and header placeholders", async () => {
    vi.stubEnv("MCP_TEST_URL", url);
    vi.stubEnv("MCP_TEST_BEARER_TOKEN", "brace-token");
    await manager.connect("remote", {
      url: "{env:MCP_TEST_URL}",
      headers: { Authorization: "Bearer {env:MCP_TEST_BEARER_TOKEN}" },
    });

    expect(transport().url.href).toBe(url);
    expect(headers().authorization).toBe("Bearer brace-token");
  });

  it("fails closed when URL placeholders are missing", async () => {
    delete process.env.MCP_TEST_URL;
    await expect(manager.connect("remote", { url: "https://${MCP_TEST_URL}/mcp" })).rejects.toThrow(
      "Missing environment variable in MCP server URL: MCP_TEST_URL",
    );
    await expect(
      manager.connect("brace-remote", { url: "https://{env:MCP_TEST_URL}/mcp" }),
    ).rejects.toThrow("Missing environment variable in MCP server URL: MCP_TEST_URL");
    expect(captures.transports).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("interpolates ${VAR} bearerToken placeholders", async () => {
    vi.stubEnv("MCP_TEST_BEARER_TOKEN", "placeholder-token");
    await manager.connect("remote", {
      url,
      auth: "bearer",
      bearerToken: "${MCP_TEST_BEARER_TOKEN}",
    });
    expect(headers().authorization).toBe("Bearer placeholder-token");
  });

  it("interpolates $env:VAR bearerToken placeholders", async () => {
    vi.stubEnv("MCP_TEST_BEARER_TOKEN", "env-prefix-token");
    await manager.connect("remote", {
      url,
      auth: "bearer",
      bearerToken: "$env:MCP_TEST_BEARER_TOKEN",
    });
    expect(headers().authorization).toBe("Bearer env-prefix-token");
  });

  it("keeps bearerTokenEnv support", async () => {
    vi.stubEnv("MCP_TEST_BEARER_TOKEN_ENV", "named-env-token");
    await manager.connect("remote", {
      url,
      auth: "bearer",
      bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV",
    });
    expect(headers().authorization).toBe("Bearer named-env-token");
  });

  it("uses configured headers without implicit OAuth", async () => {
    await manager.connect("remote", { url, headers: { "X-Goog-Api-Key": "api-key" } });

    expect(headers()["x-goog-api-key"]).toBe("api-key");
    expect(transport().options?.authProvider).toBeUndefined();
  });

  it("preserves OAuth redirect URI and client metadata for HTTP transports", async () => {
    await manager.connect("remote", {
      url,
      auth: "oauth",
      oauth: {
        redirectUri: "http://127.0.0.1:3118/callback",
        clientName: "Custom MCP",
        clientUri: "https://example.com/custom-mcp",
      },
    });

    const authProvider = transport().options?.authProvider;
    assert(authProvider !== undefined && "clientMetadata" in authProvider);
    expect(authProvider.redirectUrl).toBe("http://127.0.0.1:3118/callback");
    expect(authProvider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
    expect(authProvider.clientMetadata.client_name).toBe("Custom MCP");
    expect(authProvider.clientMetadata.client_uri).toBe("https://example.com/custom-mcp");
    expect(headers().authorization).toBeUndefined();
  });

  it("connects the actual HTTP client once with the configured timeout", async () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    manager.setDefaultRequestTimeoutMs(2500);
    await manager.connect("remote", { url, requestTimeoutMs: 5000 });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(captures.transports).toHaveLength(1);
    expect(connect).toHaveBeenCalledWith(transport().transport, { timeout: 5000 });
    expect(requests.map((request) => request.method)).toEqual(["server/discover", "tools/list"]);
  });
});
