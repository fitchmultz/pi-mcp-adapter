import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMcpResult, saveMcpOutputStream } from "../mcp-output-guard.ts";
import { createUiMessageHistory } from "../ui-message-history.ts";

const io = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = fs.createReadStream(...args);
    stream.on("data", chunk => { io.bytes += Buffer.byteLength(chunk); });
    return stream;
  } };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function readPrototype(ref: string) {
  const file = await open(ref);
  const prototype = Object.getPrototypeOf(file);
  await file.close();
  return prototype;
}
async function measureReads(ref: string) {
  const reads = vi.spyOn(await readPrototype(ref), "read").mockClear();
  io.bytes = 0;
  return async () => io.bytes + (await Promise.all(reads.mock.results.map(result => result.value))).reduce((total, result) => total + result.bytesRead, 0);
}
async function root() { const path = await mkdtemp(join(tmpdir(), "mcp-index-")); roots.push(path); return path; }
async function save(text: string, outputDirectory: string) {
  const saved = await saveMcpOutputStream((async function* () { yield text; })(), outputDirectory);
  expect(saved.error).toBeUndefined();
  return saved.path!;
}

describe("incremental plain-result paging", () => {
  it("reads only a sparse window on repeated early and late pages, keeping UTF16 totals", async () => {
    const outputDirectory = await root();
    const text = "é😀abc\n".repeat(300_000);
    const ref = await save(text, outputDirectory);
    const read = (offset: number) => readMcpResult({ ref, offset, limit: 399 }, { outputDirectory });
    expect((await read(0)).details).toMatchObject({ totalCharacters: text.length, nextOffset: 399 });
    const bytesRead = await measureReads(ref);
    for (const offset of [399, text.length - 700, 0]) {
      const page = await read(offset);
      expect(page.content[0]!.text).toBe(text.slice(offset, offset + 399));
      expect(page.details).toMatchObject({ totalCharacters: text.length, nextOffset: offset + 399 });
    }
    expect(await bytesRead()).toBeLessThan(512 * 1024);
  });

  it("advances a cached native history after accepted appends without rereading its prefix", async () => {
    const outputDirectory = await root();
    const history = createUiMessageHistory(outputDirectory);
    expect(history.append("prompts", "é😀".repeat(400_000))).toBeUndefined();
    const ref = history.messages.historyRef!;
    await readMcpResult({ ref, limit: 40 }, { outputDirectory });
    expect(history.append("notifications", "new 😀 event")).toBeUndefined();
    const text = await readFile(ref, "utf8");
    const bytesRead = await measureReads(ref);
    const offset = text.length - 100;
    const page = await readMcpResult({ ref, offset, limit: 200 }, { outputDirectory });
    expect(page.content[0]!.text).toBe(text.slice(offset));
    expect(page.details).toMatchObject({ totalCharacters: text.length, nextOffset: null });
    expect(await bytesRead()).toBeLessThan(256 * 1024);

    expect(history.append("prompts", "é😀".repeat(100_000))).toBeUndefined();
    const grown = await readFile(ref, "utf8");
    const late = grown.lastIndexOf("é");
    const firstDeltaBytes = await measureReads(ref);
    const tail = await readMcpResult({ ref, offset: late }, { outputDirectory });
    expect(tail.content[0]!.text).toBe(grown.slice(late));
    expect(tail.details).toMatchObject({ totalCharacters: grown.length, nextOffset: null });
    expect(await firstDeltaBytes()).toBeLessThan(256 * 1024);
    const warmBytes = await measureReads(ref);
    expect((await readMcpResult({ ref, offset: late }, { outputDirectory })).content[0]!.text).toBe(grown.slice(late));
    expect(await warmBytes()).toBeLessThan(256 * 1024);
  });

  it("invalidates for external redaction with growth, same-size edits, truncation, rotation and removal", async () => {
    const outputDirectory = await root();
    const history = createUiMessageHistory(outputDirectory);
    history.append("prompts", "original ".repeat(20_000));
    const ref = history.messages.historyRef!;
    const check = async (text: string) => {
      const page = await readMcpResult({ ref, limit: 50 }, { outputDirectory });
      expect(page.content[0]!.text).toBe(text.slice(0, 50));
      expect(page.details).toMatchObject({ totalCharacters: text.length });
    };
    await check(await readFile(ref, "utf8"));
    const prototype = await readPrototype(ref);
    const originalRead = prototype.read;
    const redacted = "redacted😀 ".repeat(30_000);
    const reads = vi.spyOn(prototype, "read").mockImplementationOnce(async function(this: FileHandle, ...args: unknown[]) {
      const result = await originalRead.apply(this, args);
      await writeFile(ref, redacted);
      expect(history.append("notifications", "after edit")).toBeUndefined();
      return result;
    });
    await check(redacted + JSON.stringify({ category: "notifications", value: "after edit" }) + "\n");
    reads.mockRestore();
    for (const text of ["redacted ".repeat(30_000), "replaced ".repeat(30_000), "short 😀"]) {
      await writeFile(ref, text);
      // A later native append must not bless an earlier external rewrite as append-only.
      expect(history.append("notifications", "after edit")).toBeUndefined();
      await check(await readFile(ref, "utf8"));
    }
    const replacement = join(outputDirectory, "replacement.txt");
    await writeFile(replacement, "rotated é😀");
    await rename(replacement, ref);
    await check("rotated é😀");
    await rm(ref);
    expect((await readMcpResult({ ref }, { outputDirectory })).details).toMatchObject({ error: "result_read_failed" });
  });

  it("serves stable prefix snapshots while native appends interleave with cold and warm reads", async () => {
    const outputDirectory = await root();
    const history = createUiMessageHistory(outputDirectory);
    expect(history.append("prompts", "x".repeat(1_000_000) + "😀")).toBeUndefined();
    const ref = history.messages.historyRef!;
    const prefix = await readFile(ref, "utf8");
    const prototype = await readPrototype(ref);
    const originalRead = prototype.read;
    let appends = 0;
    const reads = vi.spyOn(prototype, "read").mockImplementation(async function(this: FileHandle, ...args: unknown[]) {
      const result = await originalRead.apply(this, args);
      expect(history.append("notifications", `live😀-${++appends}`)).toBeUndefined();
      return result;
    });
    const cold = await readMcpResult({ ref, limit: 12_000 }, { outputDirectory });
    expect(cold.content[0]!.text).toBe(prefix.slice(0, 12_000));
    expect(cold.details).toMatchObject({ totalCharacters: prefix.length, nextOffset: 12_000 });
    expect(appends).toBeGreaterThan(0);
    const beforeWarm = await readFile(ref, "utf8");
    reads.mockClear();
    const warm = await readMcpResult({ ref, limit: 12_000 }, { outputDirectory });
    expect(warm.content[0]!.text).toBe(beforeWarm.slice(0, 12_000));
    expect(warm.details).toMatchObject({ totalCharacters: beforeWarm.length, nextOffset: 12_000 });
    expect((await Promise.all(reads.mock.results.map(result => result.value))).reduce((total, result) => total + result.bytesRead, 0)).toBeLessThan(128 * 1024);
    reads.mockRestore();
    const complete = await readFile(ref, "utf8");
    const bytesRead = await measureReads(ref);
    const offset = complete.lastIndexOf('{"category":');
    const tail = await readMcpResult({ ref, offset }, { outputDirectory });
    expect(tail.content[0]!.text).toBe(complete.slice(offset));
    expect(tail.details).toMatchObject({ totalCharacters: complete.length, nextOffset: null });
    expect(await bytesRead()).toBeLessThan(128 * 1024);
  });

  it("redecodes incomplete UTF8 on append and preserves access checks on warm indexes", async () => {
    const outputDirectory = await root();
    const ref = await save("prefix ", outputDirectory);
    await readMcpResult({ ref }, { outputDirectory });
    const emoji = Buffer.from("😀");
    for (const part of [emoji.subarray(0, 2), emoji.subarray(2)]) {
      await appendFile(ref, part);
      const text = await readFile(ref, "utf8");
      const page = await readMcpResult({ ref }, { outputDirectory });
      expect(page.content[0]!.text).toBe(text);
      expect(page.details).toMatchObject({ totalCharacters: text.length, nextOffset: null });
    }
    const otherRoot = await root();
    expect((await readMcpResult({ ref }, { outputDirectory: otherRoot })).details).toMatchObject({ error: "result_read_failed" });
  });
});
