import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { withStorageLock } from "../storage-lock.ts";
import { getMetadataCachePath, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { loadCacheEntry, saveCacheEntry } from "../npx-resolution-cache.ts";

let root: string;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "storage-lock-"));
  process.env.PI_CODING_AGENT_DIR = root;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
  rmSync(root, { recursive: true, force: true });
});

function startWorker(kind: string, argument = "") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/storage-lock-worker.ts", import.meta.url)), kind, argument],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => {
    stderr += data;
  });
  const exited = once(child, "exit");
  const ready = Promise.race([
    once(child.stdout, "data").then(([data]) => {
      expect(String(data)).toBe("locked\n");
      return true;
    }),
    exited.then(() => {
      throw new Error(`Storage worker exited before acquiring its lock: ${stderr}`);
    }),
  ]);
  return { child, ready, exited, stderr: () => stderr };
}

describe("synchronous storage locking", () => {
  it("does not load SQLite when the cache modules are imported", () => {
    const imported = spawnSync(
      process.execPath,
      [
        "--no-experimental-sqlite",
        fileURLToPath(new URL("./fixtures/storage-lock-worker.ts", import.meta.url)),
        "import",
      ],
      { encoding: "utf8", env: process.env },
    );
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe("imported\n");
  });

  it("rejects a competing process before running the operation and releases after SIGKILL", async () => {
    const path = join(root, "lock.sqlite");
    const worker = startWorker("lock", path);
    try {
      await worker.ready;
      let ran = false;
      expect(() =>
        withStorageLock(path, () => {
          ran = true;
        }),
      ).toThrow(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }));
      expect(ran).toBe(false);
      expect(worker.child.kill("SIGKILL")).toBe(true);
      await worker.exited;
      expect(withStorageLock(path, () => "reacquired")).toBe("reacquired");
      expect(statSync(path).isFile()).toBe(true);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  });

  it.skipIf(process.platform === "win32")("creates a private persistent sidecar", () => {
    const path = join(root, "private", "lock.sqlite");
    withStorageLock(path, () => 42);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
  });

  it("preserves the operation failure and releases after it throws", () => {
    const path = join(root, "lock.sqlite");
    const primary = new Error("operation failed");
    expect(() =>
      withStorageLock(path, () => {
        throw primary;
      }),
    ).toThrow(primary);
    expect(withStorageLock(path, () => 42)).toBe(42);
  });

  it("retains the operation and rollback failures while still closing and releasing the database", () => {
    const path = join(root, "lock.sqlite");
    const primary = new Error("operation failed");
    const rollback = new Error("rollback failed");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(() =>
      withStorageLock(path, () => {
        exec.mockImplementation(() => {
          throw rollback;
        });
        throw primary;
      }),
    ).toThrow(
      expect.objectContaining({
        errors: [primary, rollback],
        cause: primary,
      }),
    );
    exec.mockRestore();
    expect(withStorageLock(path, () => "closed")).toBe("closed");
  });
});

const cacheEntry = () => ({
  configHash: "storage-lock",
  cachedAt: Date.now(),
  tools: [{ name: "search" }],
  resources: [],
});

describe("cache read/merge/write exclusion", () => {
  it("rejects a metadata merge during another process's read/write window and retains both later writes", async () => {
    saveMetadataCache({ version: 2, servers: { initial: cacheEntry() } });
    const worker = startWorker(
      "metadata",
      JSON.stringify({ version: 2, servers: { external: cacheEntry() } }),
    );
    try {
      await worker.ready;
      const before = readFileSync(getMetadataCachePath(), "utf8");
      expect(() => saveMetadataCache({ version: 2, servers: { competing: cacheEntry() } })).toThrow(
        expect.objectContaining({ errcode: 5 }),
      );
      expect(readFileSync(getMetadataCachePath(), "utf8")).toBe(before);
      expect(Object.keys(loadMetadataCache()?.servers ?? {})).toEqual(["initial"]);
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      saveMetadataCache({ version: 2, servers: { competing: cacheEntry() } });
      expect(Object.keys(loadMetadataCache()?.servers ?? {}).sort()).toEqual([
        "competing",
        "external",
        "initial",
      ]);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  });

  it("rejects an npx merge during another process's read/write window and retains both later writes", async () => {
    const initial = { resolvedBin: "initial.js", resolvedAt: Date.now(), isJs: true };
    const competing = { ...initial, resolvedBin: "competing.js" };
    saveCacheEntry("initial", initial);
    const worker = startWorker("npx");
    try {
      await worker.ready;
      expect(() => saveCacheEntry("competing", competing)).toThrow(
        expect.objectContaining({ errcode: 5 }),
      );
      expect(loadCacheEntry("initial")).toEqual(initial);
      expect(loadCacheEntry("competing")).toBeUndefined();
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      saveCacheEntry("competing", competing);
      expect(loadCacheEntry("initial")).toEqual(initial);
      expect(loadCacheEntry("external")?.resolvedBin).toBe("external.js");
      expect(loadCacheEntry("competing")).toEqual(competing);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  });
});
