// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes
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
import { join, extname, resolve, sep } from "node:path";
import { asObjectRecord } from "./mcp-output-values.ts";
import { parseInvocation, parsePackageSpec } from "./npx-invocation.ts";
import { loadCacheEntry, saveCacheEntry, type NpxCacheEntry } from "./npx-resolution-cache.ts";
import { throwIfAborted } from "./abort.ts";
import crossSpawn from "cross-spawn";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
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

  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolved) {
    saveCacheEntry(cacheKey, resolved);
    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
  }

  // Slow path: force npx cache population
  await forceNpxCache(parsed.packageSpec, signal);
  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolvedAfterInstall) {
    saveCacheEntry(cacheKey, resolvedAfterInstall);
    return {
      binPath: resolvedAfterInstall.resolvedBin,
      extraArgs: parsed.extraArgs,
      isJs: resolvedAfterInstall.isJs,
    };
  }

  return null;
}

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
  const cacheDir = getNpmCacheDir();
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

async function forceNpxCache(packageSpec: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  try {
    await new Promise<void>((complete, reject) => {
      const proc = crossSpawn(
        "npm",
        ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timeout"));
      }, FORCE_CACHE_TIMEOUT_MS);
      const abort = () => {
        proc.kill();
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

let npmCacheDirCached: string | null | undefined;

function getNpmCacheDir(): string | null {
  if (npmCacheDirCached !== undefined) {
    return npmCacheDirCached;
  }
  if (process.env.NPM_CONFIG_CACHE !== undefined && process.env.NPM_CONFIG_CACHE !== "") {
    npmCacheDirCached = process.env.NPM_CONFIG_CACHE;
    return npmCacheDirCached;
  }
  try {
    const result = crossSpawn.sync("npm", ["config", "get", "cache"], { encoding: "utf-8" });
    if (result.status === 0) {
      const path = result.stdout.trim();
      npmCacheDirCached = path !== "" ? path : null;
      return npmCacheDirCached;
    }
  } catch {
    npmCacheDirCached = null;
    return null;
  }
  npmCacheDirCached = null;
  return null;
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
