import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readMcpResult, saveMcpOutputStream } from "../mcp-output-guard.ts";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), "mcp-plain-pages-")); roots.push(root);
  const saved = await saveMcpOutputStream((async function* () { for (let i = 0; i < text.length; i += 65_536) yield text.slice(i, i + 65_536); })(), root);
  if (!saved.path) throw new Error(saved.error);
  return { root, ref: saved.path };
}
function check(page: Awaited<ReturnType<typeof readMcpResult>>, expected: string, offset: number, limit: number) {
  expect(page.details).not.toHaveProperty("error");
  let text = expected.slice(offset, offset + limit);
  if (text.charCodeAt(text.length - 1) >= 0xd800 && text.charCodeAt(text.length - 1) <= 0xdbff) text = text.slice(0, -1);
  expect(page.content[0]!.text).toBe(text);
  const end = offset + text.length;
  expect(page.details).toMatchObject({ totalCharacters: expected.length, offset, nextOffset: end < expected.length ? end : null });
}

// A fresh process counts successful Node filesystem reads, not a private helper or elapsed-time threshold.
async function reopened(ref: string, root: string, offsets: number[]) {
  const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    const {readMcpResult}=await import(process.argv[1]);
    let bytes=0;
    const read=fs.read;
    fs.read=function(...args){const callback=args.pop();return read.call(this,...args,(error,size,...rest)=>{bytes+=size??0;callback(error,size,...rest);});};
    const probe=await fs.promises.open(process.argv[2]);const prototype=Object.getPrototypeOf(probe);await probe.close();
    const readHandle=prototype.read;
    prototype.read=async function(...args){const result=await readHandle.apply(this,args);bytes+=result.bytesRead;return result;};
    const rows=[];
    for(const offset of JSON.parse(process.argv[4])){bytes=0;const page=await readMcpResult({ref:process.argv[2],offset,limit:12000},{outputDirectory:process.argv[3]});rows.push({page,bytes});}
    console.log(JSON.stringify(rows));
  `, new URL("../mcp-output-guard.ts", import.meta.url).href, ref, root, JSON.stringify(offsets)], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout) as Array<{ page: Awaited<ReturnType<typeof readMcpResult>>; bytes: number }>;
}

describe("plain output artifact readback", () => {
  it("bounds reopened arbitrary-page I/O instead of rescanning the retained artifact", async () => {
    const expected = "x".repeat(8 * 1024 * 1024);
    const { root, ref } = await fixture(expected);
    const offsets = [expected.length - 24_000, 0, 12000, 3_123_456];
    const rows = await reopened(ref, root, offsets);
    rows.forEach(({ page }, i) => check(page, expected, offsets[i]!, 12000));
    // Each valid page must read data, but not all eight MiB to rediscover its total.
    expect(rows.every(row => row.bytes > 0)).toBe(true);
    for (const row of rows) expect(row.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(await readFile(ref, "utf8")).toBe(expected);
  });

  it("coarsens a sparse multi-GiB artifact without losing offsets beyond 32 bits", async () => {
    const { root, ref } = await fixture("");
    const bytes = 2 ** 32 + 1024 * 1024, offset = 2 ** 32 + 65_535, marker = "é😀TAIL";
    const file = await open(ref, "r+");
    try {
      // Sparse NULs exercise the index limit without a multi-GiB string or equivalent disk allocation.
      await file.truncate(bytes);
      const encoded = Buffer.from(marker); await file.write(encoded, 0, encoded.length, offset);
    } finally { await file.close(); }
    const expected = marker + "\0".repeat(12_000 - marker.length);
    const totalCharacters = bytes - (Buffer.byteLength(marker) - marker.length);
    const [cold] = await reopened(ref, root, [offset]);
    expect(cold!.page.content[0]!.text).toBe(expected);
    expect(cold!.page.details).toMatchObject({ offset, nextOffset: offset + 12_000, totalCharacters });
    const [warm] = await reopened(ref, root, [offset]);
    expect(warm!.page.content[0]!.text).toBe(expected);
    expect(warm!.page.details).toMatchObject({ offset, nextOffset: offset + 12_000, totalCharacters });
    expect(warm!.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.parse(await readFile(`${ref}.index.json`, "utf8")).points.length).toBeLessThanOrEqual(4096);
    expect((await readMcpResult({ ref, offset: offset + 2 }, { outputDirectory: root })).details.error).toBe("result_read_failed");
  }, 60_000);

  it("seeks by UTF-16 units through nonuniform Unicode beyond sparse checkpoints", async () => {
    const { root, ref } = await fixture("preexisting");
    const expected = Array.from({ length: 48 }, (_, i) => `block-${i}:` + `abcé😀中${i}:`.repeat(6000) + "\n").join("");
    await writeFile(ref, expected);
    const offsets = [1_234_567, 1_048_575, 2_123_456, expected.length - 24_001, 65_534].map(offset => {
      const unit = expected.charCodeAt(offset);
      return unit >= 0xdc00 && unit <= 0xdfff ? offset - 1 : offset;
    });
    // No offset-zero warmup. The old artifact must acquire a correct disposable index from its real bytes.
    check(await readMcpResult({ ref, offset: offsets[0]!, limit: 12000 }, { outputDirectory: root }), expected, offsets[0]!, 12000);
    const rows = await reopened(ref, root, offsets);
    rows.forEach(({ page }, i) => check(page, expected, offsets[i]!, 12000));
    for (const { bytes } of rows) expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(await readFile(ref, "utf8")).toBe(expected);
  });

  it.each(["edit", "replace"])("does not mix revisions during an in-flight %s", async mode => {
    const original = "A".repeat(2 * 1024 * 1024);
    const replacement = "B".repeat(3 * 1024 * 1024);
    const { root, ref } = await fixture(original);
    const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      const {readMcpResult}=await import(process.argv[1]);
      const ref=process.argv[2],root=process.argv[3],mode=process.argv[4];
      const identity=await fs.promises.stat(ref,{bigint:true});let changed=false;
      async function change(fd){
        if(changed||fs.fstatSync(fd,{bigint:true}).ino!==identity.ino)return;
        changed=true;const next='B'.repeat(3*1024*1024);
        if(mode==='replace'){await fs.promises.writeFile(ref+'.replacement',next);await fs.promises.rename(ref+'.replacement',ref);}
        else await fs.promises.writeFile(ref,next);
      }
      const read=fs.read;
      fs.read=function(...args){const fd=args[0],callback=args.pop();return read.call(this,...args,async(error,...rest)=>{if(!error)await change(fd);callback(error,...rest);});};
      const probe=await fs.promises.open(ref),prototype=Object.getPrototypeOf(probe);await probe.close();const readHandle=prototype.read;
      prototype.read=async function(...args){const result=await readHandle.apply(this,args);await change(this.fd);return result;};
      const page=await readMcpResult({ref,limit:12000},{outputDirectory:root});
      console.log(JSON.stringify({changed,page}));
    `, new URL("../mcp-output-guard.ts", import.meta.url).href, ref, root, mode], { maxBuffer: 1024 * 1024 });
    const { changed, page } = JSON.parse(stdout) as { changed: boolean; page: Awaited<ReturnType<typeof readMcpResult>> };
    expect(changed).toBe(true);
    if ("nextOffset" in page.details) check(page, page.details.totalCharacters === original.length ? original : replacement, 0, 12000);
    else expect(page.details).toMatchObject({ error: "result_read_failed", message: "MCP output artifact changed during read; retry read-result" });
    check(await readMcpResult({ ref, limit: 12000 }, { outputDirectory: root }), replacement, 0, 12000);
  });

  it("reopens old caller-created artifacts directly at distant and concurrent offsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-old-pages-")); roots.push(root);
    const dir = join(root, "pi-mcp-output-preexisting"); await mkdir(dir, { mode: 0o700 });
    const ref = join(dir, "output-a1.txt");
    const expected = "a".repeat(1_100_000) + "é😀Z\n";
    await writeFile(ref, expected, { mode: 0o600 });
    const [row] = await reopened(ref, root, [1_099_990]);
    check(row!.page, expected, 1_099_990, 12000);
    const offsets = [17, expected.length, 1_048_574, 0, expected.length + 100];
    const pages = await Promise.all(offsets.map(offset => readMcpResult({ ref, offset, limit: 12 }, { outputDirectory: root })));
    pages.forEach((page, i) => check(page, expected, offsets[i]!, 12));
  });

  it("invalidates same-size/restored-mtime edits, replacement, append, truncation, deletion and repair", async () => {
    const initial = "a".repeat(1_100_000) + "😀TAIL";
    const { root, ref } = await fixture(initial);
    const fixedTime = 1_234_567_890;
    await utimes(ref, fixedTime, fixedTime);
    check(await readMcpResult({ ref, limit: 16 }, { outputDirectory: root }), initial, 0, 16);
    const before = await stat(ref, { bigint: true });
    const edited = "é" + "b".repeat(1_100_006);
    await writeFile(ref, edited); await utimes(ref, fixedTime, fixedTime);
    const after = await stat(ref, { bigint: true });
    expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs);
    const changedOffsets = [0, 1_099_990];
    (await reopened(ref, root, changedOffsets)).forEach(({ page }, i) => check(page, edited, changedOffsets[i]!, 12000));
    const replacement = "c".repeat(1_100_004) + "😀";
    const swap = join(dirname(ref), "replacement.tmp");
    await writeFile(swap, replacement); await utimes(swap, fixedTime, fixedTime); await rename(swap, ref);
    expect((await stat(ref, { bigint: true })).ino).not.toBe(after.ino);
    check(await readMcpResult({ ref, offset: 1_099_990, limit: 12000 }, { outputDirectory: root }), replacement, 1_099_990, 12000);
    for (const current of [replacement + "\nAPPENDED", "short😀", ""]) {
      await writeFile(ref, current);
      check(await readMcpResult({ ref, limit: 12000 }, { outputDirectory: root }), current, 0, 12000);
    }
    await rm(ref);
    expect((await readMcpResult({ ref }, { outputDirectory: root })).details.error).toBe("result_read_failed");
    await writeFile(ref, "repaired é😀");
    check(await readMcpResult({ ref, limit: 12000 }, { outputDirectory: root }), "repaired é😀", 0, 12000);
  });

  it("preserves Unicode across writer and UTF-8 stream boundaries without treating code points as offsets", async () => {
    // The writer encodes each string chunk separately. The oracle is persisted bytes, including replacements for split input surrogates.
    const { root, ref } = await fixture("\uFEFF" + "a".repeat(65_534) + "😀é\u0301\0\r\n" + "b".repeat(1_048_575) + "😀END");
    const expected = (await readFile(ref)).toString("utf8");
    for (const offset of [0, 65_534, 65_535, 65_536, 65_537, 1_048_574, expected.length - 6, expected.length, expected.length + 1]) {
      const page = await readMcpResult({ ref, offset, limit: 12_000 }, { outputDirectory: root });
      if (expected.charCodeAt(offset) >= 0xdc00 && expected.charCodeAt(offset) <= 0xdfff) {
        expect(page.details).toMatchObject({ error: "result_read_failed", message: "offset must not split a Unicode surrogate pair" });
      } else check(page, expected, offset, 12_000);
    }
    const pair = expected.lastIndexOf("😀");
    expect((await readMcpResult({ ref, offset: pair + 1 }, { outputDirectory: root })).details.error).toBe("result_read_failed");
  });

  it.each([
    Buffer.concat([Buffer.from("a".repeat(65_535)), Buffer.from("😀é\uFEFFZ")]),
    Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x80, 0xc0, 0xaf, 0xf0, 0x9f]),
    Buffer.concat([Buffer.from("x".repeat(65_535)), Buffer.from([0xe2, 0x82])]),
  ])("reads externally supplied and truncated UTF-8 with Node's replacement semantics", async bytes => {
    const { root, ref } = await fixture("original"); await writeFile(ref, bytes);
    const expected = bytes.toString("utf8");
    for (const offset of [0, Math.max(0, expected.length - 10), expected.length]) {
      check(await readMcpResult({ ref, offset, limit: 12000 }, { outputDirectory: root }), expected, offset, 12000);
    }
  });

  it.each([{ maxBytes: 512, maxLines: 4, limit: 7 }, { maxBytes: 1, maxLines: 1, limit: 1 }])("reconstructs plain text with truthful caps and complete tiny-cap characters (%j)", async ({ limit, ...caps }) => {
    const expected = "\uFEFFé😀a\r\n\0e\u0301\n".repeat(8);
    const { root, ref } = await fixture(expected);
    let offset = 0, joined = "";
    for (let count = 0; count <= expected.length; count++) {
      const page = await readMcpResult({ ref, offset, limit }, { outputDirectory: root, ...caps });
      expect(page.details).not.toHaveProperty("error");
      if (!("nextOffset" in page.details)) throw new Error(page.details.message);
      const text = page.content[0]!.text;
      expect(Buffer.from(text).toString("utf8")).toBe(text);
      joined += text;
      if (caps.maxBytes > 1) {
        const visible = page.content.map(block => block.text).join("\n");
        expect(Buffer.byteLength(visible)).toBeLessThanOrEqual(caps.maxBytes);
        expect(visible.split("\n").length).toBeLessThanOrEqual(caps.maxLines);
      } else expect([...text]).toHaveLength(1);
      if (page.details.nextOffset === null) break;
      expect(page.details.nextOffset).toBe(offset + text.length);
      expect(page.content[1]!.text).toContain(`Continue with offset: ${offset + text.length}.`);
      offset += text.length;
    }
    expect(joined).toBe(expected);
  });

  it("keeps text authoritative when derived files are missing, corrupt or unwritable", async () => {
    const expected = "z".repeat(1_100_000) + "é😀END";
    const { root, ref } = await fixture(expected);
    const sidecar = `${ref}.index.json`;
    for (const data of ["{", "", JSON.stringify({ version: 999 }), JSON.stringify({ version: 1, points: [[-1, 0]] })]) {
      await writeFile(sidecar, data, { mode: 0o600 });
      check(await readMcpResult({ ref, offset: 1_099_990, limit: 12000 }, { outputDirectory: root }), expected, 1_099_990, 12000);
    }
    await rm(sidecar); await mkdir(sidecar); // A real filesystem failure, even when the test runner is root.
    check(await readMcpResult({ ref, offset: 1_099_990, limit: 12000 }, { outputDirectory: root }), expected, 1_099_990, 12000);
    expect(await readFile(ref, "utf8")).toBe(expected);
    await rm(sidecar, { recursive: true });
    check(await readMcpResult({ ref, limit: 12 }, { outputDirectory: root }), expected, 0, 12);
    if (process.platform !== "win32") {
      expect((await stat(ref)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(ref))).mode & 0o777).toBe(0o700);
      for (const name of await readdir(dirname(ref))) expect((await stat(join(dirname(ref), name))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects malformed matching-revision checkpoint tables and oversized derivatives", async () => {
    const expected = Array.from({ length: 200_000 }, (_, i) => `${String(i).padStart(7, "0")}:é😀|`).join("");
    const { root, ref } = await fixture(expected);
    const sidecar = `${ref}.index.json`;
    const original = JSON.parse(await readFile(sidecar, "utf8"));
    expect(original.points.length).toBeGreaterThan(2);
    for (const mutate of [
      (index: any) => { index.points[1][0] = 0; },
      (index: any) => { index.points[1][1] = index.bytes + 1; },
      (index: any) => { index.points = Array.from({ length: 4097 }, (_, i) => [i, i]); },
      (index: any) => { index.totalCharacters = index.bytes + 1; },
      (index: any) => { index.points[1] = ["1048576", 1048576]; },
    ]) {
      const corrupt = structuredClone(original); mutate(corrupt);
      await writeFile(sidecar, JSON.stringify(corrupt));
      const offset = original.points[1][0];
      check(await readMcpResult({ ref, offset, limit: 12000 }, { outputDirectory: root }), expected, offset, 12000);
    }
  });

  it("bounds metadata I/O before allocating a whitespace-padded oversized index", async () => {
    const expected = "public".repeat(22_000);
    const { root, ref } = await fixture(expected);
    const sidecar = `${ref}.index.json`;
    await writeFile(sidecar, await readFile(sidecar, "utf8") + " ".repeat(1024 * 1024));
    const [row] = await reopened(ref, root, [0]);
    check(row!.page, expected, 0, 12000);
    // Rebuild the small source, not a MiB of valid but unbounded derivative whitespace.
    expect(row!.bytes).toBeLessThan(512 * 1024);
  });

  it("reauthorizes every read, preserves canonical aliases and rejects source or derived symlink escapes", async () => {
    const { root, ref } = await fixture("allowed😀");
    const other = await mkdtemp(join(tmpdir(), "mcp-other-root-")); roots.push(other);
    const outside = join(other, "private.txt"), secret = "PRIVATE".repeat(4096);
    await writeFile(outside, secret);
    const alias = join(other, "alias.txt"); await symlink(ref, alias);
    check(await readMcpResult({ ref: alias, limit: 12000 }, { outputDirectory: root }), "allowed😀", 0, 12000);
    expect((await readMcpResult({ ref }, { outputDirectory: other })).details.error).toBe("result_read_failed");
    const sidecar = `${ref}.index.json`; await rm(sidecar, { force: true }); await symlink(outside, sidecar);
    const [safe] = await reopened(ref, root, [0]);
    check(safe!.page, "allowed😀", 0, 12000);
    expect(safe!.bytes).toBeLessThan(16 * 1024);
    expect(await readFile(outside, "utf8")).toBe(secret);
    await rm(ref); await symlink(outside, ref);
    expect((await readMcpResult({ ref }, { outputDirectory: root })).details.error).toBe("result_read_failed");
  });

  it("does not reinterpret JSON-looking plain output unless selection was requested", async () => {
    const raw = '  {"a":1,"nested":{"b":2}}\n';
    const { root, ref } = await fixture(raw);
    check(await readMcpResult({ ref }, { outputDirectory: root }), raw, 0, 12000);
    expect((await readMcpResult({ ref, path: "" }, { outputDirectory: root })).content[0]!.text).toBe(JSON.stringify(JSON.parse(raw), null, 2));
    expect((await readMcpResult({ ref, fields: [] }, { outputDirectory: root })).content[0]!.text).toBe("{}");
    expect((await readMcpResult({ ref, path: "/nested/b" }, { outputDirectory: root })).content[0]!.text).toBe("2");
  });
});
