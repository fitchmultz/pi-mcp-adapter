// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join, extname, resolve, sep } from "node:path";
import { asObjectRecord } from "./mcp-output-values.ts";
import { classifyNpxCommand, parseInvocation, parsePackageSpec } from "./npx-invocation.ts";
import { loadCacheEntry, saveCacheEntry, type NpxCacheEntry } from "./npx-resolution-cache.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import crossSpawn from "cross-spawn";
import { logger } from "./logger.ts";
import { terminateChildProcess } from "./utils.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Match the prior synchronous 10s npm config cap so slow/broken npm setups fall back without stalling startup.
const NPM_CONFIG_TIMEOUT_MS = 10_000;
interface PackageManifest {
  bin: string | Record<string, string>;
  version?: string;
}

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

export async function resolveNpxBinary(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<NpxResolution | null> {
  throwIfAborted(signal);
  const parsed = parseInvocation(command, args);

  if (!parsed) {
    return null;
  }

  const packageSpec = parsePackageSpec(parsed.packageSpec);
  if (!packageSpec) {
    return null;
  }
  const cacheKey = JSON.stringify([command, ...args]);
  const cached = loadCacheEntry(cacheKey);

  if (
    cached &&
    Date.now() - cached.resolvedAt < CACHE_TTL_MS &&
    existsSync(cached.resolvedBin) &&
    (packageSpec.exactVersion === undefined || cached.packageVersion === packageSpec.exactVersion)
  ) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
  }

  const npmCommand = resolveNpmExecutable(command);
  let resolved = await resolveFromNpmCache(parsed.packageSpec, npmCommand, parsed.binName, signal);
  if (!resolved) {
    // Slow path: force npx cache population.
    await forceNpxCache(parsed.packageSpec, npmCommand, signal);
    resolved = await resolveFromNpmCache(parsed.packageSpec, npmCommand, parsed.binName, signal);
  }
  if (!resolved) {
    return null;
  }
  saveResolvedBinary(cacheKey, resolved);
  return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
}

function resolveNpmExecutable(command: string): string {
  if (!command.includes("/") && !command.includes("\\")) {
    return "npm";
  }
  if (classifyNpxCommand(command) === "npm" && existsSync(command)) {
    return command;
  }
  const siblingName = process.platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(dirname(command), siblingName);
  return existsSync(sibling) ? sibling : "npm";
}

function saveResolvedBinary(cacheKey: string, resolved: NpxCacheEntry): void {
  if (saveCacheEntry(cacheKey, resolved) === "busy") {
    logger.warn(
      "MCP: npx cache not saved because another process holds its lock; using the resolved binary",
    );
  }
}

async function resolveFromNpmCache(
  packageSpec: string,
  npmCommand: string,
  binName?: string,
  signal?: AbortSignal,
): Promise<NpxCacheEntry | null> {
  const cacheDir = await getNpmCacheDir(npmCommand, signal);
  if (cacheDir === null) {
    return null;
  }

  const parsedSpec = parsePackageSpec(packageSpec);
  if (!parsedSpec) {
    return null;
  }

  const { packageName, exactVersion } = parsedSpec;
  const packageDir = findCachedPackageDir(cacheDir, packageName, exactVersion);
  if (packageDir === null) {
    return null;
  }

  const pkg = readPackage(packageDir);
  if (!pkg) {
    return null;
  }
  const bin = chooseBin(pkg.bin, packageName, binName);
  if (!bin || bin.relativePath === "") {
    return null;
  }
  const resolvedBin = resolveBinPath(packageDir, bin);
  if (resolvedBin === null) {
    return null;
  }
  const isJs = detectJsBinary(resolvedBin);
  return {
    resolvedBin,
    resolvedAt: Date.now(),
    ...(pkg.version !== undefined ? { packageVersion: pkg.version } : {}),
    isJs,
  };
}

const FORCE_CACHE_TIMEOUT_MS = 30_000;

function readPackage(packageDir: string): PackageManifest | null {
  const path = join(packageDir, "package.json");
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const pkg = asObjectRecord(raw);
    if (!pkg || (pkg.version !== undefined && typeof pkg.version !== "string")) {
      return null;
    }
    const bin = readBinField(pkg.bin);
    return bin === null
      ? null
      : { bin, ...(pkg.version !== undefined ? { version: pkg.version } : {}) };
  } catch {
    return null;
  }
}

function readBinField(value: unknown): string | Record<string, string> | null {
  if (typeof value === "string") {
    return value;
  }
  const record = asObjectRecord(value);
  if (!record || Array.isArray(value)) {
    return null;
  }
  const bin: Array<[string, string]> = [];
  for (const [name, path] of Object.entries(record)) {
    if (typeof path !== "string") {
      return null;
    }
    bin.push([name, path]);
  }
  return Object.fromEntries(bin);
}

interface BinChoice {
  name: string;
  relativePath: string;
}
function chooseBin(
  bin: string | Record<string, string>,
  packageName: string,
  explicitBin?: string,
): BinChoice | null {
  if (typeof bin === "string") {
    return { name: defaultBinName(packageName), relativePath: bin };
  }
  for (const candidate of buildBinCandidates(packageName, explicitBin)) {
    const path = bin[candidate];
    if (path !== undefined && path !== "") {
      return { name: candidate, relativePath: path };
    }
  }
  const first = Object.entries(bin)[0];
  return first ? { name: first[0], relativePath: first[1] } : null;
}

function resolveBinPath(packageDir: string, bin: BinChoice): string | null {
  const binLink = bin.name !== "" ? join(findNodeModulesDir(packageDir), ".bin", bin.name) : null;
  const linked = binLink !== null && existsSync(binLink) ? safeRealpath(binLink) : "";
  if (linked !== "") {
    return linked;
  }
  const path = resolve(packageDir, bin.relativePath);
  return existsSync(path) ? path : null;
}

async function forceNpxCache(
  packageSpec: string,
  npmCommand: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  try {
    await new Promise<void>((complete, reject) => {
      const proc = crossSpawn(
        npmCommand,
        ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        terminateChildProcess(proc);
        reject(new Error("timeout"));
      }, FORCE_CACHE_TIMEOUT_MS);
      const abort = () => {
        terminateChildProcess(proc);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("MCP request aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer.unref();
      proc.on("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        complete();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(err);
      });
    });
  } catch {
    if (signal?.aborted === true) {
      throwIfAborted(signal);
    }
    // Ignore failures, resolution will fall back to original command
  }
  throwIfAborted(signal);
}

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
  const candidates: string[] = [];
  if (explicitBin !== undefined && explicitBin !== "") {
    candidates.push(explicitBin);
  }

  if (packageName.startsWith("@")) {
    const namePart = packageName.split("/")[1] ?? "";
    const scopePart = packageName.split("/")[0]?.replace("@", "") ?? "";
    if (namePart !== "") {
      candidates.push(namePart);
    }
    if (scopePart !== "" && namePart !== "") {
      candidates.push(`${scopePart}-${namePart}`);
    }
  } else {
    candidates.push(packageName);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/");
    return parts[1] ?? packageName.replace("@", "").replace("/", "-");
  }
  return packageName;
}

function findCachedPackageDir(
  cacheDir: string,
  packageName: string,
  exactVersion?: string,
): string | null {
  const npxDir = join(cacheDir, "_npx");
  if (!existsSync(npxDir)) {
    return null;
  }

  const packagePathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName];

  const candidates = readdirSync(npxDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = join(npxDir, entry.name);
      const mtime = safeStatMtime(full);
      return { name: entry.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of candidates) {
    const pkgDir = join(npxDir, entry.name, "node_modules", ...packagePathParts);
    const packageJsonPath = join(pkgDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    if (
      exactVersion !== undefined &&
      exactVersion !== "" &&
      !matchesPackageVersion(packageJsonPath, exactVersion)
    ) {
      continue;
    }
    return pkgDir;
  }

  return null;
}

function matchesPackageVersion(path: string, exactVersion: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return asObjectRecord(raw)?.version === exactVersion;
  } catch {
    return false;
  }
}

function findNodeModulesDir(packageDir: string): string {
  const parts = packageDir.split(sep);
  const idx = parts.lastIndexOf("node_modules");
  if (idx >= 0) {
    return parts.slice(0, idx + 1).join(sep);
  }
  return join(packageDir, "..");
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return true;
  }
  try {
    const fd = openSync(binPath, "r");
    try {
      const buf = Buffer.alloc(256);
      readSync(fd, buf, 0, 256, 0);
      const firstLine = buf.toString("utf-8").split("\n")[0] ?? "";
      return firstLine.startsWith("#!") && firstLine.includes("node");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const npmCacheDirCache = new Map<string, string | null>();
const npmCacheDirInFlight = new Map<string, Promise<string | null>>();

function readNpmCacheDir(npmCommand: string): Promise<string | null> {
  return new Promise<string | null>((complete) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      complete(value);
    };
    let proc: ChildProcess;
    try {
      proc = crossSpawn(npmCommand, ["config", "get", "cache"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      terminateChildProcess(proc);
      finish(null);
    }, NPM_CONFIG_TIMEOUT_MS);
    timer.unref();
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.on("close", (code) => {
      const path = code === 0 ? stdout.trim() : "";
      finish(path !== "" ? path : null);
    });
    proc.on("error", () => {
      finish(null);
    });
  });
}

async function getNpmCacheDir(npmCommand: string, signal?: AbortSignal): Promise<string | null> {
  throwIfAborted(signal);
  if (process.env.NPM_CONFIG_CACHE !== undefined && process.env.NPM_CONFIG_CACHE !== "") {
    return process.env.NPM_CONFIG_CACHE;
  }
  const cached = npmCacheDirCache.get(npmCommand);
  if (cached !== undefined) {
    return cached;
  }
  let inFlight = npmCacheDirInFlight.get(npmCommand);
  if (!inFlight) {
    inFlight = readNpmCacheDir(npmCommand)
      .then((value) => {
        // Do not permanently negative-cache transient npm config failures or timeouts.
        if (value !== null) {
          npmCacheDirCache.set(npmCommand, value);
        }
        return value;
      })
      .finally(() => {
        npmCacheDirInFlight.delete(npmCommand);
      });
    npmCacheDirInFlight.set(npmCommand, inFlight);
  }
  return abortable(inFlight, signal);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
