// Consumer-shaped compiled package, with only runtime dependencies and host-supplied peers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostCli, hostIndex, hostRoot } from "./compat-host.mjs";
import { cliObservationSchema, packResultSchema } from "./compat-consumer-results.mjs";
import { verifyNativeTools } from "./compat-native-tools.mjs";
import { verifyCommands } from "./native-compat/commands.ts";

const root = mkdtempSync(join(tmpdir(), "mcp-package-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  PI_PACKAGE_DIR: hostRoot,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
};
/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32" && command === "npm.cmd",
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${String(result.error ?? "")}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

/** @param {string} consumer */
function linkHostPeers(consumer) {
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    const target = join(consumer, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      const packageDir = findPackageJSON(name, pathToFileURL(hostIndex).href);
      if (packageDir === undefined) {
        throw new Error(`compat-package-smoke: ${name} is not installed in the host graph`);
      }
      symlinkSync(dirname(packageDir), target, "junction");
    }
  }
}

/** @param {string} npm */
function installConsumer(npm) {
  const [pack] = Object.values(
    packResultSchema.parse(
      JSON.parse(run(npm, ["pack", "--json", "--pack-destination", root], process.cwd())),
    ),
  );
  assert.ok(pack, "npm pack must report the consumer tarball");
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@fitchmultz/pi-mcp-adapter": `file:${join(root, pack.filename)}` },
    }),
  );
  run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], consumer);
  // Ordinary ESM consumers supply peers from the exact host graph, not private runtime copies.
  linkHostPeers(consumer);
  return join(consumer, "node_modules", "@fitchmultz", "pi-mcp-adapter");
}

let session;
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const suppliedPackage = process.argv[2];
  const packageRoot =
    suppliedPackage !== undefined && suppliedPackage !== ""
      ? resolve(suppliedPackage)
      : installConsumer(npm);
  verifyCommands(packageRoot, root);
  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/mcp-keyring-helper.cjs",
    "dist/app-bridge.bundle.js",
  ]) {
    assert.ok(readFileSync(join(packageRoot, file)).length > 0, file);
  }
  Object.assign(process.env, env);
  const sdk = await import("@earendil-works/pi-coding-agent");
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [packageRoot],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  assert.equal(
    resourceLoader.getExtensions().extensions[0]?.resolvedPath,
    join(packageRoot, "dist/index.js"),
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  ({ session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: sdk.SessionManager.create(root, join(root, "sessions")),
    noTools: "builtin",
  }));
  /** @type {unknown[]} */
  const errors = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  assert.ok(session.getAllTools().some((tool) => tool.name === "mcp"));
  assert.deepEqual(session.getActiveToolNames(), ["mcp"], "the gateway is active from startup");
  await session.reload();
  assert.deepEqual(session.getActiveToolNames(), ["mcp"], "the gateway stays active after reload");
  assert.deepEqual(errors, []);
  assert.equal(
    resourceLoader.getExtensions().extensions[0]?.resolvedPath,
    join(packageRoot, "dist/index.js"),
  );
  assert.ok(
    session.getAllTools().some((tool) => tool.name === "mcp"),
    "after reload: mcp",
  );
  const marker = join(root, "cli.json");
  const observer = join(root, "observer.ts");
  copyFileSync(new URL("./compat-cli-observer.ts", import.meta.url), observer);
  const child = spawnSync(
    process.execPath,
    [
      hostCli,
      "--mode",
      "rpc",
      "--no-session",
      "-ne",
      "-ns",
      "-np",
      "-nc",
      "--no-themes",
      "--approve",
      "-e",
      packageRoot,
      "-e",
      observer,
    ],
    {
      cwd: root,
      env: { ...env, PI_COMPAT_OBSERVATION: marker },
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(child.status, 0, `${String(child.error ?? "")}\n${child.stderr}`);
  assert.doesNotMatch(child.stderr, /Failed to load extension|Extension error/);
  const observed = cliObservationSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  assert.equal(observed.version, sdk.VERSION);
  assert.equal(
    realpathSync(observed.packageDir),
    hostRoot,
    "CLI loader must use the selected host graph",
  );
  assert.ok(observed.tools.includes("mcp"), "CLI tool mcp");
  assert.ok(observed.activeTools.includes("mcp"), "CLI gateway starts active");
  for (const removed of ["mcp_search", "mcp_script"]) {
    assert.ok(!observed.tools.includes(removed), `CLI has no ${removed}`);
  }
  for (const name of ["mcp", "mcp-auth"]) {
    assert.ok(observed.commands.includes(name), `CLI command ${name}`);
  }
  await verifyNativeTools(packageRoot);
  console.log(
    `[compat-package] ${suppliedPackage !== undefined && suppliedPackage !== "" ? "supplied consumer" : "npm install"}, native SDK reload, and bundled CLI passed`,
  );
} finally {
  try {
    if (session !== undefined) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
