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

export async function verifyNativeTools(packageRoot) {
  const sdk = await import(pathToFileURL(hostIndex).href);
  // This import is ordinary ESM, not Jiti's compatibility superset.
  const { createMcpAdapter } = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
  const root = await mkdtemp(join(tmpdir(), "mcp-native-contracts-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const effects = [];
  let held;
  let holdStarted;
  const started = new Promise(resolve => { holdStarted = resolve; });
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  const instructions = "Complete native namespace instructions. ".repeat(100);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    if (message.method.startsWith("notifications/")) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === "server/discover") result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, instructions };
    else if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions };
    else if (message.method === "tools/list") result = { resultType: "complete", ttlMs: 1000, cacheScope: "private", tools: [
      { name: "echo", description: "Fixture echo", inputSchema: schema, outputSchema: schema, annotations: { readOnlyHint: true } },
      { name: "app_only", description: "Not model-callable", inputSchema: schema, _meta: { ui: { visibility: ["app"] } } },
    ] };
    else if (message.method === "resources/list") result = { resultType: "complete", resources: [] };
    else if (message.method === "tools/call") {
      const value = message.params.arguments.value;
      effects.push(value);
      if (value === "hold") { held = res; holdStarted(); return; }
      result = { resultType: "complete", content: [{ type: "text", text: `Human ${value}` }], structuredContent: { value }, _meta: { private: "SYNTHETIC-SECRET" }, ...(value === "fail" ? { isError: true } : {}) };
    } else result = { resultType: "complete" };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const model = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  modelRuntime.registerProvider("fixture", { api: model.api, baseUrl: url, apiKey: "synthetic", models: [model] });
  const sessions = [];
  const captured = join(root, "capture.jsonl");
  async function make({ manager = sdk.SessionManager.inMemory(root), directTools = false, disabled = false, tools, eager = false } = {}) {
    const settingsManager = sdk.SettingsManager.inMemory();
    const config = { mcpServers: { local: { url, auth: false, directTools, disabled, lifecycle: eager ? "eager" : "lazy" } }, settings: { sampling: false, elicitation: false } };
    const adapter = createMcpAdapter({ config, outputDirectory: join(root, "output"), onToolCall: async event => {
      appendFileSync(captured, JSON.stringify({ phase: event.phase, toolCallId: event.toolCallId, args: event.args, result: event.result, error: event.error ? String(event.error) : undefined }) + "\n", { mode: 0o600 });
    } });
    const probe = pi => {
      pi.registerTool({ name: "native_probe", label: "Native probe", description: "Native test composition", parameters: { type: "object" }, async execute(_id, params, signal, _update, ctx) {
        const outcome = await ctx.executeTool("local_echo", params, { signal });
        return { content: [{ type: "text", text: "Native probe completed" }], details: { outcome } };
      } });
      pi.on("tool_call", event => event.toolName === "local_echo" && event.input.value === "blocked" ? { block: true, reason: "fixture policy" } : undefined);
      pi.on("tool_result", event => event.toolName === "local_echo" && event.structuredContent?.value === "redact" ? { content: [{ type: "text", text: "Redacted" }] } : undefined);
    };
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [adapter, probe, sdk.createCodemodeExtension({ models: false })] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model, sessionManager: manager, noTools: "builtin", ...(tools ? { tools } : {}) });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
    return session;
  }
  async function run(session, name, args) {
    let issued = false;
    const before = session.messages.length;
    session.agent.streamFunction = async () => {
      const call = !issued; issued = true;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [{ type: "toolCall", id: `outer-${before}`, name, arguments: args }] : [{ type: "text", text: "done" }], stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.prompt("Exercise native local composition.");
    return session.messages.slice(before).find(message => message.role === "toolResult");
  }
  try {
    let session = await make();
    const anchor = session.sessionManager.appendCustomEntry("before-selection", {});
    assert.ok(!session.getCallableToolNames().includes("local_echo"));
    assert.equal((await run(session, "native_probe", { value: "inactive" })).details.outcome.isError, true);
    assert.deepEqual(effects, []);
    const discovered = await run(session, "mcp_search", { query: "echo", server: "local" });
    assert.ok(session.getCallableToolNames().includes("local_echo"), JSON.stringify(discovered));
    assert.ok(!session.getAllTools().some(tool => tool.name === "local_app_only"));
    assert.equal(session.getAllTools().find(tool => tool.name === "local_echo").namespace.instructions, instructions);
    const success = await run(session, "native_probe", { value: "ok" });
    assert.deepEqual(success.details.outcome.result.structuredContent, { value: "ok" });
    assert.equal(success.details.outcome.isError, false);
    assert.ok(success.nestedCalls.calls[0].id.startsWith(success.toolCallId + "/"));
    assert.equal(success.nestedCalls.calls[0].status, "ok");
    assert.ok(!("result" in success.nestedCalls.calls[0]));
    const failure = await run(session, "native_probe", { value: "fail" });
    assert.equal(failure.details.outcome.isError, true);
    assert.deepEqual(failure.details.outcome.result.structuredContent, { value: "fail" });
    assert.match(JSON.stringify(failure.details.outcome.result.content), /Human fail/);
    const redacted = await run(session, "native_probe", { value: "redact" });
    assert.equal(redacted.details.outcome.result.structuredContent, undefined);
    assert.deepEqual(redacted.details.outcome.result.content, [{ type: "text", text: "Redacted" }]);
    const count = effects.length;
    assert.equal((await run(session, "native_probe", { value: "blocked" })).details.outcome.isError, true);
    assert.equal((await run(session, "native_probe", { wrong: true })).details.outcome.isError, true);
    assert.equal(effects.length, count);
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    const coded = await run(session, "codemode", { code: 'return await tools.local_echo({value:"coded"});' });
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
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
    sessions.splice(sessions.indexOf(session), 1);
    session = await make({ manager });
    assert.ok(session.getCallableToolNames().includes("local_echo"), "initial SDK resume restores selection despite native gap");
    const pending = run(session, "native_probe", { value: "hold" });
    await started;
    await session.abort(); await pending;
    held?.end();
    assert.equal(effects.filter(value => value === "hold").length, 1, "cancelled effect is never replayed");
    assert.match(readFileSync(captured, "utf8"), /SYNTHETIC-SECRET/); // Raw trusted capture is distinct from model output.
    const pins = await make({ directTools: ["echo"], eager: true });
    await run(pins, "mcp_search", { enable: ["gateway"] });
    assert.ok(pins.getCallableToolNames().includes("local_echo"));
    pins.setActiveToolsByName(pins.getActiveToolNames().filter(name => name !== "local_echo"));
    await pins.reload();
    assert.ok(!pins.getCallableToolNames().includes("local_echo"), "disabled pin survives reload");
    const disabled = await make({ directTools: true, disabled: true });
    await run(disabled, "mcp_search", { enable: ["gateway"] });
    assert.ok(!disabled.getAllTools().some(tool => tool.name === "local_echo"));
    const restricted = await make({ directTools: true, tools: ["mcp_search"] });
    await run(restricted, "mcp_search", { query: "echo", server: "local" });
    assert.deepEqual(restricted.getActiveToolNames(), ["mcp_search"]);
    const cliExtension = join(root, "cli-extension.mjs");
    const cliIdentity = join(root, "cli-identity.json");
    await writeFile(cliExtension, `
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
      }`);
    const executing = promisify(execFileCallback)(process.execPath, [hostCli, "--mode", "json", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--approve", "-e", cliExtension, "-e", "builtin:codemode", "--tools", "mcp_search,codemode,local_echo", "--provider", "fixture", "--model", "fixture", "-p", "Run local native contracts."], {
      cwd: root, env: { ...process.env, HOME: root, PI_PACKAGE_DIR: hostRoot, PI_CODING_AGENT_DIR: join(root, "cli-agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    executing.child.stdin.end();
    const { stdout } = await executing;
    const identity = JSON.parse(readFileSync(cliIdentity, "utf8"));
    assert.equal(identity.version, sdk.VERSION);
    assert.equal(identity.root, hostRoot);
    const cliResults = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "message_end" && event.message.role === "toolResult").map(event => event.message);
    assert.equal(cliResults.length, 5);
    assert.match(JSON.stringify(cliResults[1].content), /coded-cli/);
    assert.doesNotMatch(JSON.stringify(cliResults[1].content), /SYNTHETIC-SECRET|Human coded/);
    assert.match(JSON.stringify(cliResults[2].content), /fail/);
    assert.match(JSON.stringify(cliResults[3].content), /Redacted/);
    assert.equal(cliResults[4].isError, true);
    assert.ok(cliResults[1].nestedCalls.calls.some(call => call.name === "local_echo"));
    console.log("[native-tools] standalone ESM + native nested/codemode success/failure/redaction/permission/cancel; selection resume/tree/reload/pins/disabled/restrictions passed");
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    held?.end(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    modelRuntime.dispose?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/compat-native-tools.mjs <package-root>\nOffline native SDK/MCP contract smoke. Example: node scripts/compat-native-tools.mjs .\nExit codes: 0 passed, 1 contract failure, 2 invalid arguments.");
  } else if (!process.argv[2]) process.exitCode = 2;
  else await verifyNativeTools(process.argv[2]);
}
