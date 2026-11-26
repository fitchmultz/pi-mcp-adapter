// mcp-output-media.ts - Media/blob classification, UTF-8 decoding, and safe file extensions.
import { asObjectRecord } from "./mcp-output-values.ts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_CHARSETS = new Set(["utf-8", "utf8", "us-ascii", "ascii"]);
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:", "ftp:"]);
const SAFE_EXTENSION = /^[a-z0-9]{1,10}$/;
// Raster image MIME types accepted as native ImageContent by LLM vision providers.
const VISION_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_APPLICATION_MIME_TYPES = new Set([
  "image/svg+xml",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/x-ndjson",
]);

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "application/rtf": "rtf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.sqlite3": "sqlite",
  "application/x-sqlite3": "sqlite",
  "application/vnd.apache.parquet": "parquet",
  "application/protobuf": "pb",
  "application/x-protobuf": "pb",
  "application/cbor": "cbor",
  "application/msgpack": "msgpack",
  "application/wasm": "wasm",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-gzip": "gz",
  "application/x-tar": "tar",
  "application/x-bzip2": "bz2",
  "application/x-xz": "xz",
  "application/zstd": "zst",
  "application/x-7z-compressed": "7z",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/webm": "weba",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
  "video/mpeg": "mpeg",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/xml": "xml",
  "application/json": "json",
  "application/xml": "xml",
  "application/javascript": "js",
  "application/ecmascript": "js",
  "application/typescript": "ts",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/toml": "toml",
  "application/sql": "sql",
  "application/graphql": "graphql",
  "application/x-ndjson": "ndjson",
};

export type ResourceBlobClassification =
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Buffer; extension: string };

/** Lowercased base MIME type without parameters, bounded for header/provider safety. */
export function normalizeMimeType(mimeType: unknown): string | undefined {
  if (typeof mimeType !== "string") {
    return undefined;
  }
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return base === "" ? undefined : base.slice(0, 100);
}

export function isImageMimeType(mimeType: unknown): boolean {
  const base = normalizeMimeType(mimeType);
  return base !== undefined && VISION_IMAGE_MIME_TYPES.has(base);
}

function hasCompatibleUtf8Charset(mimeType: string): boolean {
  const parameters = mimeType.split(";").slice(1);
  for (const parameter of parameters) {
    const eq = parameter.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = parameter.slice(0, eq).trim().toLowerCase();
    if (name !== "charset") {
      continue;
    }
    const rawValue = parameter.slice(eq + 1).trim();
    const unquoted = rawValue.replace(/^["']|["']$/g, "").toLowerCase();
    return UTF8_CHARSETS.has(unquoted);
  }
  return true;
}

function isTextApplicationMimeType(base: string): boolean {
  if (TEXT_APPLICATION_MIME_TYPES.has(base)) {
    return true;
  }
  if (!base.startsWith("application/")) {
    return false;
  }
  const subtype = base.slice("application/".length);
  return (
    (subtype.endsWith("+json") && subtype.length > 5) ||
    (subtype.endsWith("+xml") && subtype.length > 4)
  );
}

export function isUtf8TextMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== "string" || !hasCompatibleUtf8Charset(mimeType)) {
    return false;
  }
  const base = normalizeMimeType(mimeType);
  if (base === undefined) {
    return false;
  }
  return (base.startsWith("text/") && base.length > 5) || isTextApplicationMimeType(base);
}

export function decodeUtf8Base64(base64: string): string | undefined {
  try {
    return UTF8_DECODER.decode(Buffer.from(base64, "base64"));
  } catch {
    return undefined;
  }
}

export function sanitizeExtension(candidate: string | undefined): string | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  const lower = candidate.toLowerCase();
  return SAFE_EXTENSION.test(lower) ? lower : undefined;
}

function extensionFromSegment(segment: string): string | undefined {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0 || dot === segment.length - 1) {
    return undefined;
  }
  return sanitizeExtension(segment.slice(dot + 1));
}

function extensionFromPath(pathname: string): string | undefined {
  const trimmed = pathname.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const segment = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  return extensionFromSegment(segment);
}

function extensionFromUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || uri.trim() === "") {
    return undefined;
  }
  try {
    const parsed = new URL(uri);
    const fromPath = extensionFromPath(parsed.pathname);
    if (fromPath !== undefined) {
      return fromPath;
    }
    if (
      !NETWORK_PROTOCOLS.has(parsed.protocol) &&
      (parsed.pathname === "" || parsed.pathname === "/")
    ) {
      return extensionFromSegment(parsed.hostname);
    }
    return undefined;
  } catch {
    const stripped = uri.split(/[?#]/, 1)[0] ?? "";
    return extensionFromPath(stripped);
  }
}

/** Derive a safe file extension from MIME type and/or resource URI, falling back to "bin". */
export function deriveBinaryExtension(mimeType: unknown, uri?: unknown): string {
  const base = normalizeMimeType(mimeType);
  const fromMime = base !== undefined ? MIME_EXTENSIONS[base] : undefined;
  return fromMime ?? extensionFromUri(uri) ?? "bin";
}

/** Classify a resource block's base64 blob into native image, decoded UTF-8 text, or binary file. */
export function classifyResourceBlob(value: unknown): ResourceBlobClassification | undefined {
  const resource = asObjectRecord(value);
  const blob = resource?.blob;
  if (typeof blob !== "string") {
    return undefined;
  }
  const mimeType = resource?.mimeType;
  if (isImageMimeType(mimeType)) {
    return {
      kind: "image",
      data: blob,
      mimeType: normalizeMimeType(mimeType) ?? "image/png",
    };
  }
  if (isUtf8TextMimeType(mimeType)) {
    const text = decodeUtf8Base64(blob);
    if (text !== undefined) {
      return { kind: "text", text };
    }
  }
  return {
    kind: "binary",
    bytes: Buffer.from(blob, "base64"),
    extension: deriveBinaryExtension(mimeType, resource?.uri),
  };
}
