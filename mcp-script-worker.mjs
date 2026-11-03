import { parentPort, workerData } from "node:worker_threads";
import { formatWithOptions } from "node:util";
import vm from "node:vm";
import { toScriptContentBlock } from "./mcp-script-values.mjs";

const TOOLS_ENUMERATION_ERROR = "tools is not enumerable — use tools.search({ query })";
const RESERVED_TOOL_PROPS = new Set(["then", "catch", "finally", "toJSON", "toString", "valueOf"]);
const data = parseWorkerData(workerData);
const { code, outputFlow, outputWindow } = data;

/** @param {unknown} value */
function parseWorkerData(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "string"
  ) {
    throw new Error("mcp-script-worker requires script code");
  }
  return {
    code: value.code,
    outputFlow:
      "outputFlow" in value && value.outputFlow instanceof Int32Array
        ? value.outputFlow
        : undefined,
    outputWindow:
      "outputWindow" in value && typeof value.outputWindow === "number" ? value.outputWindow : 0,
  };
}

/** @param {import("node:worker_threads").MessagePort | null} value */
function requireParentPort(value) {
  if (value === null) {
    throw new Error("mcp-script-worker must be started from a worker thread with a parent port");
  }
  return value;
}

const port = requireParentPort(parentPort);

let nextRequestId = 0;
/** @type {Map<number, (value: unknown) => void>} */
const pending = new Map();

port.on("message", (/** @type {unknown} */ message) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "result" ||
    !("id" in message) ||
    typeof message.id !== "number"
  ) {
    return;
  }
  const resolve = pending.get(message.id);
  if (!resolve) {
    return;
  }
  pending.delete(message.id);
  resolve("envelope" in message ? message.envelope : undefined);
});

/** @param {string} type @param {{ input?: unknown; path?: string; args?: unknown; server?: string | undefined }} payload @returns {Promise<unknown>} */
function request(type, payload) {
  return new Promise((resolve) => {
    const id = ++nextRequestId;
    pending.set(id, resolve);
    port.postMessage({ type, id, ...payload });
  });
}

const tools = new Proxy(
  { __proto__: null },
  {
    get(_target, property) {
      if (property === "search") {
        return async (/** @type {unknown} */ input) => request("search", { input });
      }
      if (property === "call") {
        return async (
          /** @type {string} */ path,
          /** @type {unknown} */ args,
          /** @type {string | undefined} */ server,
        ) => {
          // Invalid paths never reach dispatch and therefore never appear in the call trace.
          if (typeof path !== "string" || path.trim() === "") {
            return {
              ok: false,
              error: {
                code: "invalid_tool_path",
                message: "tools.call(path, args) requires a non-empty tool path.",
              },
            };
          }
          if (server !== undefined && (typeof server !== "string" || server === "")) {
            return {
              ok: false,
              error: { code: "invalid_arguments", message: "server must be a non-empty string" },
            };
          }
          return request("call", { path, args, server });
        };
      }
      if (property === "resources" || property === "listResources") {
        return async (/** @type {unknown} */ input) => request("resources", { input });
      }
      if (property === "readResource" || property === "readResult") {
        return async (/** @type {unknown} */ input) => request(property, { input });
      }
      if (property === "describe") {
        return async (/** @type {unknown} */ input) => request("describe", { input });
      }
      if (typeof property !== "string" || RESERVED_TOOL_PROPS.has(property)) {
        return;
      }
      return (/** @type {unknown} */ args) => request("call", { path: property, args });
    },
    ownKeys() {
      throw new Error(TOOLS_ENUMERATION_ERROR);
    },
  },
);

/** @param {unknown} value */
const emit = (value) => {
  const block = toScriptContentBlock(value);
  // A running Pi keeps the adapter it loaded but starts this file from disk, so an older host passes no window.
  if (!outputFlow) {
    port.postMessage({ type: "emit", block });
    return;
  }
  // Charge each queued message too, so many tiny emits cannot outrun the host.
  const size = (block.type === "text" ? block.text.length : block.data.length) + 256;
  Atomics.add(outputFlow, 0, size);
  port.postMessage({ type: "emit", block, size });
  // Block this worker, not the host, until the host consumes queued output.
  for (let queued; (queued = Atomics.load(outputFlow, 0)) > outputWindow;) {
    Atomics.wait(outputFlow, 0, queued);
  }
};

/**
 * @param {string} level
 * @returns {(args: unknown[]) => void}
 */
function consoleEmitter(level) {
  return (...args) =>
    emit(`[console.${level}] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`);
}

const capturedConsole = Object.freeze({
  log: consoleEmitter("log"),
  info: consoleEmitter("info"),
  warn: consoleEmitter("warn"),
  error: consoleEmitter("error"),
  debug: consoleEmitter("debug"),
});

try {
  const context = vm.createContext(
    { __proto__: null, tools, emit, console: capturedConsole },
    {
      codeGeneration: { strings: false, wasm: false },
      name: "mcp_script",
    },
  );
  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "mcp_script.js" });
  /** @type {unknown} */
  const execution = script.runInContext(context);
  /** @type {unknown} */
  const returnValue = await Promise.resolve(execution);
  port.postMessage(
    returnValue === undefined
      ? { type: "done" }
      : { type: "done", returnBlock: toScriptContentBlock(returnValue) },
  );
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
