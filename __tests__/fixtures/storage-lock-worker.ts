import { readSync, writeSync } from "node:fs";
import { withStorageLock } from "../../storage-lock.ts";
import { projectMetadataCache } from "../../metadata-cache-format.ts";
import { saveMetadataCache } from "../../metadata-cache.ts";
import { saveCacheEntry } from "../../npx-resolution-cache.ts";

function pause(): void {
  writeSync(1, "locked\n");
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) {
    throw new Error("Expected the parent to release the storage worker");
  }
}

const kind = process.argv[2];
if (kind === "import") {
  writeSync(1, "imported\n");
} else if (kind === "lock") {
  const path = process.argv[3];
  if (path === undefined) {
    throw new Error("Expected a lock path");
  }
  const mode = process.argv[4] ?? "write";
  if (mode !== "read" && mode !== "write") {
    throw new Error(`Invalid storage lock mode: ${mode}`);
  }
  withStorageLock(path, pause, mode);
} else if (kind === "metadata") {
  const input: unknown = JSON.parse(process.argv[3] ?? "");
  const cache = projectMetadataCache(input);
  if (cache === null) {
    throw new Error("Expected a metadata cache envelope");
  }
  const servers = cache.servers;
  let paused = false;
  Object.defineProperty(cache, "servers", {
    get() {
      // saveMetadataCache has read the on-disk envelope before accessing incoming servers.
      if (!paused) {
        paused = true;
        pause();
      }
      return servers;
    },
  });
  saveMetadataCache(cache);
} else if (kind === "npx") {
  saveCacheEntry("external", {
    get resolvedBin() {
      // Serialization occurs after the existing entries have been read and merged.
      pause();
      return "external.js";
    },
    resolvedAt: Date.now(),
    isJs: true,
  });
} else {
  throw new Error(`Unknown storage worker kind: ${kind ?? "missing"}`);
}
