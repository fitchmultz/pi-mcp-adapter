#!/usr/bin/env node
"use strict";

const { createRequire } = require("node:module");
const path = require("node:path");

const requireFromHere = createRequire(__filename);

/** @param {unknown} error @returns {unknown} */
function errorMessage(error) {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    "message" in error
  ) {
    return error.message;
  }
  return;
}

function loadKeyringEntryClass() {
  try {
    return require("@napi-rs/keyring").Entry;
  } catch (loaderError) {
    const suffixes = getNativeBindingSuffixes(process.platform, process.arch);
    let lastError;
    for (const suffix of suffixes) {
      try {
        const packageJsonPath = requireFromHere.resolve(`@napi-rs/keyring-${suffix}/package.json`);
        /** @type {unknown} */
        const binding = requireFromHere(
          path.join(path.dirname(packageJsonPath), `keyring.${suffix}.node`),
        );
        return /** @type {Pick<typeof import("@napi-rs/keyring"), "Entry">} */ (binding).Entry;
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(
      `Failed to load @napi-rs/keyring in recovery helper: ${String(errorMessage(lastError) ?? errorMessage(loaderError))}`,
    );
    error.cause = loaderError;
    throw error;
  }
}

/** @param {string} platform @param {string} arch */
function getNativeBindingSuffixes(platform, arch) {
  if (platform === "linux") {
    if (arch === "arm64") {
      return ["linux-arm64-gnu", "linux-arm64-musl"];
    }
    if (arch === "arm") {
      return ["linux-arm-gnueabihf"];
    }
    if (arch === "riscv64") {
      return ["linux-riscv64-gnu"];
    }
    if (arch === "x64") {
      return ["linux-x64-gnu", "linux-x64-musl"];
    }
  }
  return [];
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on(
      "data",
      /** @param {string} chunk */ (chunk) => {
        input += chunk;
        if (input.length > 1024 * 1024) {
          reject(new Error("request too large"));
          process.stdin.destroy();
        }
      },
    );
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

/** @param {unknown} response */
function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** @param {unknown} value @param {string} field */
function requiredString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

/** @param {unknown} request */
function parseRequest(request) {
  if (request === null || typeof request !== "object") {
    throw new Error("invalid request");
  }
  const operation = "operation" in request ? request.operation : undefined;
  const service = "service" in request ? request.service : undefined;
  const account = "account" in request ? request.account : undefined;
  const payload = "payload" in request ? request.payload : undefined;
  if (operation !== "read" && operation !== "write" && operation !== "remove") {
    throw new Error("invalid operation");
  }
  return {
    operation,
    service: requiredString(service, "service"),
    account: requiredString(account, "account"),
    payload,
  };
}

async function main() {
  const request = parseRequest(JSON.parse(await readStdin()));
  const Entry = loadKeyringEntryClass();
  const entry = new Entry(request.service, request.account);

  if (request.operation === "read") {
    const value = entry.getPassword();
    writeResponse(value === null ? { ok: true, found: false } : { ok: true, found: true, value });
    return;
  }
  if (request.operation === "write") {
    if (typeof request.payload !== "string") {
      throw new Error("invalid payload");
    }
    entry.setPassword(request.payload);
    writeResponse({ ok: true });
    return;
  }

  entry.deleteCredential();
  writeResponse({ ok: true });
}

main().catch(
  /** @param {unknown} error */ (error) => {
    writeResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  },
);
