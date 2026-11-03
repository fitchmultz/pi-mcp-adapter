import { appendFileSync, fstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { open, type FileHandle } from "node:fs/promises";
import { byteLength } from "./mcp-output-preview.ts";

type Point = { bytes: number; characters: number };
/** Validated UTF-16 offset/limit and the guard's byte/line caps for one plain-output page. */
export type PlainReadWindow = { offset: number; limit: number; maxBytes: number; maxLines: number };
type ReadPage = { page: string; total: number };
const indexes = new Map<string, SparseIndex>();
const readers = new Map<string, Set<AppendProgress>>();
const MAX_INDEXES = 8;
const MAX_POINTS = 1024;

function sameRevision(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Raw full-content SHA-256. Returns "" on a short read so a truncated verify never matches. */
async function digestOf(file: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) {
      return "";
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/** Owns sparse checkpoints and incremental hashes, never retained file contents. */
class SparseIndex {
  revision: BigIntStats;
  total = 0;
  points: [Point, ...Point[]];
  stride: number;
  digest = "";
  hasher: Hash;

  constructor(
    revision: BigIntStats,
    origin: Point = { bytes: 0, characters: 0 },
    stride = 64 * 1024,
    hasher = createHash("sha256"),
  ) {
    this.revision = revision;
    this.points = [origin];
    this.stride = stride;
    this.hasher = hasher;
  }

  checkpoint(point: Point): void {
    const last = this.points.at(-1) ?? this.points[0];
    if (point.bytes - last.bytes < this.stride) {
      return;
    }
    this.points.push(point);
    if (this.points.length > MAX_POINTS) {
      // Keep the origin and every second later checkpoint: the previous even indices.
      const [origin, ...rest] = this.points;
      this.points = [origin, ...rest.filter((_, i) => i % 2 === 1)];
      this.stride *= 2;
    }
  }

  pointAt(offset: number): Point {
    let point = this.points[0];
    for (const candidate of this.points) {
      if (candidate.characters > offset) {
        break;
      }
      point = candidate;
    }
    return point;
  }

  copy(): SparseIndex {
    const next = new SparseIndex(this.revision, this.points[0], this.stride, this.hasher);
    next.total = this.total;
    next.points = [...this.points];
    next.digest = this.digest;
    return next;
  }

  extend(after: BigIntStats, text: string): void {
    // Clone before updating so a shared cached hasher never advances.
    this.hasher = this.hasher.copy();
    this.hasher.update(text, "utf8");
    let position = Number(this.revision.size);
    this.checkpoint({ bytes: position, characters: this.total });
    // Index only the accepted delta, keeping checkpoints on complete UTF-8 code points.
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 16 * 1024);
      const codePoint = text.codePointAt(end - 1);
      if (end < text.length && codePoint !== undefined && codePoint > 0xffff) {
        end++;
      }
      position += byteLength(text.slice(start, end));
      this.checkpoint({ bytes: position, characters: this.total + end });
      start = end;
    }
    this.total += text.length;
    this.revision = after;
    this.digest = this.hasher.copy().digest("hex");
  }

  withAppends(progress: SparseIndex): SparseIndex {
    const next = this.copy();
    next.revision = progress.revision;
    next.total = this.total + progress.total;
    next.hasher = progress.hasher;
    next.digest = progress.hasher.copy().digest("hex");
    for (const point of progress.points) {
      next.checkpoint({ bytes: point.bytes, characters: this.total + point.characters });
    }
    return next;
  }
}

/** Native appends certified while one snapshot is open. Replacement characters prevent caching. */
class AppendProgress extends SparseIndex {
  cacheable = true;
}

function remember(ref: string, index: SparseIndex): void {
  indexes.delete(ref);
  indexes.set(ref, index);
  if (indexes.size > MAX_INDEXES) {
    const oldest = indexes.keys().next();
    if (oldest.done !== true) {
      indexes.delete(oldest.value);
    }
  }
}

type PendingAppend = { key: string; cached: SparseIndex | undefined; before: BigIntStats };

/** Removes the cached index before the write; returns undefined when nothing can be certified. */
function prepareAppend(ref: string): PendingAppend | undefined {
  try {
    const key = indexes.size > 0 || readers.size > 0 ? realpathSync(ref) : ref;
    const cached = indexes.get(key);
    indexes.delete(key);
    if (cached === undefined && !readers.has(key)) {
      return undefined;
    }
    return { key, cached, before: statSync(ref, { bigint: true }) };
  } catch {
    /* Cache bookkeeping must not change write acceptance. */
    return undefined;
  }
}

function isAppend(before: BigIntStats, after: BigIntStats, text: string): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size + BigInt(byteLength(text))
  );
}

function certifyAppend(pending: PendingAppend, after: BigIntStats, text: string): void {
  const { key, cached, before } = pending;
  if (!isAppend(before, after, text)) {
    return;
  }
  if (cached !== undefined && sameRevision(cached.revision, before) && !text.includes("\ufffd")) {
    const next = cached.copy();
    next.extend(after, text);
    remember(key, next);
  }
  for (const progress of readers.get(key) ?? []) {
    if (!sameRevision(progress.revision, before)) {
      continue;
    }
    progress.extend(after, text);
    if (text.includes("\ufffd")) {
      progress.cacheable = false;
    }
  }
}

/** Only the native, synchronous history writer can certify an append. External changes invalidate. */
export function appendPlainOutput(ref: string, text: string): void {
  const pending = prepareAppend(ref);
  appendFileSync(ref, text, { flush: true });
  if (pending === undefined) {
    return;
  }
  try {
    certifyAppend(pending, statSync(ref, { bigint: true }), text);
  } catch {
    /* The durable append already succeeded; leave its index invalidated. */
  }
}

/** Accumulates one page without splitting a code point, including for tiny caps. */
class PlainPage {
  text = "";
  finished = false;
  private bytes = 0;
  private lines = 1;
  private readonly window: PlainReadWindow;

  constructor(window: PlainReadWindow) {
    this.window = window;
  }

  consume(chunk: string, total: number): void {
    const start = Math.max(0, this.window.offset - total);
    if (this.finished || start >= chunk.length) {
      return;
    }
    const codePoint = chunk.codePointAt(start - 1);
    if (start > 0 && codePoint !== undefined && codePoint > 0xffff) {
      throw new Error("offset must not split a Unicode surrogate pair");
    }
    for (const char of chunk.slice(start)) {
      if (!this.append(char)) {
        break;
      }
    }
  }

  private append(char: string): boolean {
    const nextBytes = this.bytes + byteLength(char);
    const nextLines = this.lines + (char === "\n" ? 1 : 0);
    if (
      this.text !== "" &&
      (nextBytes > this.window.maxBytes ||
        nextLines > this.window.maxLines ||
        this.text.length + char.length > this.window.limit)
    ) {
      this.finished = true;
      return false;
    }
    this.text += char;
    this.bytes = nextBytes;
    this.lines = nextLines;
    return true;
  }
}

/** Pairs an opened prefix with live native appends until validation and reading finish. */
class SnapshotRead {
  private readonly ref: string;
  private readonly file: FileHandle;
  private readonly revision: BigIntStats;
  private readonly fresh: SparseIndex;
  private index: SparseIndex;
  private readonly progress: AppendProgress;
  private readonly active: Set<AppendProgress>;
  private valid: boolean;
  private total = 0;
  private position = 0;
  private cacheable = true;

  constructor(ref: string, file: FileHandle) {
    this.ref = ref;
    this.file = file;
    // Do not yield between snapshot validation/registration and the synchronous writer.
    this.revision = fstatSync(file.fd, { bigint: true });
    const cached = indexes.get(ref);
    this.fresh = new SparseIndex(this.revision);
    const matched = cached !== undefined && sameRevision(cached.revision, this.revision);
    this.valid = matched;
    this.index = matched ? cached : this.fresh;
    // Append characters stay relative until the cold scan knows the opened prefix's total.
    this.progress = new AppendProgress(
      this.revision,
      { bytes: Number(this.revision.size), characters: 0 },
      this.index.stride,
      this.index.hasher.copy(),
    );
    this.active = readers.get(ref) ?? new Set<AppendProgress>();
    this.active.add(this.progress);
    readers.set(ref, this.active);
  }

  /** Discards a cached index whose digest no longer matches the opened bytes. */
  private invalidate(): void {
    indexes.delete(this.ref);
    this.valid = false;
    this.index = this.fresh;
    this.progress.hasher = createHash("sha256");
    this.progress.stride = this.fresh.stride;
  }

  /** Reads one page of the opened prefix; a cold scan also indexes and hashes that prefix. */
  async scan(window: PlainReadWindow): Promise<string> {
    const size = Number(this.revision.size);
    // Matching stat fields are not an immutability proof. Registration above pairs live appends
    // even while this full-content verification is awaiting disk reads.
    if (this.valid && this.index.digest !== (await digestOf(this.file, size))) {
      this.invalidate();
    }
    const point = this.valid ? this.index.pointAt(window.offset) : this.index.points[0];
    this.total = point.characters;
    this.position = point.bytes;
    const page = new PlainPage(window);
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let readPosition = point.bytes;
    // Bound each attempt to its opened snapshot, including while native history appends.
    while (readPosition < size) {
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        Math.min(buffer.length, size - readPosition),
        readPosition,
      );
      if (bytesRead === 0) {
        break;
      }
      readPosition += bytesRead;
      const raw = buffer.subarray(0, bytesRead);
      const chunk = decoder.write(raw) + (readPosition === size ? decoder.end() : "");
      this.recordChunk(raw, chunk);
      page.consume(chunk, this.total);
      this.total += chunk.length;
      if (this.valid && page.finished) {
        break;
      }
    }
    return page.text;
  }

  private recordChunk(raw: Buffer, chunk: string): void {
    if (this.valid) {
      return;
    }
    this.progress.hasher.update(raw);
    this.index.checkpoint({ bytes: this.position, characters: this.total });
    // Invalid/incomplete UTF8 can re-decode differently after append. Scan afresh next time.
    if (chunk.includes("\ufffd")) {
      this.cacheable = false;
    }
    this.position += byteLength(chunk);
  }

  /** Publishes the read synchronously with its release; undefined means the snapshot changed. */
  complete(page: string): ReadPage | undefined {
    // Only verified native appends may advance this snapshot. External edits still invalidate.
    if (!sameRevision(this.progress.revision, statSync(this.ref, { bigint: true }))) {
      return undefined;
    }
    if (!this.valid) {
      this.index.total = this.total;
    }
    // Serve the opened prefix; retain verified append checkpoints for the next read.
    if (this.cacheable && this.progress.cacheable) {
      remember(this.ref, this.index.withAppends(this.progress));
    }
    return { page, total: this.index.total };
  }

  release(): void {
    this.active.delete(this.progress);
    if (this.active.size === 0) {
      readers.delete(this.ref);
    }
  }
}

/** Sparse byte/UTF16 checkpoints, never retained file contents. Changed/uncacheable files scan afresh. */
export async function readPlainResult(ref: string, window: PlainReadWindow): Promise<ReadPage> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await open(ref, "r");
    let snapshot: SnapshotRead | undefined;
    try {
      snapshot = new SnapshotRead(ref, file);
      const result = snapshot.complete(await snapshot.scan(window));
      if (result !== undefined) {
        return result;
      }
    } finally {
      snapshot?.release();
      await file.close();
    }
  }
  throw new Error("MCP output artifact changed while reading; retry the page");
}
