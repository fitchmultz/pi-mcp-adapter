// Offline real AgentSession and local MCP wire proof, reused for source and packed consumers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostCli, hostIndex, hostRoot } from "./compat-host.mjs";

/** @param {string} packageRoot */
export async function verifyNativeTools(packageRoot) {
  const sdk = await import(pathToFileURL(hostIndex).href);
  // This import is ordinary ESM, not Jiti's compatibility superset.
  const { createMcpAdapter } = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
  const root = await mkdtemp(join(tmpdir(), "mcp-native-contracts-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  /** @type {unknown[]} */
  const effects = [];
  /** @type {import("node:http").ServerResponse<import("node:http").IncomingMessage> | undefined} */
  let held;
  /** @type {(() => void) | undefined} */
  let holdStarted;
  const started = new Promise(
    /**
     * @param {(value?: void) => void} resolve
     */
    (resolve) => {
      holdStarted = resolve;
    },
  );
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const instructions = "Complete native namespace instructions. ".repeat(100);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let text = "";
    for await (const chunk of req) {
      text += chunk;
    }
    const message = JSON.parse(text);
    if (message.method.startsWith("notifications/")) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "server/discover") {
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions,
      };
    } else if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
        instructions,
      };
    } else if (message.method === "tools/list") {
      result = {
        resultType: "complete",
        ttlMs: 1000,
        cacheScope: "private",
        tools: [
          {
            name: "echo",
            description: "Fixture echo",
            inputSchema: schema,
            outputSchema: schema,
            annotations: { readOnlyHint: true },
          },
          {
            name: "app_only",
            description: "Not model-callable",
            inputSchema: schema,
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      };
    } else if (message.method === "resources/list") {
      result = { resultType: "complete", resources: [] };
    } else if (message.method === "tools/call") {
      const value = message.params.arguments.value;
      effects.push(value);
      if (value === "hold") {
        held = res;
        holdStarted?.();
        return;
      }
      result = {
        resultType: "complete",
        content: [{ type: "text", text: `Human ${value}` }],
        structuredContent: { value },
        _meta: { private: "SYNTHETIC-SECRET" },
        ...(value === "fail" ? { isError: true } : {}),
      };
    } else {
      result = { resultType: "complete" };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(
    /**
     * @param {(value?: void) => void} resolve
     */
    (resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    },
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "compat server must report a port");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = {
    id: "fixture",
    name: "fixture",
    api: "openai-completions",
    provider: "fixture",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  };
  modelRuntime.registerProvider("fixture", {
    api: model.api,
    baseUrl: url,
    apiKey: "synthetic",
    models: [model],
  });
  /** @type {import("@earendil-works/pi-coding-agent").AgentSession[]} */
  const sessions = [];
  const captured = join(root, "capture.jsonl");
  /**
   * @param {{ manager?: unknown, directTools?: boolean | string[], disabled?: boolean, tools?: string[], eager?: boolean }} [options]
   */
  async function make({
    manager = sdk.SessionManager.inMemory(root),
    directTools = false,
    disabled = false,
    tools,
    eager = false,
  } = {}) {
    const settingsManager = sdk.SettingsManager.inMemory();
    const config = {
      mcpServers: {
        local: { url, auth: false, directTools, disabled, lifecycle: eager ? "eager" : "lazy" },
      },
      settings: { sampling: false, elicitation: false },
    };
    const adapter = createMcpAdapter({
      config,
      outputDirectory: join(root, "output"),
      onToolCall: async (/** @type {import("../types.js").McpToolCallEvent} */ event) => {
        appendFileSync(
          captured,
          JSON.stringify({
            phase: event.phase,
            toolCallId: event.toolCallId,
            args: event.args,
            ...(event.phase === "after" && "result" in event ? { result: event.result } : {}),
            ...(event.phase === "after" && "error" in event ? { error: String(event.error) } : {}),
          }) + "\n",
          { mode: 0o600 },
        );
      },
    });
    const probe = (/** @type {import("@earendil-works/pi-coding-agent").ExtensionAPI} */ pi) => {
      pi.registerTool({
        name: "native_probe",
        label: "Native probe",
        description: "Native test composition",
        parameters: { type: "object" },
        async execute(_id, params, signal, _update, ctx) {
          const outcome = await ctx.executeTool(
            "local_echo",
            params,
            signal !== undefined ? { signal } : {},
          );
          return {
            content: [{ type: "text", text: "Native probe completed" }],
            details: { outcome },
          };
        },
      });
      pi.on("tool_call", (event) => {
        const input = /** @type {Record<string, unknown>} */ (event.input);
        return event.toolName === "local_echo" && input.value === "blocked"
          ? { block: true, reason: "fixture policy" }
          : undefined;
      });
      pi.on("tool_result", (event) => {
        const structured = /** @type {Record<string, unknown> | undefined} */ (
          event.structuredContent
        );
        return event.toolName === "local_echo" && structured?.value === "redact"
          ? { content: [{ type: "text", text: "Redacted" }] }
          : undefined;
      });
    };
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [adapter, probe, sdk.createCodemodeExtension({ models: false })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader,
      modelRuntime,
      model,
      sessionManager: manager,
      noTools: "builtin",
      ...(tools ? { tools } : {}),
    });
    sessions.push(session);
    await session.bindExtensions({
      mode: "print",
      onError(/** @type {{ error: string }} */ error) {
        throw new Error(error.error);
      },
    });
    return session;
  }
  /**
   * @typedef {object} NativeProbeOutcome
   * @property {boolean} isError
   * @property {{ structuredContent?: unknown; content?: unknown }} result
   *
   * @typedef {object} NativeToolResult
   * @property {boolean} isError
   * @property {Array<{ text: string }>} content
   * @property {string} toolCallId
   * @property {{ calls: Array<{ id: string; status: string; [key: string]: unknown }> }} nestedCalls
   * @property {{ outcome: NativeProbeOutcome; outputGuard?: { fullOutputPath: string }; totalCharacters?: number; nextOffset?: number }} details
   */

  /**
   * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @returns {Promise<NativeToolResult>}
   */
  async function run(session, name, args) {
    let issued = false;
    const before = session.messages.length;
    session.agent.streamFunction = /** @type {import("@earendil-works/pi-agent-core").StreamFn} */ (
      /** @type {unknown} */ (
        async () => {
          const call = !issued;
          issued = true;
          const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: call
              ? [{ type: "toolCall", id: `outer-${before}`, name, arguments: args }]
              : [{ type: "text", text: "done" }],
            stopReason: call ? "toolUse" : "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason: message.stopReason, message };
            },
            result: async () => message,
          };
        }
      )
    );
    await session.prompt("Exercise native local composition.");
    const toolResult = session.messages
      .slice(before)
      .find((/** @type {{ role: string }} */ message) => message.role === "toolResult");
    assert.ok(toolResult, `run(${name}) must produce a tool result`);
    return /** @type {NativeToolResult} */ (/** @type {unknown} */ (toolResult));
  }
  try {
    let session = await make();
    const anchor = session.sessionManager.appendCustomEntry("before-selection", {});
    assert.ok(!session.getCallableToolNames().includes("local_echo"));
    assert.equal(
      (await run(session, "native_probe", { value: "inactive" })).details.outcome.isError,
      true,
    );
    assert.deepEqual(effects, []);
    const discovered = await run(session, "mcp_search", { query: "echo", server: "local" });
    assert.ok(session.getCallableToolNames().includes("local_echo"), JSON.stringify(discovered));
    assert.ok(
      !session
        .getAllTools()
        .some((/** @type {{ name: string }} */ tool) => tool.name === "local_app_only"),
    );
    assert.equal(
      session
        .getAllTools()
        .find((/** @type {{ name: string }} */ tool) => tool.name === "local_echo").namespace
        .instructions,
      instructions,
    );
    const success = await run(session, "native_probe", { value: "ok" });
    assert.deepEqual(success.details.outcome.result.structuredContent, { value: "ok" });
    assert.equal(success.details.outcome.isError, false);
    const firstCall = success.nestedCalls.calls[0];
    assert.ok(firstCall, "native nested call must be recorded");
    assert.ok(firstCall.id.startsWith(success.toolCallId + "/"));
    assert.equal(firstCall.status, "ok");
    assert.ok(!("result" in firstCall));
    const failure = await run(session, "native_probe", { value: "fail" });
    assert.equal(failure.details.outcome.isError, true);
    assert.deepEqual(failure.details.outcome.result.structuredContent, { value: "fail" });
    assert.match(JSON.stringify(failure.details.outcome.result.content), /Human fail/);
    const redacted = await run(session, "native_probe", { value: "redact" });
    assert.equal(redacted.details.outcome.result.structuredContent, undefined);
    assert.deepEqual(redacted.details.outcome.result.content, [{ type: "text", text: "Redacted" }]);
    const count = effects.length;
    assert.equal(
      (await run(session, "native_probe", { value: "blocked" })).details.outcome.isError,
      true,
    );
    assert.equal(
      (await run(session, "native_probe", { wrong: true })).details.outcome.isError,
      true,
    );
    assert.equal(effects.length, count);
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    const coded = await run(session, "codemode", {
      code: 'return await tools.local_echo({value:"coded"});',
    });
    assert.equal(coded.isError, false);
    assert.match(JSON.stringify(coded.content), /coded/);
    assert.doesNotMatch(JSON.stringify(coded.content), /SYNTHETIC-SECRET|Human coded/);
    const selected = session.sessionManager.getLeafId();
    await session.navigateTree(anchor, { summarize: false });
    assert.ok(!session.getCallableToolNames().includes("local_echo"));
    await session.navigateTree(selected, { summarize: false });
    assert.ok(session.getCallableToolNames().includes("local_echo"));
    await session.reload();
    assert.ok(session.getCallableToolNames().includes("local_echo"));
    const manager = session.sessionManager;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    sessions.splice(sessions.indexOf(session), 1);
    session = await make({ manager });
    assert.ok(
      session.getCallableToolNames().includes("local_echo"),
      "initial SDK resume restores selection despite native gap",
    );
    await run(session, "mcp_search", { enable: ["gateway", "script"] });
    const historyText = "native é😀\n".repeat(30_000);
    const spilled = await run(session, "mcp_script", {
      code: 'emit("native é😀\\n".repeat(30_000));',
    });
    assert.ok(spilled.details.outputGuard, "spilled output must record its guard path");
    const ref = spilled.details.outputGuard.fullOutputPath;
    for (const offset of [0, 220_000, 11_000]) {
      const page = await run(session, "mcp", { action: "read-result", ref, offset, limit: 110 });
      const pageBlock = page.content[0];
      assert.ok(pageBlock, "saved output must have a first content block");
      assert.equal(pageBlock.text, historyText.slice(offset, offset + 110));
      assert.equal(page.details.totalCharacters, historyText.length);
      assert.equal(page.details.nextOffset, offset + 110);
    }
    const scriptPage = await run(session, "mcp_script", {
      code: `const page = await tools.readResult({ref:${JSON.stringify(ref)},offset:220000,limit:110}); emit(page.content[0].text);`,
    });
    const scriptBlock = scriptPage.content[0];
    assert.ok(scriptBlock, "script page must have a first content block");
    assert.equal(scriptBlock.text, historyText.slice(220_000, 220_110));
    await writeFile(ref, "redacted é😀");
    const redactedPage = await run(session, "mcp", { action: "read-result", ref });
    const redactedBlock = redactedPage.content[0];
    assert.ok(redactedBlock, "redacted page must have a first content block");
    assert.equal(redactedBlock.text, "redacted é😀");
    assert.equal(redactedPage.details.totalCharacters, "redacted é😀".length);
    console.log(
      "[native-tools] registered gateway + script saved plain-output pages and rewrite invalidation passed",
    );
    const pending = run(session, "native_probe", { value: "hold" });
    await started;
    await session.abort();
    await pending;
    held?.end();
    assert.equal(
      effects.filter((value) => value === "hold").length,
      1,
      "cancelled effect is never replayed",
    );
    assert.match(readFileSync(captured, "utf8"), /SYNTHETIC-SECRET/); // Raw trusted capture is distinct from model output.
    const pins = await make({ directTools: ["echo"], eager: true });
    await run(pins, "mcp_search", { enable: ["gateway"] });
    assert.ok(pins.getCallableToolNames().includes("local_echo"));
    pins.setActiveToolsByName(
      pins.getActiveToolNames().filter((/** @type {string} */ name) => name !== "local_echo"),
    );
    await pins.reload();
    assert.ok(!pins.getCallableToolNames().includes("local_echo"), "disabled pin survives reload");
    const disabled = await make({ directTools: true, disabled: true });
    await run(disabled, "mcp_search", { enable: ["gateway"] });
    assert.ok(
      !disabled
        .getAllTools()
        .some((/** @type {{ name: string }} */ tool) => tool.name === "local_echo"),
    );
    const restricted = await make({ directTools: true, tools: ["mcp_search"] });
    await run(restricted, "mcp_search", { query: "echo", server: "local" });
    assert.deepEqual(restricted.getActiveToolNames(), ["mcp_search"]);
    const cliExtension = join(root, "cli-extension.mjs");
    const cliIdentity = join(root, "cli-identity.json");
    await writeFile(
      cliExtension,
      `
      import { createMcpAdapter } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/index.js")).href)};
      import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
      import { VERSION, getPackageDir } from "@earendil-works/pi-coding-agent";
      import { writeFileSync } from "node:fs";
      export default function(pi) {
        pi.on("session_start", () => writeFileSync(${JSON.stringify(cliIdentity)}, JSON.stringify({ version: VERSION, root: getPackageDir() })));
        createMcpAdapter({ config: { mcpServers: { local: { url: ${JSON.stringify(url)}, auth: false } }, settings: { sampling: false, elicitation: false } } })(pi);
        pi.on("tool_call", event => event.toolName === "local_echo" && event.input.value === "blocked" ? { block: true, reason: "fixture policy" } : undefined);
        pi.on("tool_result", event => event.toolName === "local_echo" && event.structuredContent?.value === "redact" ? { content: [{ type: "text", text: "Redacted" }] } : undefined);
        const steps = [
          { name: "mcp_search", arguments: { query: "echo", server: "local" } },
          ...["coded-cli", "fail", "redact", "blocked"].map(value => ({ name: "codemode", arguments: { code: 'return await tools.local_echo({value:' + JSON.stringify(value) + '});' } })),
        ];
        let stage = 0;
        pi.registerProvider("fixture", { api: ${JSON.stringify(model.api)}, baseUrl: ${JSON.stringify(url)}, apiKey: "synthetic", models: [${JSON.stringify(model)}],
          streamSimple() {
            const call = steps[stage++];
            const message = { role: "assistant", api: ${JSON.stringify(model.api)}, provider: "fixture", model: "fixture", timestamp: Date.now(),
              content: call ? [{ type: "toolCall", id: "cli-" + stage, ...call }] : [{ type: "text", text: "done" }], stopReason: call ? "toolUse" : "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
            return stream;
          }
        });
      }`,
    );
    const executing = promisify(execFileCallback)(
      process.execPath,
      [
        hostCli,
        "--mode",
        "json",
        "--no-session",
        "-ne",
        "-ns",
        "-np",
        "-nc",
        "--no-themes",
        "--approve",
        "-e",
        cliExtension,
        "-e",
        "builtin:codemode",
        "--tools",
        "mcp_search,codemode,local_echo",
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "-p",
        "Run local native contracts.",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          PI_PACKAGE_DIR: hostRoot,
          PI_CODING_AGENT_DIR: join(root, "cli-agent"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
        },
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    executing.child.stdin?.end();
    const { stdout } = await executing;
    const identity = JSON.parse(readFileSync(cliIdentity, "utf8"));
    assert.equal(identity.version, sdk.VERSION);
    assert.equal(identity.root, hostRoot);
    const cliResults = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "message_end" && event.message.role === "toolResult")
      .map((event) => event.message);
    assert.equal(cliResults.length, 5);
    assert.match(JSON.stringify(cliResults[1].content), /coded-cli/);
    assert.doesNotMatch(JSON.stringify(cliResults[1].content), /SYNTHETIC-SECRET|Human coded/);
    assert.match(JSON.stringify(cliResults[2].content), /fail/);
    assert.match(JSON.stringify(cliResults[3].content), /Redacted/);
    assert.equal(cliResults[4].isError, true);
    assert.ok(
      cliResults[1].nestedCalls.calls.some(
        (/** @type {{ name: string }} */ call) => call.name === "local_echo",
      ),
    );
    console.log(
      "[native-tools] standalone ESM + native nested/codemode success/failure/redaction/permission/cancel; selection resume/tree/reload/pins/disabled/restrictions passed",
    );
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    held?.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    modelRuntime.dispose?.();
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node scripts/compat-native-tools.mjs <package-root>\nOffline native SDK/MCP contract smoke. Example: node scripts/compat-native-tools.mjs .\nExit codes: 0 passed, 1 contract failure, 2 invalid arguments.",
    );
  } else if (!process.argv[2]) {
    process.exitCode = 2;
  } else {
    await verifyNativeTools(process.argv[2]);
  }
}
