import { parentPort, workerData } from "node:worker_threads";
import { formatWithOptions } from "node:util";
import vm from "node:vm";

const TOOLS_ENUMERATION_ERROR = "tools is not enumerable — use tools.search({ query })";
const RESERVED_TOOL_PROPS = new Set(["then", "catch", "finally", "toJSON", "toString", "valueOf"]);
const { code, outputFlow, outputWindow } =
  /** @type {{ code: string; outputFlow: Int32Array | undefined; outputWindow: number }} */ (
    workerData
  );

/** @param {import("node:worker_threads").MessagePort | null} port */
function requireParentPort(port) {
  if (port === null) {
    throw new Error("mcp-script-worker must be started from a worker thread with a parent port");
  }
  return port;
}

const port = requireParentPort(parentPort);

// Keep this formatting logic in sync with mcp-code.ts; the standalone worker cannot import the TypeScript host module.
/**
 * @param {unknown} value
 * @param {WeakSet<object>} [stack]
 * @returns {boolean}
 */
function needsInspectableFormatting(value, stack = new WeakSet()) {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (stack.has(value)) {
    return true;
  }
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    return true;
  }
  stack.add(value);
  try {
    return Object.values(value).some((entry) => needsInspectableFormatting(entry, stack));
  } finally {
    stack.delete(value);
  }
}

/** @param {unknown} value @returns {string} */
function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    if (!needsInspectableFormatting(value)) {
      const json = JSON.stringify(value, null, 2);
      if (json !== undefined) {
        return json;
      }
    }
    return formatWithOptions({ colors: false, depth: 6 }, value);
  } catch {
    return "[unserializable value]";
  }
}

/**
 * @param {unknown} value
 * @returns {{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }}
 */
function toContentBlock(value) {
  if (typeof value === "object" && value !== null) {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text };
    }
    if (
      record.type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      return { type: "image", data: record.data, mimeType: record.mimeType };
    }
  }
  return { type: "text", text: formatValue(value) };
}

let nextRequestId = 0;
const pending = new Map();

port.on("message", (message) => {
  if (
    typeof message !== "object" ||
    message === null ||
    message.type !== "result" ||
    typeof message.id !== "number"
  ) {
    return;
  }
  const resolve = pending.get(message.id);
  if (!resolve) {
    return;
  }
  pending.delete(message.id);
  resolve(message.envelope);
});

/** @param {string} type @param {{ input?: unknown; path?: string; args?: unknown; server?: string | undefined }} payload */
function request(type, payload) {
  return new Promise((resolve) => {
    const id = ++nextRequestId;
    pending.set(id, resolve);
    port.postMessage({ type, id, ...payload });
  });
}

const tools = new Proxy(Object.create(null), {
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
        if (server !== undefined && (typeof server !== "string" || !server)) {
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
      return undefined;
    }
    return (/** @type {unknown} */ args) => request("call", { path: property, args });
  },
  ownKeys() {
    throw new Error(TOOLS_ENUMERATION_ERROR);
  },
});

/** @param {unknown} value */
const emit = (value) => {
  const block = toContentBlock(value);
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
    Object.assign(Object.create(null), {
      tools,
      emit,
      console: capturedConsole,
    }),
    {
      codeGeneration: { strings: false, wasm: false },
      name: "mcp_script",
    },
  );
  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "mcp_script.js" });
  const returnValue = await Promise.resolve(script.runInContext(context));
  port.postMessage(
    returnValue === undefined
      ? { type: "done" }
      : { type: "done", returnBlock: toContentBlock(returnValue) },
  );
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
