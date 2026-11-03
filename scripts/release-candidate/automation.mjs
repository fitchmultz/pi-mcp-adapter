import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
export function readObject(value) {
  assert.ok(isRecord(value), "Expected an object");
  return value;
}

/** @param {unknown} value */
export function readText(value) {
  assert.ok(typeof value === "string", "Expected a string");
  return value;
}

/**
 * No argument or result contract is assumed for a dynamically loaded function.
 * Callers validate results before use; the selected automation owns execution.
 *
 * @param {unknown} value
 * @returns {value is (...args: unknown[]) => unknown}
 */
function isFunction(value) {
  return typeof value === "function";
}

/** @param {unknown} value */
function readFunction(value) {
  assert.ok(isFunction(value), "Shared automation export must be a function");
  return value;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
export function readStringMap(value) {
  /** @type {[string, string][]} */
  const entries = [];
  for (const [key, entry] of Object.entries(readObject(value))) {
    entries.push([key, readText(entry)]);
  }
  return Object.fromEntries(entries);
}

/** @param {unknown} value */
export function readIdentity(value) {
  const identity = readObject(value);
  return {
    original: identity,
    directory: readText(identity.directory),
    packageDir: readText(identity.packageDir),
    packageDirs: readStringMap(identity.packageDirs),
    version: readText(identity.version),
    index: readText(identity.index),
    cli: readText(identity.cli),
    indexSha256: readText(identity.indexSha256),
    cliSha256: readText(identity.cliSha256),
    runtimeLockSha256: readText(identity.runtimeLockSha256),
    runtimeGraphSha256: readText(identity.runtimeGraphSha256),
    cohort: identity.cohort,
    companions: identity.companions,
  };
}

/**
 * This launcher runs before source dependencies are installed. Decode only the
 * exports it uses; shared automation owns provenance and whole-graph validation.
 *
 * @param {string} automation
 */
export async function loadAutomation(automation) {
  const common = readObject(
    await import(pathToFileURL(join(automation, "scripts/common.mjs")).href),
  );
  const hosts = readObject(await import(pathToFileURL(join(automation, "scripts/hosts.mjs")).href));
  return {
    isolatedEnvironment: readFunction(common.isolatedEnvironment),
    readJson: readFunction(common.readJson),
    run: readFunction(common.run),
    sha256: readFunction(common.sha256),
    writeJson: readFunction(common.writeJson),
    hostIdentity: readFunction(hosts.hostIdentity),
    prepareHost: readFunction(hosts.prepareHost),
    selectDevelopmentHost: readFunction(hosts.selectDevelopmentHost),
  };
}
