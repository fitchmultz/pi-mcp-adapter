import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const CHECKPOINT_BYTES = 1024 * 1024;
const MAX_CHECKPOINTS = 4096;
const MAX_INDEX_BYTES = 256 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type Checkpoint = [characters: number, bytes: number];
interface OutputIndex {
  version: 1;
  revision: string;
  totalCharacters: number;
  bytes: number;
  points: Checkpoint[];
}

export async function outputRevision(file: FileHandle): Promise<string> {
  const stat = await file.stat({ bigint: true });
  if (!stat.isFile()) throw new Error("ref must be a regular MCP output artifact");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function openPlainOutput(ref: string): Promise<FileHandle> {
  return open(ref, READ_FLAGS);
}

async function* outputBytes(file: FileHandle, position: number) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

export async function* plainOutputText(file: FileHandle, start: number) {
  const decoder = new StringDecoder("utf8");
  for await (const bytes of outputBytes(file, start)) yield decoder.write(bytes);
  const tail = decoder.end();
  if (tail) yield tail;
}

function validIndex(value: unknown, revision: string): value is OutputIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as OutputIndex;
  if (index.version !== 1 || index.revision !== revision || !Number.isSafeInteger(index.totalCharacters)
    || !Number.isSafeInteger(index.bytes) || index.totalCharacters < 0 || index.bytes < index.totalCharacters
    || String(index.bytes) !== revision.split(":")[2] || !Array.isArray(index.points)
    || index.points.length < 1 || index.points.length > MAX_CHECKPOINTS) return false;
  let characters = 0, bytes = 0;
  for (const [i, point] of index.points.entries()) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isSafeInteger(n))) return false;
    const [nextCharacters, nextBytes] = point;
    if (i === 0 ? nextCharacters !== 0 || nextBytes !== 0
      : nextCharacters <= characters || nextBytes <= bytes || nextBytes - bytes < nextCharacters - characters
        || nextBytes - bytes > 3 * (nextCharacters - characters)) return false;
    characters = nextCharacters; bytes = nextBytes;
  }
  return characters <= index.totalCharacters && bytes <= index.bytes
    && index.bytes - bytes >= index.totalCharacters - characters
    && index.bytes - bytes <= 3 * (index.totalCharacters - characters);
}

async function loadIndex(ref: string, revision: string): Promise<OutputIndex | undefined> {
  try {
    const path = `${ref}.index.json`;
    // Windows has no O_NOFOLLOW. Preserve canonical-path containment before opening optional metadata there.
    if (!constants.O_NOFOLLOW && await realpath(path) !== path) return;
    const file = await open(path, READ_FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return;
      // Bound allocation even if the derivative file grows between stat and read.
      const data = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      const index: unknown = JSON.parse(data.toString("utf8", 0, bytesRead));
      return validIndex(index, revision) ? index : undefined;
    } finally { await file.close(); }
  } catch { return undefined; } // Missing/corrupt derivative state never makes the text unreadable.
}

async function buildIndex(file: FileHandle, revision: string): Promise<OutputIndex | undefined> {
  const index: OutputIndex = { version: 1, revision, totalCharacters: 0, bytes: 0, points: [[0, 0]] };
  // Retain BOMs like Node's stream decoder. Invalid/truncated UTF-8 uses the ordinary nonfatal reader instead.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let stride = CHECKPOINT_BYTES;
  try {
    for await (const chunk of outputBytes(file, 0)) {
      const text = decoder.decode(chunk, { stream: true });
      index.totalCharacters += text.length;
      index.bytes += Buffer.byteLength(text);
      if (index.bytes - index.points[index.points.length - 1]![1] >= stride) {
        index.points.push([index.totalCharacters, index.bytes]);
        if (index.points.length === MAX_CHECKPOINTS) {
          index.points = index.points.filter((_, i) => i % 2 === 0);
          stride *= 2;
        }
      }
    }
    decoder.decode();
  } catch (error) {
    if (error instanceof TypeError && "code" in error && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return;
    throw error;
  }
  return await outputRevision(file) === revision && validIndex(index, revision) ? index : undefined;
}

async function storeIndex(ref: string, index: OutputIndex): Promise<void> {
  const temporary = `${ref}.index.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(index)); } finally { await file.close(); }
    // Replace, never follow, an existing derivative symlink. Readers see either complete version.
    await rename(temporary, `${ref}.index.json`);
  } catch { /* Optional optimization: read-only directories and failed index writes retain normal readback. */ }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function plainOutputIndex(file: FileHandle, ref: string, revision: string): Promise<OutputIndex | undefined> {
  const existing = await loadIndex(ref, revision);
  if (existing) return existing;
  const index = await buildIndex(file, revision);
  if (index) await storeIndex(ref, index);
  return index;
}

/** Writers pay one streaming pass over actual persisted bytes, not a copy of the rendered history. */
export async function preparePlainOutput(ref: string): Promise<void> {
  try {
    const file = await openPlainOutput(ref);
    try { await plainOutputIndex(file, ref, await outputRevision(file)); }
    finally { await file.close(); }
  } catch { /* The complete artifact, not its disposable index, determines delivery success. */ }
}
