const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, readSync, writeSync } = require("node:fs");

/** @type {Map<string, string>} */
const entries = new Map();
const backingFile = process.env.PI_MCP_ADAPTER_FAKE_NATIVE_KEYRING;
let paused = false;

function readEntries() {
  if (backingFile === undefined) {
    return entries;
  }
  /** @type {unknown} */
  const stored = JSON.parse(readFileSync(backingFile, "utf8"));
  assert(typeof stored === "object" && stored !== null);
  entries.clear();
  for (const [key, value] of Object.entries(stored)) {
    assert(typeof value === "string");
    entries.set(key, value);
  }
  return entries;
}

function persist() {
  if (backingFile !== undefined) {
    writeFileSync(backingFile, JSON.stringify(Object.fromEntries(entries)));
  }
}

/** @type {{ failure: Error | undefined }} */
const state = { failure: undefined };

class Entry {
  /** @param {string} service @param {string} account */
  constructor(service, account) {
    this.account = service + account;
  }

  getPassword() {
    if (state.failure !== undefined) {
      throw state.failure;
    }
    const value = readEntries().get(this.account) ?? null;
    if (
      process.env.PI_MCP_ADAPTER_PAUSE_CHUNK_READ === "1" &&
      this.account.includes(".chunk.") &&
      !paused
    ) {
      paused = true;
      writeSync(1, "reading-chunk\n");
      assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1);
    }
    return value;
  }

  /** @param {string} value */
  setPassword(value) {
    if (state.failure !== undefined) {
      throw state.failure;
    }
    readEntries().set(this.account, value);
    persist();
  }

  deleteCredential() {
    if (state.failure !== undefined) {
      throw state.failure;
    }
    const removed = readEntries().delete(this.account);
    persist();
    return removed;
  }
}

class AsyncEntry {
  /** @param {string} service @param {string} account */
  constructor(service, account) {
    this.entry = new Entry(service, account);
  }

  async getPassword() {
    return this.entry.getPassword();
  }

  /** @param {string} value */
  async setPassword(value) {
    this.entry.setPassword(value);
  }

  async deleteCredential() {
    return this.entry.deleteCredential();
  }
}

exports.Entry = Entry;
exports.AsyncEntry = AsyncEntry;
Object.defineProperty(exports, "failure", {
  enumerable: true,
  get() {
    return state.failure;
  },
  /** @param {Error | undefined} value */
  set(value) {
    state.failure = value;
  },
});
