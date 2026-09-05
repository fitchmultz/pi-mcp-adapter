import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  clearAllCredentials,
  formatOAuthCredentialStoreUnavailable,
  getAuthEntry,
  getAuthEntryFilePath,
  getAuthStorageOptions,
  inspectAuthForUrl,
  OAuthCredentialStoreError,
  saveAuthEntry,
} from "../mcp-auth.ts";

function createRecoveryHarness(): { harnessDir: string; storePath: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-recovery-"));
  const keyctlPath = join(harnessDir, "keyctl");
  const helperPath = join(harnessDir, "helper.cjs");
  const storePath = join(harnessDir, "store.json");

  writeFileSync(keyctlPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
shift 2
exec "$@"
`, { mode: 0o755 });
  writeFileSync(helperPath, `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
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

  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "keyrevoked";
  process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE = process.execPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER = helperPath;
  process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;
  return { harnessDir, storePath };
}

function readRecoveryStore(storePath: string): Record<string, string> {
  return JSON.parse(readFileSync(storePath, "utf8")) as Record<string, string>;
}

describe("OAuth credential-store diagnostics", () => {
  // Real adapter + published loader, simulated platform only; never an OS keychain.
  it.each(["missing", "unloadable", "working"])("diagnoses Android binding: %s", (mode) => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-android-loader-"));
    try {
      writeFileSync(join(home, "package.json"), '{"type":"module"}');
      for (const file of ["mcp-auth.ts", "agent-dir.ts", "config.ts", "types.ts", "ui-stream-types.ts", "utils.ts"]) {
        cpSync(resolve(file), join(home, file));
      }
      const modules = join(home, "node_modules");
      cpSync(resolve("node_modules/@napi-rs/keyring"), join(modules, "@napi-rs/keyring"), { recursive: true });
      for (const dependency of ["smol-toml", "strip-json-comments", "zod"]) {
        symlinkSync(resolve("node_modules", dependency), join(modules, dependency), "dir");
      }
      if (mode !== "missing") {
        const binding = join(modules, "@napi-rs/keyring-android-arm64");
        mkdirSync(binding);
        writeFileSync(join(binding, "package.json"), '{"version":"1.3.0","main":"index.cjs"}');
        writeFileSync(join(binding, "index.cjs"), mode === "unloadable"
          ? 'throw new Error("synthetic binding cannot load");'
          : `const entries = new Map();
module.exports = {
  failure: undefined,
  Entry: class Entry {
    constructor(service, account) { this.account = service + account; }
    getPassword() { if (module.exports.failure) throw module.exports.failure; return entries.get(this.account) ?? null; }
    setPassword(value) { if (module.exports.failure) throw module.exports.failure; entries.set(this.account, value); }
    deleteCredential() { if (module.exports.failure) throw module.exports.failure; return entries.delete(this.account); }
  },
};`);
      }
      const result = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), resolve("__tests__/fixtures/android-keyring-probe.mjs"), mode], {
        cwd: home,
        env: { HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PATH: dirname(process.execPath), TMPDIR: home },
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const receipt = JSON.parse(result.stdout);
      expect(receipt).toMatchObject({ platform: "android", arch: "arm64", execPath: process.execPath, version: process.version, mode, passed: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

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
  };
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-storage-"));
    process.env.MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(authDir, { recursive: true, force: true });
  });

  it("keeps arbitrary configured server names under safe hashed legacy import paths", () => {
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
    }

    expect(existsSync(join(authDir, "..", "escape", "tokens.json"))).toBe(false);
  });

  it("rejects non-string names at the storage boundary", () => {
    expect(() => getAuthEntryFilePath(undefined as unknown as string)).toThrow(/Invalid MCP server name/);
  });

  it("uses configured oauthDir as the legacy import source", () => {
    delete process.env.MCP_OAUTH_DIR;
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);
    const filePath = getAuthEntryFilePath("configured", options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ tokens: { accessToken: "legacy-token" }, serverUrl: "https://example.com/mcp" }), "utf-8");

    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
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

  it("does not use configured oauthDir values as secure-store namespaces", () => {
    delete process.env.MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-b-"));
    const optionsA = getAuthStorageOptions(".pi/oauth", projectA);
    const optionsB = getAuthStorageOptions(".pi/oauth", projectB);

    saveAuthEntry("same-server", { tokens: { accessToken: "token-a" } }, "https://example.com/mcp", optionsA);
    saveAuthEntry("same-server", { tokens: { accessToken: "token-b" } }, "https://example.com/mcp", optionsB);

    expect(getAuthEntry("same-server", optionsA)?.tokens?.accessToken).toBe("token-b");
    expect(getAuthEntry("same-server", optionsB)?.tokens?.accessToken).toBe("token-b");
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("keeps MCP_OAUTH_DIR as the explicit override over settings.oauthDir", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);

    saveAuthEntry("env-override", { tokens: { accessToken: "token" } }, "https://example.com/mcp", options);

    const filePath = getAuthEntryFilePath("env-override", options);
    expect(filePath.startsWith(authDir)).toBe(true);
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("round-trips large secure-store entries", () => {
    const accessToken = "x".repeat(5000);
    saveAuthEntry("large-entry", { tokens: { accessToken } }, "https://example.com/mcp");
    expect(getAuthEntry("large-entry")?.tokens?.accessToken).toBe(accessToken);
  });

  describe("Linux keyring recovery helper", () => {
    let harnessDir: string;
    let storePath: string;

    beforeEach(() => {
      ({ harnessDir, storePath } = createRecoveryHarness());
    });

    afterEach(() => {
      rmSync(harnessDir, { recursive: true, force: true });
    });

    it("routes revoked keyring operations through the helper", () => {
      saveAuthEntry("recovered", { tokens: { accessToken: "token" } });
      expect(getAuthEntry("recovered")?.tokens?.accessToken).toBe("token");
      clearAllCredentials("recovered");
      expect(readRecoveryStore(storePath)).toEqual({});
    });

    it("chunks large entries within the secure-store payload limit", () => {
      const accessToken = "x".repeat(5000);
      saveAuthEntry("large", { tokens: { accessToken } });
      expect(getAuthEntry("large")?.tokens?.accessToken).toBe(accessToken);

      const store = readRecoveryStore(storePath);
      const chunkEntries = Object.entries(store).filter(([account]) => account.includes(".chunk."));
      const manifestPayload = Object.entries(store).find(([account]) => !account.includes(".chunk."))?.[1];
      expect(manifestPayload).toBeDefined();
      const manifest = JSON.parse(manifestPayload!) as { __piMcpAdapterOAuthChunked?: number; chunkCount?: number };
      expect(manifest.__piMcpAdapterOAuthChunked).toBe(1);
      expect(chunkEntries).toHaveLength(manifest.chunkCount);
      expect(chunkEntries.every(([, payload]) => payload.length <= 1800)).toBe(true);
    });

    it("reports unavailable status when a chunk is missing", () => {
      const serverUrl = "https://example.com/mcp";
      saveAuthEntry("corrupt", { tokens: { accessToken: "x".repeat(5000) } }, serverUrl);
      const store = readRecoveryStore(storePath);
      const missingChunk = Object.keys(store).find((account) => account.includes(".chunk."));
      expect(missingChunk).toBeDefined();
      delete store[missingChunk!];
      writeFileSync(storePath, JSON.stringify(store));
      expect(inspectAuthForUrl("corrupt", serverUrl).status).toBe("unavailable");
    });

    it("cleans stale chunks when a large entry is replaced", () => {
      saveAuthEntry("shrinking", { tokens: { accessToken: "x".repeat(5000) } });
      saveAuthEntry("shrinking", { tokens: { accessToken: "small" } });

      expect(getAuthEntry("shrinking")?.tokens?.accessToken).toBe("small");
      const accounts = Object.keys(readRecoveryStore(storePath));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).not.toContain(".chunk.");
    });

    it("removes chunk payloads when credentials are cleared", () => {
      saveAuthEntry("removing", { tokens: { accessToken: "x".repeat(5000) } });
      expect(Object.keys(readRecoveryStore(storePath)).some((account) => account.includes(".chunk."))).toBe(true);
      clearAllCredentials("removing");
      expect(readRecoveryStore(storePath)).toEqual({});
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
