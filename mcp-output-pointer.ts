// mcp-output-pointer.ts - RFC 6901 JSON Pointer resolution with JSON-in-text traversal and hints.
import { classifyResourceBlob } from "./mcp-output-media.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

const MAX_HINT_KEYS = 20;
const MAX_PAYLOAD_HINTS = 3;

interface PointerMiss {
  found: false;
  parentTokens: string[];
  parentValue: unknown;
}

type PointerWalk = { found: true; value: unknown } | PointerMiss;

interface EmbeddedJsonPayload {
  sourcePath: string;
  parsed: unknown;
}

interface PayloadMiss {
  sourcePath: string;
  walk: PointerMiss;
}

/** Resolve an RFC 6901 JSON Pointer on the MCP envelope or transparently inside JSON text blocks. */
export function resolveArtifactPointer(root: unknown, path: unknown): unknown {
  const tokens = parseJsonPointer(path);
  const outer = walkJsonPointer(root, tokens, true);
  if (outer.found) {
    return outer.value;
  }

  const nested = resolveNestedJsonString(outer, tokens);
  if (nested?.found === true) {
    return nested.value;
  }

  const payloads = extractEmbeddedJsonPayloads(root);
  const embedded =
    outer.parentTokens.length === 0
      ? resolveEmbeddedPayloads(payloads, tokens)
      : { found: false as const, bestMiss: undefined };
  if (embedded.found) {
    return embedded.value;
  }

  throw new Error(
    formatPointerMissError(String(path), {
      outer,
      nested: nested ?? undefined,
      payloads,
      bestPayloadMiss: embedded.bestMiss,
    }),
  );
}

function parseJsonPointer(path: unknown): string[] {
  if (typeof path !== "string" || !path.startsWith("/") || /~(?:[^01]|$)/.test(path)) {
    throw new Error("path must be an RFC 6901 JSON Pointer");
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function encodePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function formatPointerPath(tokens: string[]): string {
  return tokens.length === 0 ? "/" : `/${tokens.map(encodePointerToken).join("/")}`;
}

function stepJsonPointer(
  current: unknown,
  key: string,
): { found: true; value: unknown } | { found: false } {
  if (isUnknownArray(current)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(current, key)) {
      return { found: false };
    }
    return { found: true, value: current[Number(key)] };
  }
  const record = asObjectRecord(current);
  if (record !== undefined && Object.hasOwn(record, key)) {
    return { found: true, value: record[key] };
  }
  return { found: false };
}

function isMcpResourcePath(parentTokens: readonly string[]): boolean {
  return (
    (parentTokens.length === 2 && parentTokens[0] === "contents") ||
    (parentTokens.length === 3 && parentTokens[0] === "content" && parentTokens[2] === "resource")
  );
}

function stepMcpResourceTextBlob(
  current: unknown,
  key: string,
  parentTokens: readonly string[],
): { found: true; value: string } | undefined {
  if ((key !== "blob" && key !== "text") || !isMcpResourcePath(parentTokens)) {
    return undefined;
  }
  const record = asObjectRecord(current);
  if (key === "text" && typeof record?.text === "string") {
    return undefined;
  }
  const classified = classifyResourceBlob(record);
  return classified?.kind === "text" ? { found: true, value: classified.text } : undefined;
}

function walkJsonPointer(
  root: unknown,
  tokens: string[],
  decodeResourceBlobs = false,
): PointerWalk {
  let current = root;
  for (let index = 0; index < tokens.length; index++) {
    const key = tokens[index];
    if (key === undefined) {
      break;
    }
    const step =
      (decodeResourceBlobs
        ? stepMcpResourceTextBlob(current, key, tokens.slice(0, index))
        : undefined) ?? stepJsonPointer(current, key);
    if (!step.found) {
      return { found: false, parentTokens: tokens.slice(0, index), parentValue: current };
    }
    current = step.value;
  }
  return { found: true, value: current };
}

function parseJsonContainer(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveNestedJsonString(outer: PointerMiss, tokens: string[]): PointerWalk | undefined {
  if (typeof outer.parentValue !== "string") {
    return undefined;
  }
  const parsed = parseJsonContainer(outer.parentValue);
  if (parsed === undefined) {
    return undefined;
  }
  const remaining = tokens.slice(outer.parentTokens.length);
  const walk = walkJsonPointer(parsed, remaining);
  if (walk.found) {
    return walk;
  }
  return {
    found: false,
    parentTokens: [...outer.parentTokens, ...walk.parentTokens],
    parentValue: walk.parentValue,
  };
}

function extractResourceText(
  resource: Record<string, unknown> | undefined,
  basePath: string,
): { sourcePath: string; text: string } | undefined {
  if (typeof resource?.text === "string") {
    return { sourcePath: `${basePath}/text`, text: resource.text };
  }
  const classified = classifyResourceBlob(resource);
  if (classified?.kind === "text") {
    return { sourcePath: `${basePath}/blob`, text: classified.text };
  }
  return undefined;
}

function contentBlockCandidate(
  entry: unknown,
  index: number,
): { sourcePath: string; text: string } | undefined {
  const block = asObjectRecord(entry);
  if (block?.type === "text" && typeof block.text === "string") {
    return { sourcePath: `/content/${index}/text`, text: block.text };
  }
  if (block?.type === "resource") {
    return extractResourceText(asObjectRecord(block.resource), `/content/${index}/resource`);
  }
  return undefined;
}

function collectTextCandidates(root: unknown): Array<{ sourcePath: string; text: string }> {
  const record = asObjectRecord(root);
  const candidates: Array<{ sourcePath: string; text: string }> = [];
  if (isUnknownArray(record?.content)) {
    for (let index = 0; index < record.content.length; index++) {
      const candidate = contentBlockCandidate(record.content[index], index);
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
  }
  if (isUnknownArray(record?.contents)) {
    for (let index = 0; index < record.contents.length; index++) {
      const candidate = extractResourceText(
        asObjectRecord(record.contents[index]),
        `/contents/${index}`,
      );
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function extractEmbeddedJsonPayloads(root: unknown): EmbeddedJsonPayload[] {
  const payloads: EmbeddedJsonPayload[] = [];
  for (const candidate of collectTextCandidates(root)) {
    const parsed = parseJsonContainer(candidate.text);
    if (parsed !== undefined) {
      payloads.push({ sourcePath: candidate.sourcePath, parsed });
    }
  }
  return payloads;
}

function resolveEmbeddedPayloads(
  payloads: EmbeddedJsonPayload[],
  tokens: string[],
): { found: true; value: unknown } | { found: false; bestMiss: PayloadMiss | undefined } {
  let bestMiss: PayloadMiss | undefined;
  for (const payload of payloads) {
    const walk = walkJsonPointer(payload.parsed, tokens);
    if (walk.found) {
      return walk;
    }
    if (bestMiss === undefined || walk.parentTokens.length > bestMiss.walk.parentTokens.length) {
      bestMiss = { sourcePath: payload.sourcePath, walk };
    }
  }
  return { found: false, bestMiss };
}

function describeValue(value: unknown): string {
  if (isUnknownArray(value)) {
    return value.length === 0
      ? "empty array (length 0)"
      : `array of length ${value.length}, indices 0..${value.length - 1}`;
  }
  const record = asObjectRecord(value);
  if (record !== undefined) {
    const keys = Object.keys(record);
    if (keys.length === 0) {
      return "empty object (no keys)";
    }
    const preview = keys
      .slice(0, MAX_HINT_KEYS)
      .map((key) => JSON.stringify(key))
      .join(", ");
    const overflow =
      keys.length > MAX_HINT_KEYS ? `, ... (+${keys.length - MAX_HINT_KEYS} more)` : "";
    return `object with keys: ${preview}${overflow}`;
  }
  return value === null ? "null" : typeof value;
}

function formatNearestParentHint(context: {
  outer: PointerMiss;
  nested: PointerMiss | undefined;
  bestPayloadMiss: PayloadMiss | undefined;
}): string {
  const { outer, nested, bestPayloadMiss } = context;
  if (nested !== undefined) {
    return `Nearest valid parent: ${formatPointerPath(nested.parentTokens)} (${describeValue(nested.parentValue)}).`;
  }
  if (
    bestPayloadMiss !== undefined &&
    bestPayloadMiss.walk.parentTokens.length > outer.parentTokens.length
  ) {
    const parentPath = formatPointerPath(bestPayloadMiss.walk.parentTokens);
    return `Nearest valid parent: ${parentPath} in ${bestPayloadMiss.sourcePath} JSON (${describeValue(bestPayloadMiss.walk.parentValue)}).`;
  }
  return `Nearest valid parent: ${formatPointerPath(outer.parentTokens)} (${describeValue(outer.parentValue)}).`;
}

function formatPointerMissError(
  path: string,
  context: {
    outer: PointerMiss;
    nested: PointerMiss | undefined;
    payloads: EmbeddedJsonPayload[];
    bestPayloadMiss: PayloadMiss | undefined;
  },
): string {
  const parts = [
    `JSON Pointer does not exist in the saved artifact: ${path}.`,
    formatNearestParentHint(context),
  ];
  for (const payload of context.payloads.slice(0, MAX_PAYLOAD_HINTS)) {
    parts.push(`Parsed JSON at ${payload.sourcePath} has ${describeValue(payload.parsed)}.`);
  }
  return parts.join(" ");
}
