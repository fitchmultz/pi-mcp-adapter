#!/usr/bin/env node
// Real retained files and registered native tools; no providers or private sessions are contacted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, open, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, source: { type: "string", default: process.cwd() }, output: { type: "string" },
  rounds: { type: "string", default: "5" }, sizes: { type: "string", default: "1,16,64" }, consumer: { type: "string", default: "helper,native" },
  work: { type: "boolean" }, profile: { type: "boolean" }, worker: { type: "string" }, help: { type: "boolean" },
} });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const chunk = "x".repeat(65_535) + "\n";
async function fileHash(path) { const hash = createHash("sha256"); for await (const bytes of fs.createReadStream(path)) hash.update(bytes); return hash.digest("hex"); }

function observeReads() {
  let bytes = 0, characters = 0, decoded = 0, textDecoded = 0, bufferCalls = 0, bufferBytes = 0;
  const decode = StringDecoder.prototype.write;
  StringDecoder.prototype.write = function (...args) { const text = decode.apply(this, args); decoded += text.length; return text; };
  const textDecode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (...args) { const text = textDecode.apply(this, args); textDecoded += text.length; return text; };
  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"]) {
    const allocate = Buffer[name];
    Buffer[name] = function (size, ...rest) { bufferCalls++; bufferBytes += size; return allocate.call(this, size, ...rest); };
  }
  const read = fs.read;
  fs.read = function (...args) { const callback = args.pop(); return read.call(this, ...args, (error, size, ...rest) => { bytes += size ?? 0; callback(error, size, ...rest); }); };
  const iterator = String.prototype[Symbol.iterator];
  String.prototype[Symbol.iterator] = function () { const inner = iterator.call(this); return { next() { const r = inner.next(); if (!r.done) characters += r.value.length; return r; }, [Symbol.iterator]() { return this; } }; };
  return {
    async handles(ref) {
      const file = await open(ref); const prototype = Object.getPrototypeOf(file); await file.close();
      const read = prototype.read;
      prototype.read = async function (...args) { const result = await read.apply(this, args); bytes += result.bytesRead; return result; };
    },
    reset() { bytes = 0; characters = 0; decoded = 0; textDecoded = 0; bufferCalls = 0; bufferBytes = 0; },
    result() { return { bytesRead: bytes, iteratedUtf16Units: characters, stringDecoderUtf16Units: decoded, textDecoderUtf16Units: textDecoded, visibleBufferAllocationCalls: bufferCalls, requestedBufferBytes: bufferBytes }; },
  };
}

async function nativeConsumer(source, root, outputDirectory) {
  const manifestPath = findPackageJSON("@earendil-works/pi-coding-agent", pathToFileURL(join(source, "package.json")));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const index = join(dirname(manifestPath), "dist/index.js");
  const cli = join(dirname(manifestPath), manifest.bin.pi);
  const sdk = await import(pathToFileURL(index).href);
  const { createMcpAdapter } = await import(pathToFileURL(join(source, "dist/index.js")).href);
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const model = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 };
  runtime.registerProvider("fixture", { api: model.api, baseUrl: "http://127.0.0.1:1", apiKey: "synthetic", models: [model] });
  const settingsManager = sdk.SettingsManager.inMemory();
  const adapter = createMcpAdapter({ config: { mcpServers: {}, settings: { sampling: false, elicitation: false } }, outputDirectory });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [adapter] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const manager = sdk.SessionManager.create(root, join(root, "sessions"));
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime, model, sessionManager: manager, noTools: "builtin" });
  await session.bindExtensions({ mode: "print", onError(error) { throw new Error(error.error); } });
  let requests = 0;
  async function run(name, args) {
    let issued = false; const before = session.messages.length;
    session.agent.streamFunction = async () => {
      requests++; const call = !issued; issued = true;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [{ type: "toolCall", id: `page-${before}`, name, arguments: args }] : [{ type: "text", text: "done" }], stopReason: call ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    };
    await session.prompt("Read the generated retained output page.");
    const results = session.messages.slice(before).filter(message => message.role === "toolResult");
    assert.equal(results.length, 1); assert.equal(results[0].isError, false);
    return results[0];
  }
  await run("mcp_search", { enable: ["gateway", "script"] });
  return {
    read: input => run("mcp", { action: "read-result", ...input }),
    async script(input) { const result = await run("mcp_script", { code: `return await tools.readResult(${JSON.stringify(input)});` }); return JSON.parse(result.content[0].text); },
    identity: { sdkVersion: sdk.VERSION, index, indexSha256: await fileHash(index), cli, cliSha256: await fileHash(cli), manifestSha256: await fileHash(manifestPath) },
    async close() {
      const sessionFile = manager.getSessionFile(); assert.ok(sessionFile);
      const persisted = (await readFile(sessionFile, "utf8")).trim().split("\n").map(JSON.parse).filter(entry => entry.message?.role === "toolResult").map(entry => entry.message);
      const visible = session.messages.filter(message => message.role === "toolResult");
      assert.equal(persisted.length, visible.length);
      persisted.forEach((message, i) => { assert.deepEqual(message.content, visible[i].content); assert.deepEqual(message.details, visible[i].details); });
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); runtime.dispose?.();
      return { sessionFile, sha256: await fileHash(sessionFile), persistedToolResults: persisted.length, syntheticStreamRequests: requests, providerRequests: 0 };
    },
  };
}

async function worker(options) {
  const { source, root, consumer, phase, mib } = options;
  await mkdir(root, { recursive: true });
  const outputDirectory = options.outputDirectory ?? join(root, "artifacts"); await mkdir(outputDirectory, { recursive: true });
  const module = await import(pathToFileURL(join(source, "mcp-output-guard.ts")).href);
  let ref = options.ref, writerMs = null;
  if (!ref) {
    const start = performance.now();
    const artifact = await module.saveMcpOutputStream((async function* () { for (let i = 0; i < mib * 16; i++) yield chunk; })(), outputDirectory);
    writerMs = performance.now() - start;
    assert.ok(artifact.path, artifact.error); ref = artifact.path;
  }
  const native = consumer === "native" ? await nativeConsumer(source, root, outputDirectory) : null;
  const read = native?.read ?? (input => module.readMcpResult(input, { outputDirectory }));
  const byteSize = mib * 1024 * 1024; assert.equal((await stat(ref)).size, byteSize);
  let totalCharacters = byteSize, mutation;
  if (phase === "changed") {
    const originalInputSha256 = await fileHash(ref);
    await utimes(ref, 1_234_567_890, 1_234_567_890);
    const warm = await read({ ref, limit: 12_000 }); assert.equal(warm.details.totalCharacters, byteSize);
    const before = await stat(ref, { bigint: true });
    const file = await open(ref, "r+"); try { await file.write(Buffer.from("é"), 0, 2, 0); } finally { await file.close(); }
    await utimes(ref, 1_234_567_890, 1_234_567_890);
    const after = await stat(ref, { bigint: true });
    assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.notEqual(after.ctimeNs, before.ctimeNs);
    const revision = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    mutation = { before: revision(before), after: revision(after), originalInputSha256 };
    totalCharacters--;
  }
  const inputSha256 = await fileHash(ref);
  let indexInput = null;
  try {
    const bytes = await readFile(`${ref}.index.json`);
    const snapshot = join(root, "index-before-read.json"); await writeFile(snapshot, bytes);
    indexInput = { snapshot, sha256: hash(bytes), bytes: bytes.length };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const work = options.work ? observeReads() : null; if (work) await work.handles(ref);
  let profiler;
  if (options.profile) {
    const { Session } = await import("node:inspector/promises"); profiler = new Session(); profiler.connect();
    await profiler.post("Profiler.enable"); await profiler.post("Profiler.setSamplingInterval", { interval: 100 }); await profiler.post("Profiler.start");
  }
  const scenarios = phase === "changed" ? [["changed-first", 0], ["changed-late", byteSize - 15_001]]
    : phase === "reopen" ? [["reopened-arbitrary", Math.floor(byteSize * .7) + 321], ["reopened-late", byteSize - 15_001]]
      : [["first", 0], ["sequential-1", 12_000], ["sequential-2", 24_000], ["arbitrary", Math.floor(byteSize * .7) + 321], ["late", byteSize - 15_001], ["eof", byteSize], ["past-eof", byteSize + 100]];
  const rows = [];
  for (const [scenario, offset] of scenarios) {
    work?.reset();
    const profileStart = options.profile ? Number(process.hrtime.bigint() / 1000n) : null;
    const started = work || options.profile ? null : performance.now();
    const result = await read({ ref, offset, limit: 12_000 });
    const ms = started === null ? null : performance.now() - started;
    const profileEnd = options.profile ? Number(process.hrtime.bigint() / 1000n) : null;
    const counts = work?.result();
    assert.equal(result.details.error, undefined); assert.equal(result.details.offset, offset); assert.equal(result.details.totalCharacters, totalCharacters);
    const size = Math.max(0, Math.min(12_000, totalCharacters - offset));
    let expected = (chunk + chunk).slice((offset + (phase === "changed" && offset ? 1 : 0)) % 65_536, (offset + (phase === "changed" && offset ? 1 : 0)) % 65_536 + size);
    if (phase === "changed" && offset === 0) expected = "é" + (chunk + chunk).slice(2, size + 1);
    assert.equal(result.content[0].text, expected);
    assert.equal(result.details.nextOffset, offset + size < totalCharacters ? offset + size : null);
    const canonical = { content: result.content, details: { ...result.details, ref: "<artifact>" } };
    rows.push({ scenario, offset, ms, returnedCharacters: size, nextOffset: result.details.nextOffset, totalCharacters, outputSha256: hash(JSON.stringify(canonical)), errors: 0, ...(options.profile ? { profileSpanMicroseconds: [profileStart, profileEnd] } : {}), ...counts });
  }
  if (profiler) { const { profile } = await profiler.post("Profiler.stop"); await json(join(root, "reads.cpuprofile"), profile); profiler.disconnect(); }
  // A real worker-backed readResult check accompanies native gateway timings, outside those timings.
  if (native) { const page = await native.script({ ref, offset: 24_000, limit: 12_000 }); assert.equal(page.details.error, undefined); assert.equal(page.details.totalCharacters, totalCharacters); assert.equal(page.content[0].text, (chunk + chunk).slice(24_000 + (phase === "changed" ? 1 : 0), 36_000 + (phase === "changed" ? 1 : 0))); }
  const sessions = native ? await native.close() : null;
  const derivatives = [];
  for (const name of await readdir(dirname(ref))) if (name !== basename(ref)) {
    const path = join(dirname(ref), name), bytes = await readFile(path);
    const snapshot = join(root, `after-${name}`); await writeFile(snapshot, bytes);
    derivatives.push({ name, snapshot, bytes: bytes.length, sha256: hash(bytes), checkpoints: name.endsWith(".index.json") ? JSON.parse(bytes).points.length : null });
  }
  await json(join(root, "measurements.json"), { ...options, node: process.version, platform: process.platform, arch: process.arch, instrumented: !!(work || profiler), ref, outputDirectory, byteSize, totalCharacters, inputSha256, indexInput, mutation, writerMs, sdk: native?.identity, sessions, derivatives, rows });
}

if (values.help || (!values.worker && !values.output)) {
  console.log("Usage: node scripts/benchmark-output-pages.mjs --baseline BASELINE_SOURCE --output EVIDENCE_DIR [--source SOURCE] [--rounds 5] [--sizes 1,16,64] [--consumer helper,native] [--work|--profile]\nBuild both sources first against one coherent selected SDK. Retains generated artifacts, raw measurements and native session JSONL. First-use/reopen is reader-cold with warm OS page cache; profiles/work runs are separate from reportable timings. Exit 0 means every exact page/total/continuation assertion passed.");
} else if (values.worker) {
  await worker(JSON.parse(values.worker));
} else {
  assert.ok(Number.isSafeInteger(Number(values.rounds)) && Number(values.rounds) > 0, "rounds must be positive");
  assert.ok(values.sizes.split(",").every(size => Number.isSafeInteger(Number(size)) && Number(size) > 0), "sizes must be positive MiB integers");
  const output = resolve(values.output); await mkdir(output, { recursive: true });
  assert.deepEqual(await readdir(output), [], "Use a new evidence directory; never overwrite a previous run");
  const sources = [...(values.baseline ? [{ label: "baseline", source: resolve(values.baseline) }] : []), { label: "candidate", source: resolve(values.source) }];
  const identities = [];
  for (const entry of sources) {
    const files = {};
    for (const file of ["mcp-output-guard.ts", "mcp-output-index.ts", "dist/index.js", "dist/mcp-output-guard.js", "dist/mcp-output-index.js", "package.json", "package-lock.json", "node_modules/.package-lock.json"])  try { files[file] = await fileHash(join(entry.source, file)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    let commit = null; try { commit = execFileSync("git", ["-C", entry.source, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    identities.push({ ...entry, commit, files });
  }
  await json(join(output, "inputs.json"), { argv: process.argv, node: process.version, executableSha256: await fileHash(process.execPath), harnessSha256: await fileHash(fileURLToPath(import.meta.url)), identities, note: "Fixed baseline-first serial A/B pairs, not randomized or counterbalanced. No overlapping test/build jobs. Warm kernel cache, no OS-cache eviction or provider request. Only read await is timed; preparation, checks and hashes are outside. Changed phase owns a separate artifact; first/reopen inputs and pre-read index snapshots remain untouched." });
  const reports = [];
  for (const consumer of values.consumer.split(",")) {
    assert.ok(["helper", "native"].includes(consumer));
    for (const mib of values.sizes.split(",").map(Number)) for (let round = 0; round < Number(values.rounds); round++) for (const entry of sources) {
      let previous;
      for (const phase of ["first", "reopen", "changed"]) {
        const root = join(output, `${consumer}-${mib}-${round}-${entry.label}-${phase}`);
        const options = { ...entry, root, consumer, phase, mib, round, work: !!values.work, profile: !!values.profile, ...(previous && phase !== "changed" ? { ref: previous.ref, outputDirectory: previous.outputDirectory } : {}) };
        await mkdir(root, { recursive: true });
        const log = fs.openSync(join(root, "process.log"), "w");
        try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", JSON.stringify(options)], { cwd: entry.source, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" }, stdio: ["ignore", log, log] }); }
        finally { fs.closeSync(log); }
        previous = JSON.parse(await readFile(join(root, "measurements.json"), "utf8")); reports.push(previous);
        console.log(`${consumer} ${mib}MiB round=${round} ${entry.label} ${phase}: ${previous.rows.map(row => `${row.scenario}=${row.ms === null ? "untimed" : row.ms.toFixed(3) + "ms"}`).join(" ")}`);
      }
    }
  }
  if (values.baseline) for (const report of reports.filter(report => report.label === "baseline")) {
    const other = reports.find(candidate => candidate.label === "candidate" && candidate.consumer === report.consumer && candidate.mib === report.mib && candidate.round === report.round && candidate.phase === report.phase);
    assert.equal(other.inputSha256, report.inputSha256);
    assert.deepEqual(other.rows.map(row => row.outputSha256), report.rows.map(row => row.outputSha256));
  }
  await json(join(output, "all-measurements.json"), reports);
  console.log(`Verified ${reports.reduce((n, report) => n + report.rows.length, 0)} exact pages, zero errors. Raw evidence: ${output}`);
}
