import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  __resetAuthEncryptionKeyCacheForTests,
  clearAllCredentials,
  formatOAuthCredentialStoreUnavailable,
  getAuthEntry,
  getAuthEntryEncFilePath,
  getAuthEntryFilePath,
  getAuthForUrl,
  getAuthStorageOptions,
  inspectAuthForUrl,
  OAuthCredentialStoreError,
  saveAuthEntry,
} from "../mcp-auth.ts";

const DEK_ACCOUNT = "encryption-key.v1";

function accountFor(serverName: string): string {
  return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

/** Seed a legacy keyring entry (single item, or manifest + chunks) in the fake store. */
function seedLegacyKeyringEntry(storePath: string, serverName: string, entry: unknown, chunkSize = 1800): void {
  const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string> : {};
  const account = accountFor(serverName);
  const payload = JSON.stringify(entry);
  if (payload.length <= chunkSize) {
    store[account] = payload;
  } else {
    const chunkCount = Math.ceil(payload.length / chunkSize);
    const chunkDigest = createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
    for (let index = 0; index < chunkCount; index++) {
      store[`${account}.chunk.${chunkDigest}.${index}`] = payload.slice(index * chunkSize, (index + 1) * chunkSize);
    }
    store[account] = JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount, chunkDigest });
  }
  writeFileSync(storePath, JSON.stringify(store));
}

function createRecoveryHarness(): { harnessDir: string; storePath: string; logPath: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-recovery-"));
  const keyctlPath = join(harnessDir, "keyctl");
  const helperPath = join(harnessDir, "helper.cjs");
  const storePath = join(harnessDir, "store.json");
  const logPath = join(harnessDir, "ops.log");

  writeFileSync(keyctlPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
shift 2
exec "$@"
`, { mode: 0o755 });
  writeFileSync(helperPath, `const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(process.env.PI_MCP_ADAPTER_FAKE_KEYRING_LOG, input.operation + ' ' + input.account + '\\n');
const path = process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE;
const store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
// Atomic write so concurrent helper processes never observe a torn store file.
const persist = () => {
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  require('node:fs').renameSync(tmp, path);
};
if (input.operation === 'read') {
  const value = store[input.account];
  process.stdout.write(JSON.stringify(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value }) + '\\n');
} else if (input.operation === 'write') {
  store[input.account] = input.payload;
  persist();
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} else if (input.operation === 'remove') {
  if (process.env.PI_MCP_ADAPTER_FAKE_KEYRING_DENY_REMOVE === '1') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'denied' }) + '\\n');
    process.exitCode = 1;
  } else {
    delete store[input.account];
    persist();
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
  }
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: 'bad op' }) + '\\n');
  process.exitCode = 1;
}
`);
  writeFileSync(logPath, "");

  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "keyrevoked";
  process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE = process.execPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER = helperPath;
  process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;
  process.env.PI_MCP_ADAPTER_FAKE_KEYRING_LOG = logPath;
  return { harnessDir, storePath, logPath };
}

function readRecoveryStore(storePath: string): Record<string, string> {
  return existsSync(storePath)
    ? JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>
    : {};
}

describe("OAuth credential-store diagnostics", () => {
  it("recognizes a revoked Linux keyring through the error cause chain", () => {
    const nativeError = new Error("Couldn't access platform storage: KeyRevoked", {
      cause: new Error("KeyRevoked"),
    });
    const error = new OAuthCredentialStoreError("read failed", "read", nativeError);

    const message = formatOAuthCredentialStoreUnavailable(error);
    if (process.platform === "linux") {
      expect(message).toContain("Linux session keyring may be revoked");
      expect(message).toContain("fresh login/keyring session");
    } else {
      expect(message).toContain("OAuth credential store unavailable");
    }
  });

  it("explains the macOS keychain prompt when the store is unavailable", () => {
    const error = new OAuthCredentialStoreError("read failed", "read", new Error("simulated"));
    const message = formatOAuthCredentialStoreUnavailable(error);
    if (process.platform === "darwin") {
      expect(message).toContain("macOS is asking for your login keychain password (normally your Mac login password)");
      expect(message).toContain("Always Allow");
    } else {
      expect(message).toContain("OAuth credential store unavailable");
    }
  });
});

describe("mcp-auth storage paths", () => {
  const originalEnv = {
    MCP_OAUTH_DIR: process.env.MCP_OAUTH_DIR,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
    PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY: process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER,
    PI_MCP_ADAPTER_FAKE_KEYRING_STORE: process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE,
    PI_MCP_ADAPTER_FAKE_KEYRING_LOG: process.env.PI_MCP_ADAPTER_FAKE_KEYRING_LOG,
  };
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-storage-"));
    process.env.MCP_OAUTH_DIR = authDir;
    __resetAuthEncryptionKeyCacheForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    __resetAuthEncryptionKeyCacheForTests();
    rmSync(authDir, { recursive: true, force: true });
  });

  it("keeps arbitrary configured server names under safe hashed storage paths", () => {
    const names = ["Cloudflare Workers", "сервер", "../escape", "@scope/name", ""];

    for (const [index, name] of names.entries()) {
      const token = `token-${index}`;
      saveAuthEntry(name, { tokens: { accessToken: token } }, "https://example.com/mcp");

      expect(getAuthEntry(name)?.tokens?.accessToken).toBe(token);
      const filePath = getAuthEntryFilePath(name);
      const rel = relative(authDir, filePath);
      expect(rel.startsWith("..")).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel).toMatch(/^sha256-[a-f0-9]{64}\/tokens\.json$/);
      expect(existsSync(filePath)).toBe(false);

      const encPath = getAuthEntryEncFilePath(name);
      const encRel = relative(authDir, encPath);
      expect(encRel.startsWith("..")).toBe(false);
      expect(isAbsolute(encRel)).toBe(false);
      expect(encRel).toMatch(/^sha256-[a-f0-9]{64}\.enc$/);
      expect(existsSync(encPath)).toBe(true);
    }

    expect(existsSync(join(authDir, "..", "escape", "tokens.json"))).toBe(false);
  });

  it("rejects non-string names at the storage boundary", () => {
    expect(() => getAuthEntryFilePath(undefined as unknown as string)).toThrow(/Invalid MCP server name/);
    expect(() => getAuthEntryEncFilePath(undefined as unknown as string)).toThrow(/Invalid MCP server name/);
  });

  it("stores entries as AES-256-GCM encrypted files, never plaintext", () => {
    saveAuthEntry("encrypted", { tokens: { accessToken: "super-secret-token" } }, "https://example.com/mcp");

    const encPath = getAuthEntryEncFilePath("encrypted");
    expect(existsSync(encPath)).toBe(true);
    expect(existsSync(getAuthEntryFilePath("encrypted"))).toBe(false);

    const raw = readFileSync(encPath, "utf8");
    expect(raw).not.toContain("super-secret-token");
    const envelope = JSON.parse(raw) as { v?: number; iv?: string; tag?: string; data?: string };
    expect(envelope.v).toBe(1);
    expect(Buffer.from(envelope.iv!, "base64")).toHaveLength(12);
    expect(Buffer.from(envelope.tag!, "base64")).toHaveLength(16);
    expect(envelope.data).toBeTruthy();

    // Owner-only permissions (umask can only restrict further).
    expect(statSync(encPath).mode & 0o077).toBe(0);

    expect(getAuthEntry("encrypted")?.tokens?.accessToken).toBe("super-secret-token");
  });

  it("keeps the serverUrl binding through encrypted storage", () => {
    saveAuthEntry("url-bound", { tokens: { accessToken: "token" } }, "https://api.example.com/mcp");

    expect(getAuthForUrl("url-bound", "https://different.example.com/mcp")).toBeUndefined();
    expect(getAuthForUrl("url-bound", "https://api.example.com/mcp")?.tokens?.accessToken).toBe("token");

    // URL change invalidates even after re-reading the encrypted file.
    __resetAuthEncryptionKeyCacheForTests();
    expect(getAuthForUrl("url-bound", "https://api.example.com/mcp/v2")).toBeUndefined();
  });

  it("treats corrupt encrypted files as unauthenticated without crashing", () => {
    saveAuthEntry("corrupt-file", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    const encPath = getAuthEntryEncFilePath("corrupt-file");

    writeFileSync(encPath, "not json at all");
    expect(getAuthEntry("corrupt-file")).toBeUndefined();
    expect(inspectAuthForUrl("corrupt-file", "https://example.com/mcp").status).toBe("absent");

    // Valid envelope, tampered ciphertext: GCM verification must reject it.
    saveAuthEntry("corrupt-file", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    const envelope = JSON.parse(readFileSync(encPath, "utf8")) as { data: string, tag: string };
    // Deterministic toggle (a fixed replacement is a no-op 1/64 of the time).
    envelope.data = `${envelope.data.startsWith("A") ? "B" : "A"}${envelope.data.slice(1)}`;
    writeFileSync(encPath, JSON.stringify(envelope));
    expect(getAuthEntry("corrupt-file")).toBeUndefined();

    // Truncated GCM tag: Node accepts 4-byte tags unless authTagLength is set.
    saveAuthEntry("corrupt-file", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    const truncated = JSON.parse(readFileSync(encPath, "utf8")) as { tag: string };
    truncated.tag = Buffer.from(truncated.tag, "base64").subarray(0, 4).toString("base64");
    writeFileSync(encPath, JSON.stringify(truncated));
    expect(getAuthEntry("corrupt-file")).toBeUndefined();
  });

  it("never reuses a pre-placed staging file at the predictable temp name", () => {
    // The pre-fix staging path was <file>.<pid>.tmp opened without O_EXCL:
    // a planted world-writable file kept its 0666 mode into the final .enc.
    const encPath = getAuthEntryEncFilePath("staging-mode");
    const predictableTmp = `${encPath}.${process.pid}.tmp`;
    writeFileSync(predictableTmp, "planted", { mode: 0o666 });
    chmodSync(predictableTmp, 0o666);

    saveAuthEntry("staging-mode", { tokens: { accessToken: "token" } });

    expect(statSync(encPath).mode & 0o077).toBe(0);
    expect(getAuthEntry("staging-mode")?.tokens?.accessToken).toBe("token");
    // The planted file is untouched: staging uses an unpredictable O_EXCL name.
    expect(readFileSync(predictableTmp, "utf8")).toBe("planted");
    rmSync(predictableTmp, { force: true });
  });

  it("never follows a pre-placed staging symlink at the predictable temp name", () => {
    const encPath = getAuthEntryEncFilePath("staging-link");
    const victim = join(authDir, "staging-victim.txt");
    writeFileSync(victim, "do not touch");
    const predictableTmp = `${encPath}.${process.pid}.tmp`;
    symlinkSync(victim, predictableTmp);

    saveAuthEntry("staging-link", { tokens: { accessToken: "token" } });

    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(lstatSync(predictableTmp).isSymbolicLink()).toBe(true);
    expect(getAuthEntry("staging-link")?.tokens?.accessToken).toBe("token");
    rmSync(predictableTmp, { force: true });
  });

  it("never follows or reuses a pre-placed symlink at the credential path", () => {
    const encPath = getAuthEntryEncFilePath("symlink-target");
    const victim = join(authDir, "victim.txt");
    writeFileSync(victim, "do not touch");
    symlinkSync(victim, encPath);

    saveAuthEntry("symlink-target", { tokens: { accessToken: "token" } }, "https://example.com/mcp");

    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(lstatSync(encPath).isSymbolicLink()).toBe(false);
    expect(getAuthEntry("symlink-target")?.tokens?.accessToken).toBe("token");
  });

  it("enforces owner-only permissions even when overwriting a world-writable file", () => {
    const encPath = getAuthEntryEncFilePath("loose-file");
    mkdirSync(dirname(encPath), { recursive: true });
    writeFileSync(encPath, "old", { mode: 0o666 });
    chmodSync(encPath, 0o666);

    saveAuthEntry("loose-file", { tokens: { accessToken: "token" } });

    expect(statSync(encPath).mode & 0o077).toBe(0);
    expect(getAuthEntry("loose-file")?.tokens?.accessToken).toBe("token");
  });

  it("never fails status inspection when legacy plaintext cleanup fails", () => {
    saveAuthEntry("sticky-legacy", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    const legacyPath = getAuthEntryFilePath("sticky-legacy");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ tokens: { accessToken: "legacy" } }));
    // Make the legacy file undeletable; cleanup must degrade to a later retry,
    // not throw a raw error through inspectAuthForUrl.
    chmodSync(dirname(legacyPath), 0o555);
    try {
      expect(inspectAuthForUrl("sticky-legacy", "https://example.com/mcp").status).toBe("present");
      expect(getAuthEntry("sticky-legacy")?.tokens?.accessToken).toBe("token");
      // Proves the cleanup genuinely failed (not a no-op on this runner).
      expect(existsSync(legacyPath)).toBe(true);
    } finally {
      chmodSync(dirname(legacyPath), 0o755);
    }
  });

  it("fails closed when the OS credential store is unavailable, even with an encrypted file present", () => {
    saveAuthEntry("store-down", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    expect(existsSync(getAuthEntryEncFilePath("store-down"))).toBe(true);

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try {
      expect(() => getAuthEntry("store-down")).toThrow(OAuthCredentialStoreError);
      expect(() => getAuthEntry("store-down")).toThrow(/OS secure credential store/);
      const status = inspectAuthForUrl("store-down", "https://example.com/mcp");
      expect(status.status).toBe("unavailable");
      if (process.platform === "darwin") {
        expect(() => getAuthEntry("store-down")).toThrow(/Always Allow/);
        if (status.status === "unavailable") expect(status.message).toContain("Always Allow");
      }
    } finally {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    }
  });

  it("uses configured oauthDir as the legacy import source and encrypted-file target", () => {
    delete process.env.MCP_OAUTH_DIR;
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);
    const filePath = getAuthEntryFilePath("configured", options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ tokens: { accessToken: "legacy-token" }, serverUrl: "https://example.com/mcp" }), "utf-8");

    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    // The migrated entry now lives as an encrypted file in the configured dir.
    const encPath = getAuthEntryEncFilePath("configured", options);
    expect(encPath.startsWith(join(project, ".pi", "oauth"))).toBe(true);
    expect(existsSync(encPath)).toBe(true);
    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    rmSync(project, { recursive: true, force: true });
  });

  it("fails closed on write: an unavailable store means no file is ever written", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try {
      expect(() => saveAuthEntry("write-fail-closed", { tokens: { accessToken: "token" } }, "https://example.com/mcp"))
        .toThrow(OAuthCredentialStoreError);
      expect(existsSync(getAuthEntryEncFilePath("write-fail-closed"))).toBe(false);
      // No plaintext or torn tmp files either.
      expect(readdirSync(authDir).filter(name => name.includes("write-fail-closed") || name.endsWith(".tmp"))).toEqual([]);
    } finally {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    }
  });

  it("deletes the encrypted file even when the keyring is unavailable during logout", () => {
    saveAuthEntry("logout-store-down", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    const encPath = getAuthEntryEncFilePath("logout-store-down");
    expect(existsSync(encPath)).toBe(true);

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try {
      // Legacy keyring cleanup still fails loudly (leftover items could be
      // re-imported), but the canonical credential file is already gone.
      expect(() => clearAllCredentials("logout-store-down")).toThrow(OAuthCredentialStoreError);
      expect(existsSync(encPath)).toBe(false);
    } finally {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    }
  });

  it("migrates legacy credentials during status-only inspection so prompts cannot repeat", () => {
    const filePath = getAuthEntryFilePath("status-only");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      tokens: { accessToken: "legacy-token" },
      serverUrl: "https://example.com/mcp",
    }), "utf-8");

    expect(inspectAuthForUrl("status-only", "https://example.com/mcp").status).toBe("present");
    // Status inspection migrates like any other read: re-reading legacy
    // keychain items on every panel refresh would re-trigger the prompt storm.
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(getAuthEntryEncFilePath("status-only"))).toBe(true);

    expect(getAuthEntry("status-only")?.tokens?.accessToken).toBe("legacy-token");
  });

  it("scopes encrypted credentials to the configured oauthDir", () => {
    delete process.env.MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-b-"));
    const optionsA = getAuthStorageOptions(".pi/oauth", projectA);
    const optionsB = getAuthStorageOptions(".pi/oauth", projectB);

    saveAuthEntry("same-server", { tokens: { accessToken: "token-a" } }, "https://example.com/mcp", optionsA);
    saveAuthEntry("same-server", { tokens: { accessToken: "token-b" } }, "https://example.com/mcp", optionsB);

    expect(getAuthEntry("same-server", optionsA)?.tokens?.accessToken).toBe("token-a");
    expect(getAuthEntry("same-server", optionsB)?.tokens?.accessToken).toBe("token-b");
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("keeps MCP_OAUTH_DIR as the explicit override over settings.oauthDir", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);

    saveAuthEntry("env-override", { tokens: { accessToken: "token" } }, "https://example.com/mcp", options);

    const filePath = getAuthEntryEncFilePath("env-override", options);
    expect(filePath.startsWith(authDir)).toBe(true);
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("round-trips large entries as a single encrypted file", () => {
    const accessToken = "x".repeat(5000);
    saveAuthEntry("large-entry", { tokens: { accessToken } }, "https://example.com/mcp");
    expect(getAuthEntry("large-entry")?.tokens?.accessToken).toBe(accessToken);
    expect(readFileSync(getAuthEntryEncFilePath("large-entry"), "utf8")).not.toContain(accessToken);
  });

  describe("Linux keyring recovery helper", () => {
    let harnessDir: string;
    let storePath: string;
    let logPath: string;

    beforeEach(() => {
      ({ harnessDir, storePath, logPath } = createRecoveryHarness());
    });

    afterEach(() => {
      rmSync(harnessDir, { recursive: true, force: true });
    });

    it("routes revoked keyring operations through the helper and stores only the encryption key there", () => {
      saveAuthEntry("recovered", { tokens: { accessToken: "token" } });
      expect(getAuthEntry("recovered")?.tokens?.accessToken).toBe("token");

      // Exactly one keyring item total: the shared encryption key. No
      // per-server items, no chunks — that is what ends the prompt storm.
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);

      clearAllCredentials("recovered");
      expect(getAuthEntry("recovered")).toBeUndefined();
      // The DEK stays; it is shared by all servers of this install.
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
    });

    it("stores large entries without keyring chunking", () => {
      const accessToken = "x".repeat(5000);
      saveAuthEntry("large", { tokens: { accessToken } });
      expect(getAuthEntry("large")?.tokens?.accessToken).toBe(accessToken);

      const store = readRecoveryStore(storePath);
      expect(Object.keys(store)).toEqual([DEK_ACCOUNT]);
      expect(Buffer.from(store[DEK_ACCOUNT], "base64")).toHaveLength(32);
    });

    it("migrates chunked legacy keyring entries to an encrypted file and never re-reads them", () => {
      const entry = {
        tokens: { accessToken: "chunked-token", refreshToken: "r".repeat(3000) },
        clientInfo: { clientId: "chunked-client" },
        serverUrl: "https://example.com/mcp",
      };
      seedLegacyKeyringEntry(storePath, "migrated", entry);
      expect(Object.keys(readRecoveryStore(storePath)).length).toBeGreaterThan(1);

      expect(getAuthEntry("migrated")).toEqual(entry);

      // Legacy manifest and chunks were deleted; only the DEK remains.
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
      expect(existsSync(getAuthEntryEncFilePath("migrated"))).toBe(true);
      expect(existsSync(getAuthEntryFilePath("migrated"))).toBe(false);

      // Second read comes from the encrypted file with the cached key: no
      // further keyring access at all, so prompts cannot loop.
      const opsBefore = readFileSync(logPath, "utf8");
      expect(getAuthEntry("migrated")).toEqual(entry);
      expect(readFileSync(logPath, "utf8")).toBe(opsBefore);
    });

    it("migrates single-item legacy keyring entries", () => {
      seedLegacyKeyringEntry(storePath, "small-legacy", { tokens: { accessToken: "small-token" }, serverUrl: "https://example.com/mcp" });

      expect(getAuthEntry("small-legacy")?.tokens?.accessToken).toBe("small-token");
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
      expect(getAuthEntry("small-legacy")?.tokens?.accessToken).toBe("small-token");
    });

    it("migrates legacy keyring entries during status inspection, then never touches the keyring again", () => {
      seedLegacyKeyringEntry(storePath, "panel-server", { tokens: { accessToken: "panel-token" }, serverUrl: "https://example.com/mcp" });

      expect(inspectAuthForUrl("panel-server", "https://example.com/mcp").status).toBe("present");
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
      expect(existsSync(getAuthEntryEncFilePath("panel-server"))).toBe(true);

      const opsBefore = readFileSync(logPath, "utf8");
      expect(inspectAuthForUrl("panel-server", "https://example.com/mcp").status).toBe("present");
      expect(inspectAuthForUrl("panel-server", "https://example.com/mcp").status).toBe("present");
      expect(readFileSync(logPath, "utf8")).toBe(opsBefore);
    });

    it("wraps recovery helper failures as credential-store errors instead of leaking raw errors", () => {
      saveAuthEntry("helper-down", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
      expect(existsSync(getAuthEntryEncFilePath("helper-down"))).toBe(true);

      // The store still reports KeyRevoked, but the helper can no longer run.
      writeFileSync(join(harnessDir, "keyctl"), "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 });
      __resetAuthEncryptionKeyCacheForTests();

      expect(() => getAuthEntry("helper-down")).toThrow(OAuthCredentialStoreError);
      expect(() => getAuthEntry("helper-down")).toThrow(/OS secure credential store/);
      expect(inspectAuthForUrl("helper-down", "https://example.com/mcp").status).toBe("unavailable");
    });

    it("treats partial or corrupt legacy chunk sets as unauthenticated without crashing", () => {
      seedLegacyKeyringEntry(storePath, "torn", { tokens: { accessToken: "t".repeat(3000) } });
      const store = readRecoveryStore(storePath);
      const chunkAccount = Object.keys(store).find(account => account.includes(".chunk."));
      expect(chunkAccount).toBeDefined();
      delete store[chunkAccount!];
      writeFileSync(storePath, JSON.stringify(store));

      expect(getAuthEntry("torn")).toBeUndefined();
      expect(inspectAuthForUrl("torn", "https://example.com/mcp").status).toBe("absent");

      // Corrupt legacy entries are retired: deleted from the keyring, so
      // status refreshes can never prompt for them again. Later reads may still
      // probe the (absent) main account — probing an absent item never prompts.
      expect(readRecoveryStore(storePath)).toEqual({});
      writeFileSync(logPath, "");
      expect(getAuthEntry("torn")).toBeUndefined();
      expect(inspectAuthForUrl("torn", "https://example.com/mcp").status).toBe("absent");
      const tornOps = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      expect(tornOps.length).toBeGreaterThan(0);
      expect(tornOps.every(op => op === `read ${accountFor("torn")}`)).toBe(true);

      // Unparseable main item: also unauthenticated, retired, never a crash.
      writeFileSync(storePath, JSON.stringify({ [accountFor("garbage")]: "}{not json" }));
      expect(getAuthEntry("garbage")).toBeUndefined();
      expect(readRecoveryStore(storePath)).toEqual({});
      writeFileSync(logPath, "");
      expect(getAuthEntry("garbage")).toBeUndefined();
      expect(readFileSync(logPath, "utf8")).toBe(`read ${accountFor("garbage")}\n`);
    });

    it("retires legacy values that parse but are not credential objects", () => {
      for (const bogus of ["null", "false", "0", "\"\"", "[]"]) {
        writeFileSync(storePath, JSON.stringify({ [accountFor("bogus")]: bogus }));
        expect(getAuthEntry("bogus"), `payload ${bogus}`).toBeUndefined();
        expect(readRecoveryStore(storePath)).toEqual({});
      }
    });

    it("skips a corrupt entry whose deletion is denied without hiding later valid writes", () => {
      // Removal denied: the corrupt item stays, but must not be re-read (and on
      // macOS re-prompted) on every status inspection.
      process.env.PI_MCP_ADAPTER_FAKE_KEYRING_DENY_REMOVE = "1";
      try {
        writeFileSync(storePath, JSON.stringify({ [accountFor("denied")]: "}{corrupt" }));
        expect(getAuthEntry("denied")).toBeUndefined();
        expect(readRecoveryStore(storePath)).toEqual({ [accountFor("denied")]: "}{corrupt" });

        writeFileSync(logPath, "");
        expect(getAuthEntry("denied")).toBeUndefined();
        expect(inspectAuthForUrl("denied", "https://example.com/mcp").status).toBe("absent");
        expect(readFileSync(logPath, "utf8")).toBe("");
      } finally {
        delete process.env.PI_MCP_ADAPTER_FAKE_KEYRING_DENY_REMOVE;
      }
    });

    it("sees a legacy entry written later by a concurrently running pre-v5 process", () => {
      // Absence is not cached: a mixed-version writer must not be hidden.
      expect(getAuthEntry("late-legacy")).toBeUndefined();
      seedLegacyKeyringEntry(storePath, "late-legacy", { tokens: { accessToken: "late-token" }, serverUrl: "https://example.com/mcp" });
      expect(getAuthEntry("late-legacy")?.tokens?.accessToken).toBe("late-token");
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
    });

    it("retires pathological chunk manifests without crashing", () => {
      writeFileSync(storePath, JSON.stringify({
        [accountFor("pathological")]: JSON.stringify({
          __piMcpAdapterOAuthChunked: 1,
          chunkCount: 4294967296,
          chunkDigest: "0123456789abcdef",
        }),
      }));

      expect(getAuthEntry("pathological")).toBeUndefined();
      expect(readRecoveryStore(storePath)).toEqual({});
    });

    it("verifies the chunk digest and retires tampered legacy entries", () => {
      seedLegacyKeyringEntry(storePath, "tampered-legacy", { tokens: { accessToken: "t".repeat(1000) } }, 200);
      const store = readRecoveryStore(storePath);
      // Modify chunk contents without touching the manifest while keeping the
      // assembled payload valid JSON: only digest verification catches this.
      const chunkAccounts = Object.keys(store).filter(account => account.includes(".chunk.")).sort();
      expect(chunkAccounts.length).toBeGreaterThan(1);
      const lastChunk = chunkAccounts[chunkAccounts.length - 1]!;
      const tokenIndex = store[lastChunk].lastIndexOf("t");
      expect(tokenIndex).toBeGreaterThanOrEqual(0);
      store[lastChunk] = `${store[lastChunk].slice(0, tokenIndex)}u${store[lastChunk].slice(tokenIndex + 1)}`;
      writeFileSync(storePath, JSON.stringify(store));

      expect(getAuthEntry("tampered-legacy")).toBeUndefined();
      expect(readRecoveryStore(storePath)).toEqual({});
    });

    it("treats encrypted files as unauthenticated when the key is gone or changed", () => {
      saveAuthEntry("key-issues", { tokens: { accessToken: "token" } }, "https://example.com/mcp");

      // Key rotated away (e.g. old keychain item lost): cannot decrypt.
      const store = readRecoveryStore(storePath);
      store[DEK_ACCOUNT] = randomBytes(32).toString("base64");
      writeFileSync(storePath, JSON.stringify(store));
      __resetAuthEncryptionKeyCacheForTests();
      expect(getAuthEntry("key-issues")).toBeUndefined();
      expect(inspectAuthForUrl("key-issues", "https://example.com/mcp").status).toBe("absent");

      // Key deleted entirely: still no plaintext fallback, just re-authenticate.
      writeFileSync(storePath, JSON.stringify({}));
      __resetAuthEncryptionKeyCacheForTests();
      expect(getAuthEntry("key-issues")).toBeUndefined();
    });

    it("overwrites large entries without leaving keyring chunks behind", () => {
      saveAuthEntry("shrinking", { tokens: { accessToken: "x".repeat(5000) } });
      saveAuthEntry("shrinking", { tokens: { accessToken: "small" } });

      expect(getAuthEntry("shrinking")?.tokens?.accessToken).toBe("small");
      expect(Object.keys(readRecoveryStore(storePath))).toEqual([DEK_ACCOUNT]);
    });

    it("removes legacy chunked keyring entries when credentials are cleared", () => {
      seedLegacyKeyringEntry(storePath, "removing", { tokens: { accessToken: "x".repeat(5000) } });
      expect(Object.keys(readRecoveryStore(storePath)).some(account => account.includes(".chunk."))).toBe(true);

      clearAllCredentials("removing");

      // No DEK was ever created for a pure removal, and no legacy items remain.
      expect(readRecoveryStore(storePath)).toEqual({});
      expect(existsSync(getAuthEntryEncFilePath("removing"))).toBe(false);
    });
  });

  it("serializes first-time encryption-key creation across processes", { timeout: 90_000 }, async () => {
    // Regression: two fresh processes that both observe "no key" must not each
    // write their own DEK and orphan one side's encrypted files. The fake
    // keyring below choreographs the exact losing interleaving: both processes
    // observe an absent key, then the first writes and reads back its own key
    // before the second's write lands.
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-dek-race-"));
    const keyctlPath = join(harnessDir, "keyctl");
    const helperPath = join(harnessDir, "helper.cjs");
    const childPath = join(harnessDir, "child.mts");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

    writeFileSync(keyctlPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
shift 2
exec "$@"
`, { mode: 0o755 });
    writeFileSync(helperPath, String.raw`
const { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const root = process.env.RACE_ROOT;
const req = JSON.parse(readFileSync(0, 'utf8'));
const storePath = join(root, 'store.json');
const leaderPath = join(root, 'leader');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const readStore = () => existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
if (req.operation === 'read' && req.account === 'encryption-key.v1' && !existsSync(leaderPath)) {
  writeFileSync(join(root, 'initial-' + process.ppid), '');
  while (readdirSync(root).filter(name => name.startsWith('initial-')).length < 2) sleep(5);
  out({ ok: true, found: false });
} else if (req.operation === 'write' && req.account === 'encryption-key.v1') {
  let leader = false;
  try { closeSync(openSync(leaderPath, 'wx')); leader = true; } catch {}
  if (!leader) while (!existsSync(join(root, 'leader-read-done'))) sleep(5);
  writeFileSync(storePath, JSON.stringify({ [req.account]: req.payload }));
  out({ ok: true });
} else if (req.operation === 'read') {
  const store = readStore();
  const value = store[req.account];
  if (req.account === 'encryption-key.v1' && existsSync(leaderPath) && !existsSync(join(root, 'leader-read-done'))) {
    writeFileSync(join(root, 'leader-read-done'), '');
  }
  out(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value });
} else {
  out({ ok: true });
}
`);
    // Deliberately DIFFERENT oauth dirs per process: the DEK is global, so the
    // lock must be global too — per-dir locks let this exact race through.
    writeFileSync(childPath, `
process.env.MCP_OAUTH_DIR = ${JSON.stringify(authDir)} + '/' + process.argv[2];
const auth = await import(${JSON.stringify(join(repoRoot, "mcp-auth.ts"))});
const server = process.argv[2];
if (process.argv[3] === 'save') {
  auth.saveAuthEntry(server, { tokens: { accessToken: 'token-' + server } }, 'https://example.com');
} else {
  console.log(server, auth.getAuthEntry(server)?.tokens?.accessToken ?? 'UNREADABLE');
}
`);

    const env = {
      ...process.env,
      PI_MCP_ADAPTER_TEST_AUTH_STORE: "keyrevoked",
      PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY: "1",
      PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL: keyctlPath,
      PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE: process.execPath,
      PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER: helperPath,
      RACE_ROOT: harnessDir,
    };
    const run = (server: string, operation: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", childPath, server, operation], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${server} exited ${code}: ${stderr}`)));
    });

    try {
      await Promise.all([run("alpha", "save"), run("beta", "save")]);
      const results = await Promise.all([run("alpha", "read"), run("beta", "read")]);
      expect(results.sort()).toEqual(["alpha token-alpha", "beta token-beta"]);
      // Exactly one DEK exists despite the competing first-writers.
      expect(Object.keys(readRecoveryStore(join(harnessDir, "store.json")))).toEqual([DEK_ACCOUNT]);
    } finally {
      rmSync(harnessDir, { recursive: true, force: true });
    }
  });

  it("never steals the encryption-key lock from a live holder", { timeout: 60_000 }, async () => {
    // A holder slow for any reason (e.g. waiting on the OS) must not lose the
    // lock; the pre-fix code stole it after 2s and split the DEK.
    const recoveryHarness = createRecoveryHarness();
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-dek-hold-"));
    const holderPath = join(harnessDir, "holder.mjs");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    writeFileSync(holderPath, `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const lockPath = join(tmpdir(), \`pi-mcp-adapter-\${uid}.dek.lock\`);
const token = \`\${process.pid}.holder\`;
mkdirSync(lockPath);
writeFileSync(join(lockPath, "owner"), token);
console.log("holding");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
let survived = false;
try { survived = readFileSync(join(lockPath, "owner"), "utf8") === token; } catch {}
console.log(survived ? "survived" : "stolen");
rmSync(lockPath, { recursive: true, force: true });
`);

    const holder = spawn(process.execPath, [holderPath], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let holderOut = "";
    holder.stdout.on("data", chunk => { holderOut += chunk; });
    holder.stderr.on("data", chunk => { holderOut += chunk; });
    await new Promise<void>(resolve => {
      const poll = () => (holderOut.includes("holding") ? resolve() : setTimeout(poll, 25));
      poll();
    });

    try {
      // Runs while the live holder still holds the lock.
      saveAuthEntry("waited", { tokens: { accessToken: "token" } });
      expect(getAuthEntry("waited")?.tokens?.accessToken).toBe("token");
      await new Promise<void>(resolve => holder.on("close", () => resolve()));
      expect(holderOut).toContain("survived");
    } finally {
      holder.kill();
      rmSync(harnessDir, { recursive: true, force: true });
      rmSync(recoveryHarness.harnessDir, { recursive: true, force: true });
    }
  });

  it("does not use the recovery helper for generic secure-store failures", () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-no-recovery-"));
    const keyctlPath = join(harnessDir, "keyctl");
    const storePath = join(harnessDir, "store.json");
    writeFileSync(keyctlPath, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 });

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
    process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;

    expect(() => getAuthEntry("generic-unavailable")).toThrow(/OS secure credential store/);
    expect(existsSync(storePath)).toBe(false);
    rmSync(harnessDir, { recursive: true, force: true });
  });
});
