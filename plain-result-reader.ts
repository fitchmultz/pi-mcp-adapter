import { appendFileSync, fstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { open, type FileHandle } from "node:fs/promises";
import { byteLength } from "./mcp-output-preview.ts";

type Point = { bytes: number; characters: number };
type Index = { revision: BigIntStats; total: number; points: Point[]; stride: number; digest: string; hasher: Hash };
type Progress = Index & { cacheable: boolean };
const indexes = new Map<string, Index>();
const readers = new Map<string, Set<Progress>>();
const MAX_INDEXES = 8;
const MAX_POINTS = 1024;

function sameRevision(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Raw full-content SHA-256. Returns "" on a short read so a truncated verify never matches. */
async function digestOf(file: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) return "";
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function checkpoint(index: Index, point: Point) {
  if (point.bytes - index.points.at(-1)!.bytes < index.stride) return;
  index.points.push(point);
  if (index.points.length > MAX_POINTS) {
    index.points = index.points.filter((_, i) => i % 2 === 0);
    index.stride *= 2;
  }
}

function remember(ref: string, index: Index) {
  indexes.delete(ref);
  indexes.set(ref, index);
  if (indexes.size > MAX_INDEXES) indexes.delete(indexes.keys().next().value!);
}

function extend(index: Index, after: BigIntStats, text: string) {
  // Clone before updating so a shared cached hasher never advances.
  index.hasher = index.hasher.copy();
  index.hasher.update(text, "utf8");
  let position = Number(index.revision.size);
  checkpoint(index, { bytes: position, characters: index.total });
  // Index only the accepted delta, keeping checkpoints on complete UTF-8 code points.
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 16 * 1024);
    if (end < text.length && text.codePointAt(end - 1)! > 0xffff) end++;
    position += byteLength(text.slice(start, end));
    checkpoint(index, { bytes: position, characters: index.total + end });
    start = end;
  }
  index.total += text.length;
  index.revision = after;
  index.digest = index.hasher.copy().digest("hex");
}

/** Only the native, synchronous history writer can certify an append. External changes invalidate. */
export function appendPlainOutput(ref: string, text: string) {
  let key = ref, cached: Index | undefined, before: BigIntStats | undefined;
  try {
    key = indexes.size || readers.size ? realpathSync(ref) : ref;
    cached = indexes.get(key);
    indexes.delete(key);
    if (cached || readers.has(key)) before = statSync(ref, { bigint: true });
  } catch { /* Cache bookkeeping must not change write acceptance. */ }
  appendFileSync(ref, text, { flush: true });
  if (!before) return;
  try {
    const after = statSync(ref, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size + BigInt(byteLength(text))) return;
    if (cached && sameRevision(cached.revision, before) && !text.includes("\ufffd")) {
      const next = { ...cached, points: [...cached.points] };
      extend(next, after, text);
      remember(key, next);
    }
    for (const progress of readers.get(key) ?? []) {
      if (!sameRevision(progress.revision, before)) continue;
      extend(progress, after, text);
      if (text.includes("\ufffd")) progress.cacheable = false;
    }
  } catch { /* The durable append already succeeded; leave its index invalidated. */ }
}

/** Sparse byte/UTF16 checkpoints, never retained file contents. Changed/uncacheable files scan afresh. */
export async function readPlainResult(ref: string, offset: number, limit: number, maxBytes: number, maxLines: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await open(ref, "r");
    let progress: Progress | undefined;
    try {
      // Pair snapshot registration/validation with the synchronous writer without yielding between them.
      const revision = fstatSync(file.fd, { bigint: true });
      const cached = indexes.get(ref);
      const matched = cached !== undefined && sameRevision(cached.revision, revision);
      const fresh: Index = { revision, total: 0, points: [{ bytes: 0, characters: 0 }],
        stride: 64 * 1024, digest: "", hasher: createHash("sha256") };
      let index: Index = matched ? cached! : fresh;
      // Append characters stay relative until the cold scan knows the opened prefix's total.
      progress = { revision, total: 0, points: [{ bytes: Number(revision.size), characters: 0 }],
        stride: index.stride, cacheable: true, digest: "", hasher: index.hasher.copy() };
      const active = readers.get(ref) ?? new Set<Progress>();
      active.add(progress);
      readers.set(ref, active);
      // Matching stat fields are not an immutability proof: verify the cached digest against current
      // bytes. Registering the snapshot first keeps live appends paired during the verification read.
      let valid: Index | undefined = matched ? cached : undefined;
      if (valid && valid.digest !== (await digestOf(file, Number(revision.size)))) {
        indexes.delete(ref);
        valid = undefined;
        index = fresh;
        progress.hasher = createHash("sha256");
        progress.stride = fresh.stride;
      }
      let point = index.points[0]!;
      if (valid) {
        for (const candidate of index.points) {
          if (candidate.characters > offset) break;
          point = candidate;
        }
      }
      let total = point.characters, position = point.bytes;
      let bytes = 0, lines = 1, page = "", finished = false, cacheable = true;
      // Bound each attempt to its opened file snapshot, including while native history appends.
      if (revision.size > 0n) {
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let readPosition = point.bytes;
        while (readPosition < Number(revision.size)) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(revision.size) - readPosition), readPosition);
          if (!bytesRead) break;
          readPosition += bytesRead;
          const chunk = decoder.write(buffer.subarray(0, bytesRead)) + (readPosition === Number(revision.size) ? decoder.end() : "");
          if (!valid) {
            progress.hasher.update(buffer.subarray(0, bytesRead));
            checkpoint(index, { bytes: position, characters: total });
            // Invalid/incomplete UTF8 can re-decode differently after append. Keep the full-scan fallback.
            if (chunk.includes("\ufffd")) cacheable = false;
            position += byteLength(chunk);
          }
          const start = Math.max(0, offset - total);
          if (!finished && start < chunk.length) {
            if (start > 0 && chunk.codePointAt(start - 1)! > 0xffff) throw new Error("offset must not split a Unicode surrogate pair");
            for (const char of chunk.slice(start)) {
              const nextBytes = bytes + byteLength(char);
              const nextLines = lines + (char === "\n" ? 1 : 0);
              if (page && (nextBytes > maxBytes || nextLines > maxLines || page.length + char.length > limit)) { finished = true; break; }
              page += char; bytes = nextBytes; lines = nextLines;
            }
          }
          total += chunk.length;
          if (valid && finished) break;
        }
      }
      // Only verified native appends may advance this snapshot. External edits still invalidate.
      if (!sameRevision(progress.revision, statSync(ref, { bigint: true }))) continue;
      if (!valid) index.total = total;
      // Serve the opened prefix; retain verified append checkpoints for the next read.
      if (cacheable && progress.cacheable) {
        const next: Index = { ...index, revision: progress.revision, total: index.total + progress.total,
          points: [...index.points], digest: progress.hasher.copy().digest("hex"), hasher: progress.hasher };
        for (const point of progress.points) checkpoint(next, { bytes: point.bytes, characters: index.total + point.characters });
        remember(ref, next);
      }
      return { page, total: index.total };
    } finally {
      if (progress) {
        const active = readers.get(ref)!;
        active.delete(progress);
        if (!active.size) readers.delete(ref);
      }
      await file.close();
    }
  }
  throw new Error("MCP output artifact changed while reading; retry the page");
}
