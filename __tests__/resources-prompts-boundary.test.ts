import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer as Server } from "@modelcontextprotocol/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { createTestState } from "./test-state.ts";
import {
  MachineHttpServer,
  machineJson,
  machineMessageSchema,
  readMachineBody,
} from "./fixtures/oauth-machine-wire.ts";
import { executeResourceList, executeResourceRead } from "../resource-tools.ts";
import { executeGetPrompt, executePromptList } from "../prompt-tools.ts";
import { createPromptCommand } from "../prompts.ts";
import { executeCall } from "../proxy-modes.ts";
import { executeGateway } from "../host-gateway.ts";
import { updateMetadataCache, updateServerMetadata } from "../init.ts";
import { registerServers } from "../init-startup.ts";
import { formatPromptCommandName, type PromptMetadata, type ServerDefinition } from "../types.ts";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function connectInMemory(
  serverName: string,
  server: Server,
  definition: ServerDefinition = { url: "https://unused.invalid/mcp", auth: false },
  overrides: Partial<Parameters<typeof createTestState>[0]> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const state = createTestState({
    config: { settings: {}, mcpServers: { [serverName]: definition } },
    ...overrides,
  });
  onTestFinished(async () => {
    await state.owner.stop();
    await state.manager.closeAll();
    await server.close();
  });
  const connectSpy = vi.spyOn(Client.prototype, "connect").mockImplementation(function (
    this: Client,
    _transport,
    options,
  ) {
    connectSpy.mockRestore();
    return this.connect(clientTransport, options);
  });
  try {
    const connection = await state.manager.connect(serverName, definition);
    updateServerMetadata(state, serverName);
    return { state, connection };
  } finally {
    connectSpy.mockRestore();
  }
}

describe("MCP-210 resources, templates, prompts, and completions at real SDK boundaries", () => {
  let host: Awaited<ReturnType<typeof createTestExtensionContext>>;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeAll(async () => {
    host = await createTestExtensionContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });

  afterAll(async () => {
    await host.dispose();
  });

  it("reads dynamic, templated, and resource_link URIs with approval, hooks, and native media rendering", async () => {
    const server = new Server({ name: "linear-mock", version: "1.0.0" });
    server.server.registerCapabilities({ tools: {}, resources: {} });
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "find_issue", inputSchema: { type: "object", properties: {} } }],
    }));
    server.server.setRequestHandler("tools/call", () => ({
      content: [
        {
          type: "resource_link",
          uri: "linear://attachment/screenshot-9",
          name: "Screenshot 9",
          mimeType: "image/png",
        },
      ],
    }));
    server.server.setRequestHandler("resources/list", () => ({
      resources: [
        { name: "handbook", uri: "linear://docs/handbook", mimeType: "text/plain" },
        {
          name: "app_ui",
          uri: "ui://linear/dashboard.html",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    }));
    server.server.setRequestHandler("resources/templates/list", () => ({
      resourceTemplates: [
        {
          name: "issue",
          uriTemplate: "linear://issue/{id}",
          description: "Read a Linear issue by identifier",
          mimeType: "application/json",
        },
        {
          name: "app_template",
          uriTemplate: "ui://linear/panel/{id}",
          description: "Internal MCP App template",
        },
      ],
    }));
    server.server.setRequestHandler("resources/read", ({ params }) => {
      if (params.uri === "linear://issue/ENG-123") {
        return {
          contents: [
            {
              uri: params.uri,
              mimeType: "application/json",
              blob: Buffer.from(JSON.stringify({ id: "ENG-123", status: "open" })).toString(
                "base64",
              ),
            },
          ],
        };
      }
      if (params.uri === "linear://attachment/screenshot-9") {
        return {
          contents: [{ uri: params.uri, mimeType: "image/png", blob: PNG_BASE64 }],
        };
      }
      if (params.uri === "ui://linear/dashboard.html") {
        return {
          contents: [
            {
              uri: params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>Dashboard</body></html>",
            },
          ],
        };
      }
      throw new Error(`Unknown URI: ${params.uri}`);
    });

    const definition: ServerDefinition = {
      url: "https://unused.invalid/mcp",
      auth: false,
      includeTools: ["find_issue"],
      excludeTools: ["read_handbook", "read_resource"],
    };
    const { state } = await connectInMemory("linear", server, definition);

    // Tool filters must not hide resources, and ui:// must be excluded from model listings.
    const listed = await executeResourceList(state, { server: "linear" });
    expect(listed.details).toMatchObject({
      mode: "resources",
      server: "linear",
      total: 1,
      items: [{ name: "handbook", uri: "linear://docs/handbook", mimeType: "text/plain" }],
      resourceTemplates: [
        {
          name: "issue",
          uriTemplate: "linear://issue/{id}",
          description: "Read a Linear issue by identifier",
          mimeType: "application/json",
        },
      ],
    });
    expect(
      (state.toolMetadata.get("linear") ?? []).some(
        (entry) => entry.resourceUri?.startsWith("ui://") === true,
      ),
    ).toBe(false);

    // MCP App UI loader must still read ui:// resources normally from connection.resources.
    const uiResource = await state.uiResourceHandler.readUiResource(
      "linear",
      "ui://linear/dashboard.html",
    );
    expect(uiResource.html).toContain("Dashboard");

    // Templated URI read succeeds even though it is absent from static resources/list.
    const events: string[] = [];
    state.onToolCall = async (event) => {
      events.push(`${event.phase}:${event.resourceUri ?? ""}`);
    };
    const beforeDispatch = vi.fn<
      NonNullable<Parameters<typeof executeResourceRead>[1]["beforeDispatch"]>
    >(async () => {
      // Observe hook invocation.
    });
    const issueRead = await executeResourceRead(state, {
      server: "linear",
      uri: "linear://issue/ENG-123",
      identity: { toolCallId: "res-1" },
      beforeDispatch,
    });
    expect(issueRead.details).toMatchObject({
      mode: "call",
      server: "linear",
      resourceUri: "linear://issue/ENG-123",
    });
    expect(JSON.parse(textOf(issueRead))).toEqual({ id: "ENG-123", status: "open" });
    expect(beforeDispatch).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      expect.objectContaining({ resourceUri: "linear://issue/ENG-123" }),
    );
    expect(events).toEqual(["before:linear://issue/ENG-123", "after:linear://issue/ENG-123"]);

    // resource_link URI from a tool call succeeds and renders PNG blob as native ImageContent.
    const toolResult = await executeCall(state, { toolName: "linear_find_issue", args: {} });
    expect(textOf(toolResult)).toContain("linear://attachment/screenshot-9");
    const attachmentRead = await executeResourceRead(state, {
      server: "linear",
      uri: "linear://attachment/screenshot-9",
    });
    expect(attachmentRead.content).toContainEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });

    // Approval gates still protect dynamic resource reads and preview the URI.
    const select = vi.fn<typeof host.context.ui.select>().mockResolvedValue("Deny");
    state.ui = { ...host.context.ui, select };
    state.config.settings = { approveTools: ["linear_read_*"] };
    const denied = await executeResourceRead(state, {
      server: "linear",
      uri: "linear://issue/ENG-123",
    });
    expect(denied.details.error).toBe("approval_denied");
    expect(select.mock.calls[0]?.[0]).toContain("linear://issue/ENG-123");

    // exposeResources: false blocks both listing and dynamic reading.
    state.config.settings = {};
    state.config.mcpServers.linear = { ...definition, exposeResources: false };
    expect((await executeResourceList(state, { server: "linear" })).details).toMatchObject({
      total: 0,
      items: [],
      resourceTemplates: [],
    });
    expect(
      (await executeResourceRead(state, { server: "linear", uri: "linear://issue/ENG-123" }))
        .details.error,
    ).toBe("resources_disabled");
  });

  it("ignores MethodNotFound for resources/templates/list, caches templates, and reflects live changes", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "mcp-210-cache-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));

    // Server A advertises resources capability without implementing resources/templates/list.
    const noTemplatesServer = new Server({ name: "no-templates", version: "1.0.0" });
    noTemplatesServer.server.registerCapabilities({ tools: {}, resources: {} });
    noTemplatesServer.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    noTemplatesServer.server.setRequestHandler("resources/list", () => ({
      resources: [{ name: "readme", uri: "docs://readme" }],
    }));
    const noTemplates = await connectInMemory("plain", noTemplatesServer);
    expect(noTemplates.connection.resourceTemplates).toEqual([]);
    expect(
      (await executeResourceList(noTemplates.state, { server: "plain" })).details,
    ).toMatchObject({
      items: [{ name: "readme", uri: "docs://readme" }],
      resourceTemplates: [],
    });

    // Server B serves dynamic templates and persists them in metadata cache.
    let templates = [{ name: "doc", uriTemplate: "docs://v1/{slug}" }];
    const templateServer = new Server({ name: "with-templates", version: "1.0.0" });
    templateServer.server.registerCapabilities({
      tools: {},
      resources: { listChanged: true },
    });
    templateServer.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    templateServer.server.setRequestHandler("resources/list", () => ({
      resources: [{ name: "index", uri: "docs://index" }],
    }));
    templateServer.server.setRequestHandler("resources/templates/list", () => ({
      resourceTemplates: templates,
    }));
    const def: ServerDefinition = { url: "https://templates.invalid/mcp", auth: false };
    const { state, connection } = await connectInMemory("docs", templateServer, def, {
      metadataCacheEnabled: true,
    });
    updateMetadataCache(state, "docs");

    // Fresh cold state restores cached templates without connecting.
    const cold = createTestState({
      config: { settings: {}, mcpServers: { docs: def } },
      metadataCacheEnabled: true,
    });
    onTestFinished(() => cold.owner.stop());
    registerServers(cold, [["docs", def]]);
    const connectSpy = vi.spyOn(cold.manager, "connect");
    const cachedList = await executeResourceList(cold, { server: "docs" });
    expect(connectSpy).not.toHaveBeenCalled();
    expect(cachedList.details).toMatchObject({
      items: [{ name: "index", uri: "docs://index" }],
      resourceTemplates: [{ name: "doc", uriTemplate: "docs://v1/{slug}" }],
    });

    // Connected server reflects live templates after resources/list_changed.
    templates = [{ name: "doc_v2", uriTemplate: "docs://v2/{slug}" }];
    await templateServer.server.sendResourceListChanged();
    await expect.poll(() => connection.resourceTemplatesStale).toBe(true);
    const liveList = await executeResourceList(state, { server: "docs" });
    expect(liveList.details).toMatchObject({
      resourceTemplates: [{ name: "doc_v2", uriTemplate: "docs://v2/{slug}" }],
    });
  });

  it("exposes prompts and get-prompt gateway actions with native images and outputGuard", async () => {
    const server = new Server({ name: "prompts-gateway", version: "1.0.0" });
    server.server.registerCapabilities({ tools: {}, prompts: {} });
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    server.server.setRequestHandler("prompts/list", () => ({
      prompts: [
        {
          name: "review",
          title: "Code Review",
          description: "Review a change with visual context",
          arguments: [
            { name: "target", description: "Target path", required: true },
            { name: "style", description: "Optional tone", required: false },
          ],
        },
        { name: "huge", description: "Large text prompt", arguments: [] },
      ],
    }));
    server.server.setRequestHandler("prompts/get", ({ params }) => {
      if (params.name === "review") {
        const target = params.arguments?.target ?? "unknown";
        return {
          description: "Review packet",
          messages: [
            { role: "user", content: { type: "text", text: `Review ${target}` } },
            { role: "user", content: { type: "image", data: PNG_BASE64, mimeType: "image/png" } },
            {
              role: "user",
              content: {
                type: "resource",
                resource: { uri: "file:///notes.md", text: "Check edge cases." },
              },
            },
            {
              role: "user",
              content: {
                type: "resource_link",
                uri: "docs://style-guide",
                name: "Style Guide",
                title: "Team Style Guide",
              },
            },
          ],
        };
      }
      if (params.name === "huge") {
        return {
          messages: [{ role: "user", content: { type: "text", text: "line\n".repeat(400) } }],
        };
      }
      throw new Error(`Unknown prompt: ${params.name}`);
    });

    const outDir = mkdtempSync(join(tmpdir(), "mcp-210-prompt-guard-"));
    onTestFinished(() => rmSync(outDir, { recursive: true, force: true }));
    const { state } = await connectInMemory("board", server, undefined, {
      outputDirectory: outDir,
    });
    state.config.mcpServers.lazy = { command: "never-started" };
    state.config.mcpServers.off = { command: "disabled", disabled: true };

    // Global prompts listing skips disabled servers and reports undiscovered lazy coverage.
    const allPrompts = await executePromptList(state, {});
    expect(allPrompts.details).toMatchObject({
      mode: "prompts",
      total: 2,
      coverage: { complete: false, knownServers: ["board"], unknownServers: ["lazy"] },
    });
    expect(allPrompts.details.items).toContainEqual({
      server: "board",
      name: "review",
      title: "Code Review",
      description: "Review a change with visual context",
      arguments: [
        { name: "target", description: "Target path", required: true },
        { name: "style", description: "Optional tone", required: false },
      ],
    });

    // Missing required args and non-string args return structured errors.
    expect(
      (await executeGetPrompt(state, { server: "board", prompt: "review", args: {} })).details,
    ).toMatchObject({ error: "missing_arguments", missingArguments: ["target"] });
    expect(
      (
        await executeGetPrompt(state, {
          server: "board",
          prompt: "review",
          args: { target: 42 },
        })
      ).details,
    ).toMatchObject({ error: "invalid_arguments" });

    // Valid get-prompt returns native Pi text + ImageContent + resource/link content.
    const rendered = await executeGetPrompt(state, {
      server: "board",
      prompt: "review",
      args: { target: "src/app.ts" },
    });
    expect(rendered.details).toMatchObject({
      mode: "get-prompt",
      server: "board",
      prompt: "review",
      description: "Review packet",
      messageCount: 4,
    });
    expect(rendered.content).toContainEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });
    const combinedText = textOf(rendered);
    expect(combinedText).toContain("Review src/app.ts");
    expect(combinedText).toContain("[resource file:///notes.md]\nCheck edge cases.");
    expect(combinedText).toContain("[resource_link docs://style-guide — Style Guide]");
    expect(combinedText).toContain("Title: Team Style Guide");

    // Output guard bounds oversized prompt output.
    state.config.settings = { outputGuard: { maxBytes: 120, maxLines: 5 } };
    const huge = await executeGetPrompt(state, { server: "board", prompt: "huge" });
    expect(huge.details.outputGuard).toBeDefined();
    expect(textOf(huge)).toContain("truncated");
  });

  it("recovers prompts/get across expired HTTP sessions and OAuth autoAuth for slash commands and gateway", async () => {
    const control = {
      sessionCounter: 0,
      expireNextGetPrompt: true,
      requireBearer: false,
      issuedTokens: new Set<string>(),
      origin: "",
    };
    const handleOAuthEndpoint = async (
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
    ): Promise<boolean> => {
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        machineJson(response, {
          resource: `${control.origin}/mcp`,
          authorization_servers: [control.origin],
        });
        return true;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        machineJson(response, {
          issuer: control.origin,
          authorization_endpoint: `${control.origin}/authorize`,
          token_endpoint: `${control.origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
        return true;
      }
      if (url.pathname === "/token") {
        await readMachineBody(request);
        const token = `tok-${control.issuedTokens.size + 1}`;
        control.issuedTokens.add(token);
        machineJson(response, { access_token: token, token_type: "Bearer", expires_in: 3600 });
        return true;
      }
      return false;
    };
    const handleRpc = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
      if (!("id" in message)) {
        response.writeHead(202).end();
        return;
      }
      switch (message.method) {
        case "initialize":
          response.setHeader("Mcp-Session-Id", `session-${++control.sessionCounter}`);
          machineJson(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, prompts: {} },
              serverInfo: { name: "http-prompt-recovery", version: "1.0.0" },
            },
          });
          return;
        case "tools/list":
          machineJson(response, { jsonrpc: "2.0", id: message.id, result: { tools: [] } });
          return;
        case "prompts/list":
          machineJson(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              prompts: [{ name: "brief", arguments: [{ name: "topic", required: true }] }],
            },
          });
          return;
        case "prompts/get":
          if (control.expireNextGetPrompt) {
            control.expireNextGetPrompt = false;
            response.writeHead(404).end("Session expired");
            return;
          }
          machineJson(response, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: `Recovered on session-${control.sessionCounter}` },
                },
              ],
            },
          });
          return;
        default:
          response.writeHead(500).end(`Unexpected method: ${message.method}`);
      }
    };
    const server = new MachineHttpServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await handleOAuthEndpoint(request, url, response)) {
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      if (control.requireBearer) {
        const authHeader = request.headers.authorization;
        const token =
          typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice(7)
            : "";
        if (!control.issuedTokens.has(token)) {
          response
            .writeHead(401, {
              "WWW-Authenticate": `Bearer resource_metadata="${control.origin}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();
          return;
        }
      }
      await handleRpc(request, response);
    });

    control.origin = await server.listen();
    onTestFinished(() => server.close());

    const authDir = mkdtempSync(join(tmpdir(), "pi-mcp-210-oauth-"));
    onTestFinished(() => rmSync(authDir, { recursive: true, force: true }));
    const authStorageOptions = { baseDir: authDir };
    const definition: ServerDefinition = {
      url: `${control.origin}/mcp`,
      protocolVersion: "legacy",
      oauth: {
        grantType: "client_credentials",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
    };
    const state = createTestState({
      config: { settings: { autoAuth: true }, mcpServers: { remote: definition } },
      authStorageOptions,
    });
    state.manager.setAuthStorageOptions(authStorageOptions);
    state.manager.setOAuthRuntime(state.oauthRuntime);
    onTestFinished(async () => {
      await state.owner.stop();
      await state.manager.closeAll();
    });

    // 1) Gateway get-prompt recovers from HTTP 404 expired session automatically.
    await state.manager.connect("remote", definition);
    updateServerMetadata(state, "remote");
    const gwRecovered = await executeGetPrompt(state, {
      server: "remote",
      prompt: "brief",
      args: { topic: "gateway" },
    });
    expect(gwRecovered.details.error).toBeUndefined();
    expect(textOf(gwRecovered)).toBe("Recovered on session-2");

    // 2) Gateway tool dispatch connects on demand for prompts and runs get-prompt cleanly.
    const fakeHost = {
      state,
      initPromise: null,
      owner: state.owner,
      config: state.config,
      configPath: undefined,
      directToolsFrozen: false,
      programmaticConfig: true,
      getToolState: async () => state,
      ensureCommandState: async () => state,
      applyDirectToolConfigChanges: () => {
        // Not used by gateway prompt dispatch.
      },
      syncToolSurface: () => {
        // Not used by gateway prompt dispatch.
      },
    };
    const gatewayPrompts = await executeGateway(host.api, fakeHost, {}, [
      "gw-prompts",
      { action: "prompts", server: "remote" },
      undefined,
      undefined,
      host.runner.createToolContext("gw-prompts", state.owner.signal),
    ]);
    expect(gatewayPrompts.details).toMatchObject({
      mode: "prompts",
      server: "remote",
      total: 1,
    });
    const gatewayPrompt = await executeGateway(host.api, fakeHost, {}, [
      "gw-get-prompt",
      { action: "get-prompt", server: "remote", prompt: "brief", args: { topic: "via-gateway" } },
      undefined,
      undefined,
      host.runner.createToolContext("gw-get-prompt", state.owner.signal),
    ]);
    expect(textOf(gatewayPrompt)).toBe("Recovered on session-2");

    // 3) Slash command recovers from HTTP 404 expired session AND OAuth autoAuth challenge.
    const sendUserMessage = vi.spyOn(host.api, "sendUserMessage").mockImplementation(() => {
      // Avoid starting a live agent turn.
    });
    const metadata: PromptMetadata = {
      serverName: "remote",
      originalName: "brief",
      commandName: formatPromptCommandName("brief", "remote", "mcp"),
      description: "Brief",
      arguments: [{ name: "topic", required: true }],
    };
    expect(metadata.commandName).toBe("mcp__remote__brief");
    const command = createPromptCommand(host.api, () => state, metadata);

    control.expireNextGetPrompt = true;
    await command.handler("slash", { ...host.commandContext, hasUI: true });
    expect(sendUserMessage).toHaveBeenLastCalledWith("Recovered on session-3");

    // Enable OAuth bearer requirement while still anonymously connected: mid-call 401 recovers via autoAuth!
    control.requireBearer = true;
    await command.handler("oauth-midcall-slash", { ...host.commandContext, hasUI: true });
    expect(control.issuedTokens.size).toBe(1);
    expect(sendUserMessage).toHaveBeenLastCalledWith("Recovered on session-4");

    // Revoke token and close connection: gateway get-prompt reconnects with fresh OAuth token via autoAuth.
    control.issuedTokens.clear();
    await state.manager.close("remote");
    const oauthGateway = await executeGetPrompt(state, {
      server: "remote",
      prompt: "brief",
      args: { topic: "oauth-gateway" },
    });
    expect(oauthGateway.details.error).toBeUndefined();
    expect(control.issuedTokens.size).toBe(1);
    expect(textOf(oauthGateway)).toBe("Recovered on session-5");
  });

  it("wires completion/complete into slash-command getArgumentCompletions with cancellation and graceful fallback", async () => {
    let releaseSlowCompletion: (() => void) | undefined;
    let slowAborted = false;
    const observedRequests: Array<{
      argName: string;
      argValue: string;
      context?: Record<string, string>;
    }> = [];

    const server = new Server({ name: "completions-server", version: "1.0.0" });
    server.server.registerCapabilities({ tools: {}, prompts: {}, completions: {} });
    server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    server.server.setRequestHandler("prompts/list", () => ({
      prompts: [
        {
          name: "brief",
          description: "Brief",
          arguments: [
            { name: "topic", required: true },
            { name: "date", required: false },
          ],
        },
      ],
    }));
    server.server.setRequestHandler("completion/complete", async ({ params }, ctx) => {
      observedRequests.push({
        argName: params.argument.name,
        argValue: params.argument.value,
        ...(params.context?.arguments ? { context: params.context.arguments } : {}),
      });
      if (params.argument.value === "slow") {
        await new Promise<void>((resolve) => {
          releaseSlowCompletion = resolve;
          ctx.mcpReq.signal.addEventListener(
            "abort",
            () => {
              slowAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { completion: { values: ["stale"] } };
      }
      if (params.argument.name === "topic") {
        return {
          completion: {
            values: ["alpha", "alpha team"].filter((item) =>
              item.startsWith(params.argument.value),
            ),
          },
        };
      }
      if (params.argument.name === "date") {
        const prefix = params.context?.arguments?.topic === "alpha" ? "2026-11-" : "2026-01-";
        return { completion: { values: [`${prefix}26`] } };
      }
      return { completion: { values: [] } };
    });

    const { state } = await connectInMemory("comp", server);
    const promptMeta = state.promptMetadata.get("comp")?.[0];
    assert.ok(promptMeta);
    const command = createPromptCommand(host.api, () => state, promptMeta);
    assert.ok(command.getArgumentCompletions);

    // 1) Positional completion quotes multi-word values cleanly.
    const first = await command.getArgumentCompletions("al");
    expect(first).toEqual([
      { value: "alpha", label: "alpha" },
      { value: '"alpha team"', label: "alpha team" },
    ]);

    // 2) Named key=value completion preserves prefix and quotes spaced values.
    const named = await command.getArgumentCompletions("topic=al");
    expect(named).toEqual([
      { value: "topic=alpha", label: "alpha" },
      { value: 'topic="alpha team"', label: "alpha team" },
    ]);

    // 3) Second argument forwards prior argument context and preserves prefix.
    const second = await command.getArgumentCompletions("alpha 2026");
    expect(second).toEqual([{ value: "alpha 2026-11-26", label: "2026-11-26" }]);
    expect(observedRequests.at(-1)).toEqual({
      argName: "date",
      argValue: "2026",
      context: { topic: "alpha" },
    });

    // 4) Superseding completion aborts the earlier slow request without hanging.
    const slowPromise = command.getArgumentCompletions("slow");
    await expect.poll(() => releaseSlowCompletion !== undefined).toBe(true);
    const fast = await command.getArgumentCompletions("al");
    expect(fast).toHaveLength(2);
    expect(await slowPromise).toBeNull();
    expect(slowAborted).toBe(true);

    // 5) Gracefully returns null when disconnected.
    await state.manager.close("comp");
    expect(await command.getArgumentCompletions("al")).toBeNull();

    // 6) Gracefully returns null when server does not advertise completions capability.
    const noCompServer = new Server({ name: "no-comp", version: "1.0.0" });
    noCompServer.server.registerCapabilities({ tools: {}, prompts: {} });
    noCompServer.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    noCompServer.server.setRequestHandler("prompts/list", () => ({
      prompts: [{ name: "brief", arguments: [{ name: "topic", required: true }] }],
    }));
    const noComp = await connectInMemory("nocomp", noCompServer);
    const noCompMeta = noComp.state.promptMetadata.get("nocomp")?.[0];
    assert.ok(noCompMeta);
    const noCompCmd = createPromptCommand(host.api, () => noComp.state, noCompMeta);
    assert.ok(noCompCmd.getArgumentCompletions);
    expect(await noCompCmd.getArgumentCompletions("al")).toBeNull();
  });
});
