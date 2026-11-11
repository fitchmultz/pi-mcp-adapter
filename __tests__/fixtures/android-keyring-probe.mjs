import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";

// This process simulates Android. No hardware, real native code, browser or network.
const blocked = () => {
  throw new Error("External access forbidden in Android diagnostic probe");
};
childProcess.spawn = blocked;
childProcess.spawnSync = blocked;
childProcess.exec = Object.assign(blocked, { __promisify__: blocked });
childProcess.execSync = blocked;
childProcess.execFile = Object.assign(blocked, { __promisify__: blocked });
childProcess.execFileSync = blocked;
childProcess.fork = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
dgram.createSocket = blocked;
net.Server.prototype.listen = blocked;
globalThis.fetch = blocked;
process.dlopen = blocked;
syncBuiltinESMExports();
Object.defineProperty(process, "platform", { value: "android", configurable: true });
Object.defineProperty(process, "arch", { value: "arm64" });
const mode = process.argv[2];
const home = process.cwd();
/** @type {Record<string, unknown>} */
const receipt = {
  mode,
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  version: process.version,
};
// Resolve the typed literal import to the isolated copy prepared by the parent test.
const authUrl = new URL("../../mcp-auth.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (new URL(specifier, context.parentURL).href === authUrl) {
      return nextResolve(pathToFileURL(join(home, "mcp-auth.ts")).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const auth = await import("../../mcp-auth.ts");
hooks.deregister();
const url = "https://unreachable.invalid/mcp";
const server = "android-diagnostic";
const entry = { tokens: { accessToken: "synthetic-only" }, serverUrl: url };
/** @type {[string, () => unknown][]} */
const operations = [
  ["read", () => auth.getAuthForUrl({ serverName: server, serverUrl: url })],
  ["write", () => auth.saveAuthEntry({ serverName: server, serverUrl: url }, entry)],
  ["remove", () => auth.removeAuthEntry({ serverName: server, serverUrl: url })],
];
const legacy = auth.getAuthEntryFilePath(server);
const genericStatus =
  "OAuth credential store unavailable. Configure or unlock the OS credential store and retry.";
const androidMessage = /Android\/Termux.*@napi-rs\/keyring.*native binding.*supported platform/i;

/** @param {unknown} error @returns {Error} */
function asError(error) {
  assert(error instanceof Error);
  return error;
}

/**
 * @param {unknown} [nativeFailure]
 */
function checkFailures(nativeFailure) {
  const errors = operations.map(([operation, run]) => {
    /** @type {unknown} */
    let error;
    try {
      run();
    } catch (caught) {
      error = caught;
    }
    return { operation, error };
  });
  const status = auth.inspectAuthForUrl({ serverName: server, serverUrl: url });
  const messages = errors.map(({ operation, error }) => ({
    operation,
    message: error instanceof Error ? error.message : undefined,
  }));
  for (const { operation, error: caught } of errors) {
    assert(caught instanceof auth.OAuthCredentialStoreError);
    const error = caught;
    assert.equal(error.name, "OAuthCredentialStoreError");
    assert.equal(error.code, "OAUTH_CREDENTIAL_STORE_UNAVAILABLE");
    assert.equal(error.operation, operation);
    if (nativeFailure !== undefined) {
      assert.equal(error.cause, nativeFailure);
      assert.equal(
        error.message,
        `Failed to ${operation} OAuth credentials for ${server} ${operation === "write" ? "to" : "from"} the OS secure credential store`,
      );
    } else {
      assert.match(error.message, androidMessage, JSON.stringify({ messages, status }));
      const loaderError = asError(asError(error.cause).cause);
      assert.match(loaderError.message, /Failed to load @napi-rs\/keyring/);
      assert.match(asError(loaderError.cause).message, /Cannot find native binding/);
      /** @type {Error[]} */
      const loadErrors = [];
      let cause = asError(loaderError.cause).cause;
      while (cause instanceof Error) {
        loadErrors.push(cause);
        cause = cause.cause;
      }
      assert(
        loadErrors.some((loadError) => {
          return mode === "missing"
            ? loadError.message.includes("Cannot find module '@napi-rs/keyring-android-arm64'")
            : loadError.message === "synthetic binding cannot load";
        }),
      );
    }
  }
  assert.equal(status.status, "unavailable");
  if (nativeFailure !== undefined) {
    assert.equal(status.message, genericStatus);
  } else {
    assert.match(status.message, androidMessage);
  }
  return { errors: messages, status };
}

if (mode === "working") {
  assert.equal(auth.getAuthEntry({ serverName: server, serverUrl: url }), undefined);
  auth.saveAuthEntry({ serverName: server, serverUrl: url }, entry);
  assert.deepEqual(auth.getAuthForUrl({ serverName: server, serverUrl: url }), entry);
  assert.deepEqual(auth.inspectAuthForUrl({ serverName: server, serverUrl: url }), {
    status: "present",
    entry,
  });
  auth.removeAuthEntry({ serverName: server, serverUrl: url });
  assert.deepEqual(auth.inspectAuthForUrl({ serverName: server, serverUrl: url }), {
    status: "absent",
  });
  assert.equal(fs.existsSync(dirname(legacy)), false);
  const require = createRequire(join(home, "package.json"));
  /** @type {unknown} */
  const binding = require("@napi-rs/keyring-android-arm64");
  assert(typeof binding === "object" && binding !== null && "failure" in binding);
  binding.failure = new Error("Synthetic credential store locked");
  receipt.androidRuntimeFailure = checkFailures(binding.failure);
  Object.defineProperty(process, "platform", { value: "darwin" });
  receipt.nonAndroidRuntimeFailure = checkFailures(binding.failure);
} else {
  receipt.emptyStore = checkFailures();
  assert.equal(fs.existsSync(dirname(legacy)), false);
  // A sentinel proves unavailable storage neither imports nor deletes legacy data.
  fs.mkdirSync(dirname(legacy), { recursive: true });
  const sentinel = "not credentials; must never be read, imported, replaced or removed";
  fs.writeFileSync(legacy, sentinel);
  const read = fs.readFileSync;
  fs.readFileSync = new Proxy(read, {
    apply(target, receiver, args) {
      /** @type {unknown} */
      const path = args[0];
      assert.notEqual(String(path), legacy, "unavailable store must not read legacy credentials");
      /** @type {unknown} */
      const result = Reflect.apply(target, receiver, args);
      return result;
    },
  });
  syncBuiltinESMExports();
  receipt.unavailable = checkFailures();
  assert.equal(read(legacy, "utf8"), sentinel);
  assert.deepEqual(fs.readdirSync(dirname(legacy)), ["tokens.json"]);
  assert.deepEqual(fs.readdirSync(auth.getAuthBaseDir()), [legacy.split("/").at(-2)]);
}
receipt.passed = true;
console.log(JSON.stringify(receipt));
