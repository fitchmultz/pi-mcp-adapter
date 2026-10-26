import { appendFileSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { open, stat } from "node:fs/promises";
import { byteLength } from "./mcp-output-preview.ts";

type Point = { bytes: number; characters: number };
type Index = { revision: BigIntStats; total: number; points: Point[]; stride: number };
const indexes = new Map<string, Index>();
const MAX_INDEXES = 8;
const MAX_POINTS = 1024;

function sameRevision(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
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

/** Only the native, synchronous history writer can certify an append. External changes invalidate. */
export function appendPlainOutput(ref: string, text: string) {
  let key = ref, cached: Index | undefined, before: BigIntStats | undefined;
  try {
    key = indexes.size ? realpathSync(ref) : ref;
    cached = indexes.get(key);
    indexes.delete(key);
    if (cached) before = statSync(ref, { bigint: true });
  } catch { /* Cache bookkeeping must not change write acceptance. */ }
  appendFileSync(ref, text, { flush: true });
  if (!cached || !before || !sameRevision(cached.revision, before)) return;
  try {
    const after = statSync(ref, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size + BigInt(byteLength(text)) || text.includes("\ufffd")) return;
    const next = { ...cached, revision: after, total: cached.total + text.length, points: [...cached.points] };
    let position = Number(before.size);
    checkpoint(next, { bytes: position, characters: cached.total });
    // Index only the accepted delta, keeping checkpoints on complete UTF-8 code points.
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 16 * 1024);
      if (end < text.length && text.codePointAt(end - 1)! > 0xffff) end++;
      position += byteLength(text.slice(start, end));
      checkpoint(next, { bytes: position, characters: cached.total + end });
      start = end;
    }
    remember(key, next);
  } catch { /* The durable append already succeeded; leave its index invalidated. */ }
}

/** Sparse byte/UTF16 checkpoints, never retained file contents. Changed/uncacheable files scan afresh. */
export async function readPlainResult(ref: string, offset: number, limit: number, maxBytes: number, maxLines: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await open(ref, "r");
    try {
      const revision = await file.stat({ bigint: true });
      const cached = indexes.get(ref);
      const valid = cached && sameRevision(cached.revision, revision) ? cached : undefined;
      if (!valid) indexes.delete(ref);
      const index: Index = valid ?? { revision, total: 0, points: [{ bytes: 0, characters: 0 }], stride: 64 * 1024 };
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
      // Never reuse totals across ordinary rewrites/redactions, truncation, rotation or file errors.
      if (!sameRevision(revision, await file.stat({ bigint: true })) || !sameRevision(revision, await stat(ref, { bigint: true }))) continue;
      if (!valid) index.total = total;
      if (cacheable) remember(ref, index);
      return { page, total: index.total };
    } finally { await file.close(); }
  }
  throw new Error("MCP output artifact changed while reading; retry the page");
}
