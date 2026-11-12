import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { StorageLockBusyError, withStorageLock } from "../storage-lock.ts";
import { getMetadataCachePath, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { loadCacheEntry, saveCacheEntry } from "../npx-resolution-cache.ts";
import {
  MetadataCacheUpdates,
  flushMetadataCache,
  getMetadataCacheUpdates,
} from "../init-metadata.ts";
import { connectStartupServers } from "../init-startup.ts";
import { createTestState } from "./test-state.ts";
import { createTestExtensionContext } from "./test-extension-context.ts";
import { resolveNpxBinary } from "../npx-resolver.ts";
import { logger } from "../logger.ts";

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

function startWorker(kind: string, argument = "", mode: "read" | "write" = "write") {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/storage-lock-worker.ts", import.meta.url)),
      kind,
      argument,
      mode,
    ],
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
  it("shares reads on a zero-byte database while excluding writers until release", async () => {
    const path = join(root, "read-lock.sqlite");
    const reader = startWorker("lock", path, "read");
    try {
      await reader.ready;
      expect(statSync(path).size).toBe(0);
      expect(withStorageLock(path, () => "shared", "read")).toBe("shared");
      expect(() => withStorageLock(path, () => "write")).toThrow(StorageLockBusyError);
      reader.child.stdin.end("x");
      expect(await reader.exited, reader.stderr()).toEqual([0, null]);
      expect(withStorageLock(path, () => "exclusive")).toBe("exclusive");
    } finally {
      reader.child.kill("SIGKILL");
      await reader.exited;
    }
  });

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
      let failure: unknown;
      try {
        withStorageLock(path, () => {
          ran = true;
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StorageLockBusyError);
      expect(failure).toMatchObject({ cause: { code: "ERR_SQLITE_ERROR", errcode: 5 } });
      expect(() => withStorageLock(path, () => "read", "read")).toThrow(StorageLockBusyError);
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
    const competing = new DatabaseSync(path);
    try {
      expect(() => withStorageLock(path, () => competing.exec("BEGIN IMMEDIATE"))).toThrow(
        expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }),
      );
    } finally {
      competing.close();
    }
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
  it("returns a resolved npx binary while its optional cache is busy", async () => {
    const packageDir = join(root, "npm", "_npx", "fixture", "node_modules", "lock-demo");
    const binPath = join(packageDir, "cli.js");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "lock-demo", version: "1.0.0", bin: "cli.js" }),
    );
    writeFileSync(binPath, "#!/usr/bin/env node\n");
    vi.stubEnv("NPM_CONFIG_CACHE", join(root, "npm"));
    const warning = vi.spyOn(logger, "warn");
    const worker = startWorker(
      "lock",
      join(root, "fitch-mcp-adapter", "mcp-npx-cache.json.lock.sqlite"),
    );
    try {
      await worker.ready;
      await expect(resolveNpxBinary("npx", ["-y", "lock-demo"])).resolves.toEqual({
        binPath,
        extraArgs: [],
        isJs: true,
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("npx cache not saved"));
      expect(loadCacheEntry(JSON.stringify(["npx", "-y", "lock-demo"]))).toBeUndefined();
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      await expect(resolveNpxBinary("npx", ["-y", "lock-demo"])).resolves.toMatchObject({
        binPath,
      });
      expect(loadCacheEntry(JSON.stringify(["npx", "-y", "lock-demo"]))?.resolvedBin).toBe(binPath);
      const cachePath = join(root, "fitch-mcp-adapter", "mcp-npx-cache.json");
      rmSync(cachePath);
      mkdirSync(`${cachePath}.${process.pid}.tmp`);
      await expect(resolveNpxBinary("npx", ["-y", "lock-demo"])).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
      vi.unstubAllEnvs();
    }
  });

  it("surfaces nonbusy write failures without clearing the pending metadata batch", async () => {
    const state = createTestState({ metadataCacheEnabled: true });
    const pending = new MetadataCacheUpdates();
    const record = cacheEntry();
    pending.entries.set("pending", record);
    const tempPath = `${getMetadataCachePath()}.${process.pid}.tmp`;
    mkdirSync(tempPath, { recursive: true });
    try {
      expect(() => pending.save(state)).toThrow(expect.objectContaining({ code: "EISDIR" }));
      expect(pending.entries.get("pending")).toEqual(record);
      expect(loadMetadataCache()).toBeNull();
      rmSync(tempPath, { recursive: true });
      pending.save(state);
      expect(pending.entries.size).toBe(0);
      expect(loadMetadataCache()?.servers.pending).toEqual(record);
    } finally {
      await state.owner.stop("test complete");
      await state.manager.closeAll();
    }
  });

  it("retains pending metadata when busy and saves it at the next save boundary", async () => {
    const state = createTestState({ metadataCacheEnabled: true });
    const pending = new MetadataCacheUpdates();
    const record = cacheEntry();
    pending.entries.set("pending", record);
    const warning = vi.spyOn(logger, "warn");
    const worker = startWorker("lock", `${getMetadataCachePath()}.lock.sqlite`);
    try {
      await worker.ready;
      pending.save(state);
      expect(pending.entries.get("pending")).toEqual(record);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("metadata cache not saved"));
      expect(loadMetadataCache()).toBeNull();
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      pending.save(state);
      expect(pending.entries.size).toBe(0);
      expect(loadMetadataCache()?.servers.pending).toEqual(record);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
      await state.owner.stop("test complete");
      await state.manager.closeAll();
    }
  });

  it("reports startup failures and accepts remaining results while metadata saving is busy", async () => {
    const host = await createTestExtensionContext();
    const fixture = fileURLToPath(
      new URL("./fixtures/lazy-startup-mcp-server.mjs", import.meta.url),
    );
    const definition = (name: string) => ({
      command: process.execPath,
      args: [fixture],
      env: {
        MCP_STARTUP_FIXTURE_EVENTS: join(root, "events.jsonl"),
        MCP_STARTUP_FIXTURE_NAME: name,
      },
    });
    const state = createTestState({
      metadataCacheEnabled: true,
      ui: host.context.ui,
      config: {
        mcpServers: {
          first: definition("first"),
          broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
          last: definition("last"),
        },
      },
    });
    const notify = vi.spyOn(host.context.ui, "notify");
    const worker = startWorker("lock", `${getMetadataCachePath()}.lock.sqlite`);
    try {
      await worker.ready;
      const connected = await connectStartupServers(
        state,
        Object.entries(state.config.mcpServers),
        { initial: undefined, runtime: undefined },
      );
      expect([...connected]).toEqual(["first", "last"]);
      expect(state.failureMessages.get("broken")).toBeDefined();
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect to broken"),
        "error",
      );
      expect(state.toolMetadata.has("last")).toBe(true);
      const pending = getMetadataCacheUpdates(state);
      expect([...pending.entries.keys()]).toEqual(["first", "last"]);
      await state.manager.close("first");
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      flushMetadataCache(state);
      expect(pending.entries.size).toBe(0);
      expect(Object.keys(loadMetadataCache()?.servers ?? {}).sort()).toEqual(["first", "last"]);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
      await state.owner.stop("test complete");
      await state.manager.closeAll();
      await host.dispose();
    }
  });

  it("rejects a metadata merge during another process's read/write window and retains both later writes", async () => {
    saveMetadataCache({ version: 2, servers: { initial: cacheEntry() } });
    const worker = startWorker(
      "metadata",
      JSON.stringify({ version: 2, servers: { external: cacheEntry() } }),
    );
    try {
      await worker.ready;
      const before = readFileSync(getMetadataCachePath(), "utf8");
      expect(saveMetadataCache({ version: 2, servers: { competing: cacheEntry() } })).toBe("busy");
      expect(readFileSync(getMetadataCachePath(), "utf8")).toBe(before);
      expect(Object.keys(loadMetadataCache()?.servers ?? {})).toEqual(["initial"]);
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      expect(saveMetadataCache({ version: 2, servers: { competing: cacheEntry() } })).toBe("saved");
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
      expect(saveCacheEntry("competing", competing)).toBe("busy");
      expect(loadCacheEntry("initial")).toEqual(initial);
      expect(loadCacheEntry("competing")).toBeUndefined();
      worker.child.stdin.end("x");
      expect(await worker.exited, worker.stderr()).toEqual([0, null]);
      expect(saveCacheEntry("competing", competing)).toBe("saved");
      expect(loadCacheEntry("initial")).toEqual(initial);
      expect(loadCacheEntry("external")?.resolvedBin).toBe("external.js");
      expect(loadCacheEntry("competing")).toEqual(competing);
    } finally {
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  });
});
