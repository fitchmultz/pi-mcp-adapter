import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [automationArg, forkArg] = process.argv.slice(2);
assert.ok(automationArg && forkArg, "Usage: node scripts/ci-fork-smoke.mjs AUTOMATION_DIR FORK_DIR");
const automation = resolve(automationArg);
const fork = resolve(forkArg);
const repo = process.cwd();
const { isolatedEnvironment, run } = await import(pathToFileURL(join(automation, "scripts/common.mjs")).href);
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")).href);
const root = mkdtempSync(join(tmpdir(), "mcp-fork-ci-"));
const env = isolatedEnvironment(root);
const hydrateEnv = { ...env, PI_OFFLINE: "0" };

try {
  const ref = run("git", ["rev-parse", "HEAD"], { cwd: fork, quiet: true }).trim();
  assert.match(ref, /^[a-f0-9]{40}$/);
  console.log(`Qualifying fitchmultz/pi ${ref}`);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fork, env: hydrateEnv });
  run("npm", ["run", "hydrate:model-data"], { cwd: fork, env: hydrateEnv });
  run("npm", ["run", "build:offline"], { cwd: fork, env });
  run("git", ["diff", "--exit-code"], { cwd: fork, env });

  const packed = join(root, "fork-package");
  run(process.execPath, [join(automation, "scripts/pack-fork.mjs"), fork, packed, ref], { cwd: repo, env });
  const host = await prepareHost(join(root, "host"), "fork", packed, env);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, env });
  const selected = selectDevelopmentHost(repo, host, env);
  const testEnv = {
    ...env,
    PI_COMPAT_HOST: "fork",
    PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index,
    PI_HOST_CLI: selected.cli,
    PI_PACKAGE_DIR: selected.packageDir,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
  };
  run(process.execPath, ["scripts/compat-host.mjs"], { cwd: repo, env: testEnv });
  run("npm", ["run", "build"], { cwd: repo, env: testEnv });
  run("npm", ["run", "typecheck"], { cwd: repo, env: testEnv });
  run("npm", ["exec", "--", "vitest", "run",
    "__tests__/sdk-v2-http.test.ts",
    "__tests__/pi-reload-real-path.test.ts",
    "__tests__/initialization-abort.test.ts"], { cwd: repo, env: testEnv });
  run(process.execPath, ["scripts/compat-package-smoke.mjs"], { cwd: repo, env: testEnv });
  console.log(`Fork ${ref}: native search, reload, checkpoints, and package CLI passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
