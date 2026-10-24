import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" }, fixtures: { type: "string" }, timestamp: { type: "string" }, identity: { type: "string" } } });
const fixtureTime = Number(values.timestamp ?? Date.now());
assert.ok(Number.isFinite(fixtureTime) && fixtureTime > 0);
assert.ok(values.source && values.output && values.fixtures);
const source = resolve(values.source);
const root = resolve(values.fixtures);
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "fitch-mcp-adapter"), { recursive: true });
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" });
delete process.env.MCP_DIRECT_TOOLS;
const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const sdkIndex = realpathSync(join(source, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const sdkPackage = dirname(dirname(sdkIndex));
const sdkManifest = JSON.parse(readFileSync(join(sdkPackage, "package.json")));
const installedLock = realpathSync(join(source, "node_modules/.package-lock.json"));
const hostIdentity = values.identity ? JSON.parse(readFileSync(values.identity)) : null;
const actualHost = { sdkIndex, sdkIndexSha256: sha256(sdkIndex), cliPath: join(sdkPackage, sdkManifest.bin.pi),
  installedLock, installedLockSha256: sha256(installedLock) };
actualHost.cliSha256 = sha256(actualHost.cliPath);
if (hostIdentity) {
  assert.equal(actualHost.sdkIndexSha256, hostIdentity.selected.indexSha256);
  assert.equal(actualHost.cliSha256, hostIdentity.selected.cliSha256);
  assert.equal(actualHost.installedLockSha256, hostIdentity.selectedInstalledLock.sha256);
  assert.equal(sha256(hostIdentity.hostLock.path), hostIdentity.hostLock.sha256);
  for (const artifact of hostIdentity.artifacts) assert.equal(sha256(artifact.path), artifact.sha256);
}
const sdk = await import(pathToFileURL(sdkIndex).href);
const cacheModule = await import(pathToFileURL(join(source, "dist/metadata-cache.js")).href);
const config = { mcpServers: {}, settings: { sampling: false, elicitation: false } };
const servers = {};
const descriptor = "Public synthetic schema documentation. ".repeat(42);
for (let server = 0; server < 54; server++) {
  const name = server < 8 ? `fixture${server}` : `recovery-${server}`;
  const definition = { command: "synthetic-never-spawned", lifecycle: "lazy" };
  if (server < 8) config.mcpServers[name] = definition;
  servers[name] = { configHash: cacheModule.computeServerHash(definition), cachedAt: fixtureTime - (server < 8 ? 0 : 9 * 86400000), resources: [],
    tools: Array.from({ length: server < 8 ? 80 : 40 }, (_, i) => ({ name: `tool${i}`, description: `Synthetic tool ${i}`, inputSchema: { type: "object", properties: { query: { type: "string", description: descriptor } } } })) };
}
const cachePath = join(agentDir, "fitch-mcp-adapter/mcp-cache.json");
const serialized = JSON.stringify({ version: 2, servers });
writeFileSync(cachePath, serialized);
const configPath = join(agentDir, "fitch-mcp-adapter/mcp.json");
writeFileSync(configPath, JSON.stringify(config));
const implementation = { commit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runtimeSha256: Object.fromEntries(["metadata-cache", "tool-loader", "init"].map(name => [name, sha256(join(source, `dist/${name}.js`))])) };
const report = { node: process.version, hostVersion: sdk.VERSION, actualHost, hostIdentity, implementation, source, fixtureTime, metadataSha256: createHash("sha256").update(serialized).digest("hex"), cacheBytes: Buffer.byteLength(serialized), configuredServers: 8, cachedServers: 54, cachedTools: 2480,
  requests: [], micro: [], switchSession: [], sessionTree: [], work: { cacheLoads: 0, switches: 0, treeNavigations: 0, registeredTools: 0, errors: 0 } };
for (let i = 0; i < 12; i++) {
  const start = performance.now();
  const cache = cacheModule.loadMetadataCache();
  report.micro.push(performance.now() - start);
  assert.equal(Object.keys(cache.servers).length, 54);
  assert.equal(cache.servers.fixture0.tools[79].name, "tool79");
  report.work.cacheLoads++;
  report.requests.push({ kind: "cache-load", iteration: i, cachedServers: 54, lastTool: "tool79", assertionsPassed: true });
}
const settingsManager = sdk.SettingsManager.inMemory();
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
const paths = [];
const branches = new Map();
for (let i = 0; i < 2; i++) {
  const manager = sdk.SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "synthetic", model: "fixture", timestamp: fixtureTime, content: [{ type: "text", text: "Public synthetic session." }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  for (let row = 0; row < 400; row++) manager.appendCustomEntry("synthetic-history", { row, text: "Public synthetic history. ".repeat(80) });
  const first = manager.appendCustomEntry("mcp-tool-selection", { selected: [{ server: "fixture0", tool: "tool0" }], features: [] });
  const second = manager.appendCustomEntry("mcp-tool-selection", { selected: [{ server: "fixture1", tool: "tool1" }], features: ["gateway"] });
  const path = manager.getSessionFile();
  assert.ok(path);
  paths.push(path);
  branches.set(path, { first, second });
}
async function createRuntime(options) {
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(source, "dist/index.js")] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const result = await sdk.createAgentSession({ ...options, settingsManager, resourceLoader, modelRuntime, noTools: "builtin" });
  result.session.extensionRunner.setFlagValue("mcp-config", configPath);
  await result.session.bindExtensions({ mode: "print", onError: error => { report.work.errors++; throw new Error(error.error); } });
  return { ...result, services: { cwd: root, agentDir }, diagnostics: [] };
}
const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager: sdk.SessionManager.open(paths[0]) });
try {
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    assert.deepEqual(await runtime.switchSession(paths[i % 2]), { cancelled: false });
    await new Promise(resolve => setImmediate(resolve));
    report.switchSession.push(performance.now() - start);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ["fixture1_tool1", "mcp", "mcp_search"]);
    assert.equal(runtime.session.getAllTools().filter(tool => /^fixture\d_tool\d+$/.test(tool.name)).length, 640);
    report.work.switches++;
    report.requests.push({ kind: "session-switch", iteration: i, exposedTools: 640, active: runtime.session.getActiveToolNames().sort(), assertionsPassed: true });
    const branch = branches.get(paths[i % 2]);
    const treeStart = performance.now();
    assert.equal((await runtime.session.navigateTree(branch.first, { summarize: false })).cancelled, false);
    report.sessionTree.push(performance.now() - treeStart);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ["fixture0_tool0", "mcp_search"]);
    report.requests.push({ kind: "tree-first", iteration: i, active: runtime.session.getActiveToolNames().sort(), assertionsPassed: true });
    assert.equal((await runtime.session.navigateTree(branch.second, { summarize: false })).cancelled, false);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ["fixture1_tool1", "mcp", "mcp_search"]);
    report.requests.push({ kind: "tree-second", iteration: i, active: runtime.session.getActiveToolNames().sort(), assertionsPassed: true });
    report.work.treeNavigations += 2;
    report.work.registeredTools = runtime.session.getAllTools().length;
  }
} finally {
  await runtime.dispose();
  writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
}
assert.equal(report.work.errors, 0);
assert.ok(readFileSync(paths[0]).length > 800000);
console.log(JSON.stringify(report));
