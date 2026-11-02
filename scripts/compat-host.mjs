// Validate the graph prepared by the compatibility runner; never install a host here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hostPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (hostPackage === undefined) {
  throw new Error("compat-host: @earendil-works/pi-coding-agent is not installed in this graph");
}
export const hostRoot = realpathSync(dirname(hostPackage));
export const hostIndex = join(hostRoot, "dist/index.js");
const manifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
export const hostCli = realpathSync(join(hostRoot, manifest.bin.pi));

const expectations = /** @type {[string, string][]} */ ([
  ["PI_PACKAGE_DIR", hostRoot],
  ["PI_COMPAT_EXPECTED_PACKAGE_DIR", hostRoot],
  ["PI_HOST_INDEX", hostIndex],
  ["PI_HOST_CLI", hostCli],
]);
for (const [name, actual] of expectations) {
  const configured = process.env[name];
  if (configured) {
    assert.equal(
      realpathSync(configured),
      realpathSync(actual),
      `${name} must select the installed graph`,
    );
  }
}

if (process.env.PI_COMPAT_EXPECTED_VERSION) {
  assert.equal(manifest.version, process.env.PI_COMPAT_EXPECTED_VERSION);
}
assert.equal(
  realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  realpathSync(hostIndex),
);
/** @param {string} path */
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(
  JSON.stringify({
    host: process.env.PI_COMPAT_HOST ?? "local",
    version: manifest.version,
    node: process.version,
    hostRoot,
    hostIndex,
    hostCli,
    indexSha256: hash(hostIndex),
    cliSha256: hash(hostCli),
  }),
);
