import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Native from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import { McpServerManager } from "../server-manager.ts";
import { createAbortHttp } from "./fixtures/abort-http.ts";
import { requireValue } from "./fixtures/extension-lifecycle.ts";

type HttpCapture = {
  transport: Native.StreamableHTTPClientTransport;
  url: URL;
  options: ConstructorParameters<typeof Native.StreamableHTTPClientTransport>[1];
};
const captures = vi.hoisted(() => {
  const clients: Native.Client[] = [];
  const http: HttpCapture[] = [];
  return { clients, http };
});
vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const sdk = await importOriginal<typeof Native>();
  class ObservedClient extends sdk.Client {
    constructor(...args: ConstructorParameters<typeof sdk.Client>) {
      super(...args);
      captures.clients.push(this);
    }
  }
  class ObservedHttp extends sdk.StreamableHTTPClientTransport {
    constructor(...args: ConstructorParameters<typeof sdk.StreamableHTTPClientTransport>) {
      super(...args);
      captures.http.push({ transport: this, url: args[0], options: args[1] });
    }
  }
  return { ...sdk, Client: ObservedClient, StreamableHTTPClientTransport: ObservedHttp };
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-http-config-"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  captures.clients.length = 0;
  captures.http.length = 0;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function setup() {
  const fixture = await createAbortHttp();
  cleanups.push(fixture.close);
  const manager = new McpServerManager();
  cleanups.push(() => manager.closeAll());
  return { fixture, manager };
}
function latest(): HttpCapture {
  return requireValue(captures.http.at(-1));
}

describe("McpServerManager HTTP bearer auth", () => {
  it.each(["${MCP_TEST_URL}", "$env:MCP_TEST_URL"])(
    "interpolates %s URL placeholders",
    async (url) => {
      const { fixture, manager } = await setup();
      vi.stubEnv("MCP_TEST_URL", requireValue(fixture.definition.url));
      await manager.connect("remote", { ...fixture.definition, url });
      expect(latest().url.href).toBe(fixture.definition.url);
      expect(requireValue(fixture.requests.at(-1)).url).toBe(fixture.definition.url);
    },
  );

  it("interpolates {env:VAR} URL and header placeholders", async () => {
    const { fixture, manager } = await setup();
    vi.stubEnv("MCP_TEST_URL", requireValue(fixture.definition.url));
    vi.stubEnv("MCP_TEST_BEARER_TOKEN", "brace-token");
    await manager.connect("remote", {
      ...fixture.definition,
      url: "{env:MCP_TEST_URL}",
      headers: { Authorization: "Bearer {env:MCP_TEST_BEARER_TOKEN}" },
    });
    expect(latest().url.href).toBe(fixture.definition.url);
    expect(requireValue(fixture.requests.at(-1)).url).toBe(fixture.definition.url);
    expect(requireValue(fixture.requests.at(-1)).headers.authorization).toBe("Bearer brace-token");
  });

  it("fails closed when URL placeholders are missing", async () => {
    const { fixture, manager } = await setup();
    vi.stubEnv("MCP_TEST_URL", "");
    delete process.env.MCP_TEST_URL;
    await expect(manager.connect("remote", { url: "https://${MCP_TEST_URL}/mcp" })).rejects.toThrow(
      "Missing environment variable in MCP server URL: MCP_TEST_URL",
    );
    await expect(
      manager.connect("brace-remote", { url: "https://{env:MCP_TEST_URL}/mcp" }),
    ).rejects.toThrow("Missing environment variable in MCP server URL: MCP_TEST_URL");
    expect(captures.http).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    ["${VAR}", "${MCP_TEST_BEARER_TOKEN}", "placeholder-token"],
    ["$env:VAR", "$env:MCP_TEST_BEARER_TOKEN", "env-prefix-token"],
  ])("interpolates %s bearerToken placeholders", async (_name, bearerToken, token) => {
    const { fixture, manager } = await setup();
    vi.stubEnv("MCP_TEST_BEARER_TOKEN", token);
    await manager.connect("remote", { ...fixture.definition, auth: "bearer", bearerToken });
    expect(requireValue(fixture.requests.at(-1)).headers.authorization).toBe(`Bearer ${token}`);
  });

  it("keeps bearerTokenEnv support", async () => {
    const { fixture, manager } = await setup();
    vi.stubEnv("MCP_TEST_BEARER_TOKEN_ENV", "named-env-token");
    await manager.connect("remote", {
      ...fixture.definition,
      auth: "bearer",
      bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV",
    });
    expect(requireValue(fixture.requests.at(-1)).headers.authorization).toBe(
      "Bearer named-env-token",
    );
  });

  it("uses configured headers without implicit OAuth", async () => {
    const { fixture, manager } = await setup();
    const { auth: _auth, ...definition } = fixture.definition;
    await manager.connect("remote", { ...definition, headers: { "X-Goog-Api-Key": "api-key" } });
    expect(requireValue(fixture.requests.at(-1)).headers["x-goog-api-key"]).toBe("api-key");
    expect(latest().options?.authProvider).toBeUndefined();
  });

  it("preserves OAuth redirect URI and client metadata for HTTP transports", async () => {
    const { fixture, manager } = await setup();
    await manager.connect("remote", {
      ...fixture.definition,
      auth: "oauth",
      oauth: {
        redirectUri: "http://127.0.0.1:3118/callback",
        clientName: "Custom MCP",
        clientUri: "https://example.com/custom-mcp",
      },
    });
    const provider = latest().options?.authProvider;
    assert(provider !== undefined && "redirectUrl" in provider && "clientMetadata" in provider);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:3118/callback");
    const metadata = provider.clientMetadata;
    assert(typeof metadata !== "function");
    expect(metadata.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
    expect(metadata.client_name).toBe("Custom MCP");
    expect(metadata.client_uri).toBe("https://example.com/custom-mcp");
    expect(fixture.messages.filter((message) => message.method === "initialize")).toHaveLength(1);
  });

  it("connects the actual HTTP client once with the configured timeout", async () => {
    const { fixture, manager } = await setup();
    const connect = vi.spyOn(Client.prototype, "connect");
    manager.setDefaultRequestTimeoutMs(2500);
    await manager.connect("remote", { ...fixture.definition, requestTimeoutMs: 5000 });
    expect(captures.clients).toHaveLength(1);
    expect(captures.http).toHaveLength(1);
    expect(connect).toHaveBeenCalledWith(latest().transport, { timeout: 5000 });
    expect(connect.mock.contexts[0]).toBe(captures.clients[0]);
    expect(fixture.messages.filter((message) => message.method === "initialize")).toHaveLength(1);
  });
});
