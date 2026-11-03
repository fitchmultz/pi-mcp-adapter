import { formatWithOptions } from "node:util";

/** @param {unknown} value @returns {boolean} */
function isInspectableScalar(value) {
  return value === undefined || ["bigint", "function", "symbol"].includes(typeof value);
}

/** @param {object} value @returns {boolean} */
function isInspectableCollection(value) {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  );
}

/** @param {unknown} value @param {WeakSet<object>} [stack] @returns {boolean} */
function needsInspectableFormatting(value, stack = new WeakSet()) {
  if (isInspectableScalar(value)) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (stack.has(value) || isInspectableCollection(value)) {
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
export function formatScriptValue(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    if (!needsInspectableFormatting(value)) {
      const json = JSON.stringify(value, null, 2);
      if (typeof json === "string") {
        return json;
      }
    }
    return formatWithOptions({ colors: false, depth: 6 }, value);
  } catch {
    return "[unserializable value]";
  }
}

/** @param {object} value @returns {import("./types.ts").ContentBlock | undefined} */
function imageBlock(value) {
  if (
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  ) {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  return;
}

/** @param {unknown} value @returns {import("./types.ts").ContentBlock} */
export function toScriptContentBlock(value) {
  if (typeof value === "object" && value !== null && "type" in value) {
    if (value.type === "text" && "text" in value && typeof value.text === "string") {
      return { type: "text", text: value.text };
    }
    if (value.type === "image") {
      return imageBlock(value) ?? { type: "text", text: formatScriptValue(value) };
    }
  }
  return { type: "text", text: formatScriptValue(value) };
}
