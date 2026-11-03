import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  loadAutomation,
  readIdentity,
  readObject,
  readStringMap,
  readText,
} from "./release-candidate/automation.mjs";

const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    "fork-artifact": { type: "string" },
    automation: { type: "string" },
    repository: { type: "string" },
    "source-ref": { type: "string" },
    "release-source": { type: "string" },
    "official-version": { type: "string" },
    "fork-ref": { type: "string" },
    host: { type: "string" },
    output: { type: "string" },
  },
});
/**
 * @param {Record<string, string | undefined>} options
 * @param {string} key
 * @returns {string}
 */
function required(options, key) {
  const value = options[key];
  assert.ok(value !== undefined && value !== "", `Missing --${key}`);
  return value;
}

for (const key of [
  "artifact",
  "fork-artifact",
  "automation",
  "repository",
  "source-ref",
  "release-source",
  "official-version",
  "fork-ref",
  "host",
  "output",
]) {
  required(values, key);
}
const hostName = required(values, "host");
assert.ok(hostName === "official" || hostName === "fork", "Host must be official or fork");

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(required(values, "artifact"));
const output = resolve(required(values, "output"));
const automation = resolve(required(values, "automation"));
const {
  isolatedEnvironment,
  readJson,
  run,
  sha256,
  writeJson,
  hostIdentity,
  prepareHost,
  selectDevelopmentHost,
} = await loadAutomation(automation);
const release = readObject(readJson(join(artifact, "release.json")));
assert.equal(
  release.repository,
  required(values, "repository"),
  "Candidate repository differs from the caller",
);
assert.equal(release.name, "@fitchmultz/pi-mcp-adapter");
assert.equal(
  release.source,
  required(values, "source-ref"),
  "Candidate source differs from the plan",
);
assert.equal(
  release.releaseSource,
  required(values, "release-source"),
  "Candidate queue source differs from the plan",
);
assert.equal(
  readText(run("git", ["rev-parse", "HEAD"], { cwd: source, quiet: true })).trim(),
  release.source,
);
assert.equal(
  readText(run("git", ["status", "--porcelain"], { cwd: source, quiet: true })).trim(),
  "",
  "Qualification source must be clean",
);
assert.equal(readObject(readJson(join(source, "package.json"))).version, release.version);
const hosts = readObject(release.hosts);
const official = readObject(hosts.official);
const fork = readObject(hosts.fork);
assert.equal(official.version, required(values, "official-version"));
assert.equal(readObject(fork.provenance).ref, required(values, "fork-ref"));
const filename = readText(release.filename);
assert.equal(basename(filename), filename);
const tarball = join(artifact, filename);
assert.equal(sha256(tarball), release.sha256, "Candidate tarball differs from its receipt");

const env = readStringMap(isolatedEnvironment(join(output, "isolation")));
const host = readIdentity(
  await prepareHost(
    join(output, "host"),
    hostName,
    hostName === "official"
      ? required(values, "official-version")
      : resolve(required(values, "fork-artifact")),
    env,
  ),
);
const expected = readObject(hosts[hostName]);
for (const [key, actual] of Object.entries({
  version: host.version,
  indexSha256: host.indexSha256,
  cliSha256: host.cliSha256,
  runtimeLockSha256: host.runtimeLockSha256,
  runtimeGraphSha256: host.runtimeGraphSha256,
})) {
  assert.equal(actual, expected[key], `${hostName} host ${key} differs from candidate preparation`);
}
assert.deepEqual(host.cohort, expected.cohort, `${hostName} host Pi cohort differs`);
assert.deepEqual(host.companions, expected.companions, `${hostName} host companions differ`);
const selected = readIdentity(selectDevelopmentHost(source, host.original, env));

const consumer = join(output, "consumer");
mkdirSync(consumer, { recursive: true });
writeJson(join(consumer, "package.json"), {
  private: true,
  dependencies: { [release.name]: `file:${tarball}` },
});
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps"], {
  cwd: consumer,
  env,
});
for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]) {
  const target = join(consumer, "node_modules", name);
  assert.ok(!existsSync(target), `Consumer unexpectedly installed its own ${name} peer`);
  const packageDir = host.packageDirs[name];
  assert.ok(packageDir !== undefined, `Selected host does not supply ${name}`);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(packageDir, target, "junction");
  assert.equal(realpathSync.native(target), packageDir);
}
const installed = join(consumer, "node_modules", release.name);
assert.equal(readObject(readJson(join(installed, "package.json"))).version, release.version);
const runtimeEnv = {
  ...env,
  PI_COMPAT_HOST: hostName,
  PI_COMPAT_EXPECTED_VERSION: host.version,
  PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
  PI_HOST_INDEX: selected.index,
  PI_HOST_CLI: selected.cli,
};
run(process.execPath, ["scripts/compat-package-smoke.mjs", installed], {
  cwd: source,
  env: runtimeEnv,
});
run(process.execPath, ["scripts/check-consumer-types.mjs", installed], {
  cwd: source,
  env: runtimeEnv,
});
assert.equal(sha256(tarball), release.sha256, "Candidate tarball changed during qualification");
assert.equal(
  readIdentity(hostIdentity(host.directory, env)).runtimeGraphSha256,
  host.runtimeGraphSha256,
  "Selected host graph changed during qualification",
);
assert.equal(
  readText(run("git", ["status", "--porcelain"], { cwd: source, quiet: true })).trim(),
  "",
  "Qualification modified source files",
);
writeJson(join(output, "report.json"), {
  source: release.source,
  releaseSource: release.releaseSource,
  candidateSha256: release.sha256,
  candidateVersion: release.version,
  host: hostName,
  hostVersion: host.version,
  indexSha256: host.indexSha256,
  cliSha256: host.cliSha256,
  runtimeLockSha256: host.runtimeLockSha256,
  runtimeGraphSha256: host.runtimeGraphSha256,
});
