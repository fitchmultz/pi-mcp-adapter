// mcp-output-reader.ts - Paged reads over retained MCP output artifacts.
import { readFile, realpath } from "node:fs/promises";
import { readPlainResult, type PlainReadWindow } from "./plain-result-reader.ts";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { byteLength } from "./mcp-output-preview.ts";
import {
  DEFAULT_MCP_OUTPUT_MAX_BYTES,
  DEFAULT_MCP_OUTPUT_MAX_LINES,
  type McpOutputGuardOptions,
} from "./mcp-output-contracts.ts";
import { asObjectRecord, isUnknownArray } from "./mcp-output-values.ts";
import { resolveArtifactPointer } from "./mcp-output-pointer.ts";
import type { McpReadPage } from "./mcp-script-output.ts";

export interface ReadMcpResultInput {
  ref: string;
  /** RFC 6901 JSON Pointer from the saved artifact root or embedded JSON text. Omit for the entire artifact. */
  path?: string;
  fields?: string[];
  /** Zero-based character offset in the selected value. */
  offset?: number;
  /** Maximum characters, additionally bounded by the configured output limits. */
  limit?: number;
  format?: "structured";
  /** Return the entire selected result in structuredContent (requires format: "structured", no offset/limit). */
  readAll?: boolean;
}

type ReadPageDetails = Omit<McpReadPage, "text">;
type PageContent = { type: "text"; text: string };

type ReadMcpResultSuccess = {
  content: PageContent[];
  structuredContent?: McpReadPage;
  details: ReadPageDetails & {
    error?: undefined;
    message?: undefined;
  };
};

type ReadMcpResultFailure = {
  content: PageContent[];
  isError: true;
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
  value: unknown,
  options: McpOutputGuardOptions = {},
): Promise<ReadMcpResultSuccess | ReadMcpResultFailure> {
  try {
    const input = asObjectRecord(value);
    if (input === undefined || typeof input.ref !== "string") {
      throw new Error("ref must be a retained MCP result path");
    }
    const readAll = validateReadAll(input);
    const ref = await resolveReadRef(input.ref, options);
    // Plain output pages without flattening a complete UI history into memory.
    if (isPlainOutputRequest(ref, input)) {
      // Awaited so this try block converts paging failures into the error envelope.
      return readAll
        ? await readPlainOutputAll(ref, options)
        : await readPlainOutputPage(ref, input, options);
    }
    const rendered = await selectRenderedValue(ref, input);
    return readAll
      ? readAllRenderedResult(ref, rendered, input, options)
      : pageRenderedResult(ref, rendered, input, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: "result_read_failed", message },
      isError: true,
    };
  }
}

function isPlainOutputRequest(ref: string, input: Record<string, unknown>): boolean {
  return (
    basename(ref).startsWith("output-") && input.path === undefined && input.fields === undefined
  );
}

/** Validate readAll and its incompatible paging/format combinations. */
function validateReadAll(input: Record<string, unknown>): boolean {
  if (input.readAll === undefined || input.readAll === false) {
    return false;
  }
  if (input.readAll !== true) {
    throw new Error("readAll must be a boolean");
  }
  if (input.format !== "structured") {
    throw new Error('readAll requires format: "structured"');
  }
  if (input.offset !== undefined || input.limit !== undefined) {
    throw new Error("readAll cannot be combined with offset or limit");
  }
  return true;
}

function readAllPreviewNotice(previewChars: number, totalChars: number): string {
  return `[MCP result readAll: full ${totalChars} characters returned in structuredContent; preview truncated at ${previewChars} of ${totalChars} characters.]`;
}

function boundedReadAllContent(rendered: string, options: McpOutputGuardOptions): PageContent[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const window = { offset: 0, limit: rendered.length };
  let end = renderedPageEnd(rendered, window, maxBytes, maxLines);
  if (end >= rendered.length) {
    return [{ type: "text", text: rendered }];
  }
  const longestNotice = readAllPreviewNotice(rendered.length, rendered.length);
  end = renderedPageEnd(rendered, window, maxBytes - byteLength(longestNotice) - 1, maxLines - 1);
  return [
    { type: "text", text: rendered.slice(0, end) },
    { type: "text", text: readAllPreviewNotice(end, rendered.length) },
  ];
}

/** Return the entire selected result in structuredContent while bounding model-facing content. */
function readAllRenderedResult(
  ref: string,
  rendered: string,
  input: Record<string, unknown>,
  options: McpOutputGuardOptions,
): ReadMcpResultSuccess {
  const details: ReadPageDetails = {
    ref,
    offset: 0,
    nextOffset: null,
    totalCharacters: rendered.length,
    ...(typeof input.path === "string" && input.path !== "" ? { path: input.path } : {}),
  };
  return {
    content: boundedReadAllContent(rendered, options),
    details,
    structuredContent: { ...details, text: rendered },
  };
}

/** Read a plain output artifact in full for a structured readAll response. */
async function readPlainOutputAll(
  ref: string,
  options: McpOutputGuardOptions,
): Promise<ReadMcpResultSuccess> {
  const rendered = await readFile(ref, "utf8");
  return readAllRenderedResult(ref, rendered, {}, options);
}

/** Page a plain output artifact directly through the paged reader. */
async function readPlainOutputPage(
  ref: string,
  input: Record<string, unknown>,
  options: McpOutputGuardOptions,
): Promise<ReadMcpResultSuccess> {
  const window = plainReadBounds(input, options);
  const { offset } = window;
  const { page, total } = await readPlainResult(ref, window);
  const end = offset + page.length;
  const nextOffset = end < total ? end : null;
  return readPageResult(page, { ref, offset, nextOffset, totalCharacters: total }, input.format);
}

/** Validated offset/limit for a plain output page, tightened under the guard caps. */
function plainReadBounds(
  input: Record<string, unknown>,
  options: McpOutputGuardOptions,
): PlainReadWindow {
  const { offset, limit } = validateReadWindow(input);
  const maxBytes = Math.max(1, (options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES) - 256);
  const maxLines = Math.max(1, (options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES) - 1);
  return { offset, limit, maxBytes, maxLines };
}

/** Validated offset/limit that also refuses splitting a surrogate pair. */
function renderedReadWindow(
  input: Record<string, unknown>,
  rendered: string,
): { offset: number; limit: number } {
  const window = validateReadWindow(input);
  const leadingCodePoint = rendered.codePointAt(window.offset - 1);
  if (window.offset > 0 && leadingCodePoint !== undefined && leadingCodePoint > 0xffff) {
    throw new Error("offset must not split a Unicode surrogate pair");
  }
  return window;
}

function validateReadWindow(input: Record<string, unknown>): { offset: number; limit: number } {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 12_000;
  if (
    typeof offset !== "number" ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error("offset must be a non-negative integer and limit a positive integer");
  }
  return { offset, limit };
}

/** Slice one bounded page of the rendered result with continuation guidance. */
function pageRenderedResult(
  ref: string,
  rendered: string,
  input: Record<string, unknown>,
  options: McpOutputGuardOptions,
): ReadMcpResultSuccess {
  const { offset, limit } = renderedReadWindow(input, rendered);
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const window = { offset, limit };
  let end = renderedPageEnd(rendered, window, maxBytes, maxLines);
  if (end < rendered.length) {
    // The final offset cannot need more digits than the total length. Include the block separator.
    const longestNotice = pageNotice(offset, rendered.length, rendered.length);
    end = renderedPageEnd(rendered, window, maxBytes - byteLength(longestNotice) - 1, maxLines - 1);
  }
  return readPageResult(
    rendered.slice(offset, end),
    {
      ref,
      offset,
      nextOffset: end < rendered.length ? end : null,
      totalCharacters: rendered.length,
      ...(typeof input.path === "string" ? { path: input.path } : {}),
    },
    input.format,
  );
}

function pageNotice(offset: number, nextOffset: number, total: number): string {
  return `[MCP result page: ${offset}–${nextOffset} of ${total} characters. Continue with offset: ${nextOffset}.]`;
}

function readPageResult(
  text: string,
  details: ReadPageDetails,
  format: unknown,
): ReadMcpResultSuccess {
  const { offset, nextOffset, totalCharacters } = details;
  return {
    content: [
      { type: "text", text },
      ...(nextOffset === null
        ? []
        : [{ type: "text" as const, text: pageNotice(offset, nextOffset, totalCharacters) }]),
    ],
    details,
    ...(format === "structured" ? { structuredContent: { ...details, text } } : {}),
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

/** Read the artifact and apply any JSON Pointer/fields selection. */
async function selectRenderedValue(ref: string, input: Record<string, unknown>): Promise<string> {
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
    value = resolveArtifactPointer(value, input.path);
  }
  if (input.fields !== undefined) {
    value = applyFieldSelection(value, input.fields);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Project the selected keys off an object or array of objects. */
function applyFieldSelection(value: unknown, fields: unknown): unknown {
  if (!isUnknownArray(fields) || !fields.every((field) => typeof field === "string")) {
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
async function resolveReadRef(inputRef: string, options: McpOutputGuardOptions): Promise<string> {
  // Gateway-only hosts deliberately have no general filesystem capability.
  const [root, ref] = await Promise.all([
    realpath(options.outputDirectory === undefined ? tmpdir() : resolve(options.outputDirectory)),
    realpath(resolve(inputRef)),
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
