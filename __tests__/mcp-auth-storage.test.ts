import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
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
if (input.operation === 'read') {
  const value = store[input.account];
  process.stdout.write(JSON.stringify(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value }) + '\\n');
} else if (input.operation === 'write') {
  store[input.account] = input.payload;
  writeFileSync(path, JSON.stringify(store));
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} else if (input.operation === 'remove') {
  delete store[input.account];
  writeFileSync(path, JSON.stringify(store));
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
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
    const envelope = JSON.parse(readFileSync(encPath, "utf8")) as { data: string };
    envelope.data = `A${envelope.data.slice(1)}`;
    writeFileSync(encPath, JSON.stringify(envelope));
    expect(getAuthEntry("corrupt-file")).toBeUndefined();
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

  it("does not migrate legacy credentials during status-only inspection", () => {
    const filePath = getAuthEntryFilePath("status-only");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      tokens: { accessToken: "legacy-token" },
      serverUrl: "https://example.com/mcp",
    }), "utf-8");

    expect(inspectAuthForUrl("status-only", "https://example.com/mcp").status).toBe("present");
    expect(existsSync(filePath)).toBe(true);

    expect(getAuthEntry("status-only")?.tokens?.accessToken).toBe("legacy-token");
    expect(existsSync(filePath)).toBe(false);
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

    it("treats partial or corrupt legacy chunk sets as unauthenticated without crashing", () => {
      seedLegacyKeyringEntry(storePath, "torn", { tokens: { accessToken: "t".repeat(3000) } });
      const store = readRecoveryStore(storePath);
      const chunkAccount = Object.keys(store).find(account => account.includes(".chunk."));
      expect(chunkAccount).toBeDefined();
      delete store[chunkAccount!];
      writeFileSync(storePath, JSON.stringify(store));

      expect(getAuthEntry("torn")).toBeUndefined();
      expect(inspectAuthForUrl("torn", "https://example.com/mcp").status).toBe("absent");

      // Unparseable main item: also unauthenticated, never a crash.
      writeFileSync(storePath, JSON.stringify({ [accountFor("garbage")]: "}{not json" }));
      expect(getAuthEntry("garbage")).toBeUndefined();
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
