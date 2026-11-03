// mcp-output-reader.ts - Paged reads over retained MCP output artifacts.
import { readFile, realpath } from "node:fs/promises";
import { readPlainResult } from "./plain-result-reader.ts";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { byteLength } from "./mcp-output-preview.ts";
import {
  DEFAULT_MCP_OUTPUT_MAX_BYTES,
  DEFAULT_MCP_OUTPUT_MAX_LINES,
  type McpOutputGuardOptions,
} from "./mcp-output-contracts.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";

export interface ReadMcpResultInput {
  ref: string;
  /** RFC 6901 JSON Pointer. Omit to read the entire retained result. */
  path?: string;
  fields?: string[];
  /** Zero-based character offset in the selected, pretty-printed value. */
  offset?: number;
  /** Maximum characters, additionally bounded by the configured output limits. */
  limit?: number;
}

type ReadMcpResultSuccess = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    ref: string;
    offset: number;
    nextOffset: number | null;
    totalCharacters: number;
    path?: string;
    error?: undefined;
    message?: undefined;
  };
};

type ReadMcpResultFailure = {
  content: ReadMcpResultSuccess["content"];
  details: {
    error: "result_read_failed";
    message: string;
    ref?: undefined;
    offset?: undefined;
    nextOffset?: undefined;
    totalCharacters?: undefined;
    path?: undefined;
  };
};

export async function readMcpResult(
  input: ReadMcpResultInput | null | undefined,
  options: McpOutputGuardOptions = {},
): Promise<ReadMcpResultSuccess | ReadMcpResultFailure> {
  try {
    if (input === null || input === undefined || typeof input.ref !== "string") {
      throw new Error("ref must be a retained MCP result path");
    }
    const ref = await resolveReadRef(input, options);
    // Plain output pages without flattening a complete UI history into memory.
    if (
      basename(ref).startsWith("output-") &&
      input.path === undefined &&
      input.fields === undefined
    ) {
      // Awaited so this try block converts paging failures into the error envelope.
      return await readPlainOutputPage(ref, input, options);
    }
    const rendered = await selectRenderedValue(ref, input);
    return pageRenderedResult(ref, rendered, input, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: "result_read_failed", message },
    };
  }
}

/** Page a plain output artifact directly through the paged reader. */
async function readPlainOutputPage(
  ref: string,
  input: ReadMcpResultInput,
  options: McpOutputGuardOptions,
): Promise<ReadMcpResultSuccess> {
  const window = plainReadBounds(input, options);
  const { offset } = window;
  const { page, total } = await readPlainResult(ref, window);
  const end = offset + page.length;
  const nextOffset = end < total ? end : null;
  return {
    content: [
      { type: "text" as const, text: page },
      ...(nextOffset !== null
        ? [
            {
              type: "text" as const,
              text: `[MCP result page: ${offset}–${end} of ${total} characters. Continue with offset: ${end}.]`,
            },
          ]
        : []),
    ],
    details: { ref, offset, nextOffset, totalCharacters: total },
  };
}

/** Validated offset/limit for a plain output page, tightened under the guard caps. */
function plainReadBounds(
  input: ReadMcpResultInput,
  options: McpOutputGuardOptions,
): { offset: number; limit: number; maxBytes: number; maxLines: number } {
  const { offset, limit } = validateReadWindow(input);
  const maxBytes = Math.max(1, (options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES) - 256);
  const maxLines = Math.max(1, (options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES) - 1);
  return { offset, limit, maxBytes, maxLines };
}

/** Validated offset/limit that also refuses splitting a surrogate pair. */
function renderedReadWindow(
  input: ReadMcpResultInput,
  rendered: string,
): { offset: number; limit: number } {
  const window = validateReadWindow(input);
  const leadingCodePoint = rendered.codePointAt(window.offset - 1);
  if (window.offset > 0 && leadingCodePoint !== undefined && leadingCodePoint > 0xffff) {
    throw new Error("offset must not split a Unicode surrogate pair");
  }
  return window;
}

function validateReadWindow(input: ReadMcpResultInput): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 12_000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("offset must be a non-negative integer and limit a positive integer");
  }
  return { offset, limit };
}

/** Slice one bounded page of the rendered result with continuation guidance. */
function pageRenderedResult(
  ref: string,
  rendered: string,
  input: ReadMcpResultInput,
  options: McpOutputGuardOptions,
): ReadMcpResultSuccess {
  const { offset, limit } = renderedReadWindow(input, rendered);
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const notice = (end: number) =>
    `[MCP result page: ${offset}–${end} of ${rendered.length} characters. Continue with offset: ${end}.]`;
  const window = { offset, limit };
  let end = renderedPageEnd(rendered, window, maxBytes, maxLines);
  if (end < rendered.length) {
    // The final offset cannot need more digits than the total length. Include the block separator.
    end = renderedPageEnd(
      rendered,
      window,
      maxBytes - byteLength(notice(rendered.length)) - 1,
      maxLines - 1,
    );
  }
  const nextOffset = end < rendered.length ? end : null;
  return {
    content: [
      { type: "text" as const, text: rendered.slice(offset, end) },
      ...(nextOffset !== null ? [{ type: "text" as const, text: notice(end) }] : []),
    ],
    details: {
      ref,
      offset,
      nextOffset,
      totalCharacters: rendered.length,
      ...(input.path !== undefined ? { path: input.path } : {}),
    },
  };
}

/** Character index that fits the byte/line/character caps from a starting offset. */
function renderedPageEnd(
  rendered: string,
  window: { offset: number; limit: number },
  byteCap: number,
  lineCap: number,
): number {
  const { offset, limit } = window;
  let end = offset;
  let bytes = 0;
  let lines = 1;
  while (end < rendered.length && end - offset < limit) {
    const codePoint = rendered.codePointAt(end);
    const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const char = rendered.slice(end, end + width);
    bytes += byteLength(char);
    if (char === "\n") {
      lines++;
    }
    // Tiny caps still return one complete character plus recovery guidance.
    if (end > offset && (bytes > byteCap || lines > lineCap || end + width - offset > limit)) {
      break;
    }
    end += width;
  }
  return end;
}

/** Read the artifact and apply any JSON Pointer/fields selection as pretty JSON. */
async function selectRenderedValue(ref: string, input: ReadMcpResultInput): Promise<string> {
  const rendered = await readFile(ref, "utf8");
  if (
    input.path === undefined &&
    input.fields === undefined &&
    !basename(ref).startsWith("mcp-result-")
  ) {
    return rendered;
  }
  let value: unknown = JSON.parse(rendered);
  if (input.path !== undefined && input.path !== "") {
    value = applyJsonPointer(value, input.path);
  }
  if (input.fields !== undefined) {
    value = applyFieldSelection(value, input.fields);
  }
  return JSON.stringify(value, null, 2);
}

/** Resolve an RFC 6901 JSON Pointer against a parsed value. */
function applyJsonPointer(value: unknown, path: string): unknown {
  if (typeof path !== "string" || !path.startsWith("/") || /~(?:[^01]|$)/.test(path)) {
    throw new Error("path must be an RFC 6901 JSON Pointer");
  }
  let current = value;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    const record = asObjectRecord(current);
    if (isUnknownArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(current, key)) {
        throw new Error(`JSON Pointer does not exist: ${path}`);
      }
      current = current[Number(key)];
    } else if (record !== undefined && Object.hasOwn(record, key)) {
      current = record[key];
    } else {
      throw new Error(`JSON Pointer does not exist: ${path}`);
    }
  }
  return current;
}

/** Project the selected keys off an object or array of objects. */
function applyFieldSelection(value: unknown, fields: string[]): unknown {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) {
    throw new Error("fields must be an array of keys");
  }
  const select = (item: unknown): Record<string, unknown> => {
    const record = asObjectRecord(item);
    if (record === undefined || isUnknownArray(item)) {
      throw new Error("fields requires an object or array of objects");
    }
    return Object.fromEntries(
      fields.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
    );
  };
  return isUnknownArray(value) ? value.map(select) : select(value);
}

/** Validate the ref as an MCP output artifact inside this host's output root. */
async function resolveReadRef(
  input: ReadMcpResultInput,
  options: McpOutputGuardOptions,
): Promise<string> {
  // Script-only hosts deliberately have no general filesystem capability.
  const [root, ref] = await Promise.all([
    realpath(options.outputDirectory === undefined ? tmpdir() : resolve(options.outputDirectory)),
    realpath(resolve(input.ref)),
  ]);
  if (
    dirname(dirname(ref)) !== root ||
    !basename(dirname(ref)).startsWith("pi-mcp-output-") ||
    !/^(mcp-result|output)-[a-f0-9]+\.txt$/.test(basename(ref))
  ) {
    throw new Error("ref is not an MCP output artifact in this host's output directory");
  }
  return ref;
}
