// Consumer-shaped compiled package, with only runtime dependencies and host-supplied peers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostCli, hostIndex } from "./compat-host.mjs";

const root = mkdtempSync(join(tmpdir(), "mcp-package-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" && command === "npm.cmd" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
let session;
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [pack] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", root], process.cwd()));
  run("tar", ["-xzf", join(root, pack.filename), "-C", root], root);
  const packageRoot = join(root, "package");
  run(npm, ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], packageRoot);
  for (const file of ["dist/index.js", "dist/index.d.ts", "dist/mcp-script-worker.mjs", "dist/mcp-keyring-helper.cjs", "dist/app-bridge.bundle.js"]) assert.ok(readFileSync(join(packageRoot, file)).length, file);
  Object.assign(process.env, env);
  const sdk = await import(pathToFileURL(hostIndex).href);
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [packageRoot] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  assert.equal(resourceLoader.getExtensions().extensions[0].resolvedPath, join(packageRoot, "dist/index.js"));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: sdk.SessionManager.create(root, join(root, "sessions")), noTools: "builtin" }));
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  assert.ok(session.getAllTools().some(tool => tool.name === "mcp"));
  await session.reload();
  assert.deepEqual(errors, []);
  if (process.env.PI_COMPAT_HOST === "fork") {
    assert.equal(typeof session.acquireCheckpoint, "function", "fork checkpoint hook is required");
    const hold = await session.acquireCheckpoint({ quiesce: () => () => {}, signal: AbortSignal.timeout(10_000) });
    try { assert.equal(hold.sleepReady, true, JSON.stringify(hold.sleepBlockers)); }
    finally { hold.release(); }
  }
  const marker = join(root, "cli.json");
  const observer = join(root, "observer.ts");
  writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function(pi) { pi.on("session_start", (_event, ctx) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(pi.getAllTools().map(t => t.name))); ctx.shutdown(); }); }`);
  const child = spawnSync(process.execPath, [hostCli, "--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--approve", "-e", packageRoot, "-e", observer], { cwd: root, env, input: "", encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
  assert.doesNotMatch(child.stderr, /Failed to load extension|Extension error/);
  assert.ok(JSON.parse(readFileSync(marker, "utf8")).includes("mcp"));
  console.log("[compat-package] runtime-only artifact, native SDK reload, and bundled CLI passed");
} finally {
  try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
  finally { rmSync(root, { recursive: true, force: true }); }
}
