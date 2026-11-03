const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");

// The isolation suite retains service/account keys; the storage suite inspects
// account-only keys. Both drive the real recovery child-process JSON protocol.
const isolationPath = process.env.FITCH_TEST_KEYRING;
const isolation = isolationPath !== undefined;
const path = isolationPath ?? process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE;
assert.ok(path !== undefined);
/** @type {unknown} */
const request = JSON.parse(readFileSync(0, "utf8"));
assert.ok(typeof request === "object" && request !== null);
assert.ok("operation" in request && typeof request.operation === "string");
assert.ok("account" in request && typeof request.account === "string");
assert.ok("service" in request && typeof request.service === "string");
/** @type {Record<string, string>} */
const entries = {};
if (isolation || existsSync(path)) {
  /** @type {unknown} */
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof stored === "object" && stored !== null);
  for (const [key, value] of Object.entries(stored)) {
    assert.ok(typeof value === "string");
    entries[key] = value;
  }
}
const key = isolation ? `${request.service}\0${request.account}` : request.account;
/** @param {unknown} response */
function respond(response) {
  process.stdout.write(JSON.stringify(response) + (isolation ? "" : "\n"));
}
if (request.operation === "read") {
  const value = entries[key];
  respond(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value });
} else if (request.operation === "write" || request.operation === "remove") {
  if (request.operation === "write") {
    if (isolation && process.env.FITCH_TEST_FAIL_WRITE === "1") {
      throw new Error("Fixture write failure");
    }
    assert.ok("payload" in request && typeof request.payload === "string");
    entries[key] = request.payload;
  } else {
    delete entries[key];
  }
  writeFileSync(path, JSON.stringify(entries));
  respond({ ok: true });
} else if (isolation) {
  throw new Error("Unexpected keyring operation");
} else {
  respond({ ok: false, error: "bad op" });
  process.exitCode = 1;
}
