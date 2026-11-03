import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  clearAllCredentials,
  formatOAuthCredentialStoreUnavailable,
  getAuthEntry,
  getAuthEntryFilePath,
  getAuthStorageOptions,
  inspectAuthForUrl,
  OAuthCredentialStoreError,
  saveAuthEntry,
} from "../../mcp-auth.ts";

function createRecoveryHarness(): { harnessDir: string; storePath: string } {
  const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-recovery-"));
  const keyctlPath = join(harnessDir, "keyctl");
  const helperPath = join(harnessDir, "helper.cjs");
  const storePath = join(harnessDir, "store.json");

  writeFileSync(
    keyctlPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
shift 2
exec "$@"
`,
    { mode: 0o755 },
  );
  copyFileSync(new URL("../fixtures/file-keyring.cjs", import.meta.url), helperPath);

  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "keyrevoked";
  process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE = process.execPath;
  process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER = helperPath;
  process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;
  return { harnessDir, storePath };
}

function readRecoveryStore(storePath: string): Record<string, string> {
  return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(storePath, "utf8")));
}

describe("OAuth credential-store diagnostics", () => {
  // Real adapter + published loader, simulated platform only; never an OS keychain.
  it.each(["missing", "unloadable", "working"])("diagnoses Android binding: %s", (mode) => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-android-loader-"));
    try {
      writeFileSync(join(home, "package.json"), '{"type":"module"}');
      for (const file of [
        "mcp-auth.ts",
        "auth-record-types.ts",
        "credential-payloads.ts",
        "credential-store-errors.ts",
        "keyring-store.ts",
        "keyring-recovery.ts",
        "agent-dir.ts",
        "config.ts",
        "config-contracts.ts",
        "config-diff.ts",
        "config-disabled.ts",
        "config-file.ts",
        "config-imports.ts",
        "config-merge.ts",
        "config-opencode.ts",
        "config-paths.ts",
        "config-protocol.ts",
        "config-types.ts",
        "config-validation.ts",
        "config-writes.ts",
        "types.ts",
        "ui-stream-types.ts",
        "utils.ts",
      ]) {
        cpSync(resolve(file), join(home, file));
      }
      const modules = join(home, "node_modules");
      cpSync(resolve("node_modules/@napi-rs/keyring"), join(modules, "@napi-rs/keyring"), {
        recursive: true,
      });
      for (const dependency of ["smol-toml", "strip-json-comments", "zod"]) {
        symlinkSync(resolve("node_modules", dependency), join(modules, dependency), "dir");
      }
      if (mode !== "missing") {
        const binding = join(modules, "@napi-rs/keyring-android-arm64");
        mkdirSync(binding);
        writeFileSync(join(binding, "package.json"), '{"version":"2.1.0","main":"index.cjs"}');
        if (mode === "unloadable") {
          writeFileSync(
            join(binding, "index.cjs"),
            'throw new Error("synthetic binding cannot load");',
          );
        } else {
          copyFileSync(
            new URL("../fixtures/android-keyring-test-binding.cjs", import.meta.url),
            join(binding, "index.cjs"),
          );
        }
      }
      const result = spawnSync(
        process.execPath,
        [resolve("__tests__/fixtures/android-keyring-probe.mjs"), mode],
        {
          cwd: home,
          env: {
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
            PATH: dirname(process.execPath),
            TMPDIR: home,
          },
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const receipt: unknown = JSON.parse(result.stdout);
      expect(receipt).toMatchObject({
        platform: "android",
        arch: "arm64",
        execPath: process.execPath,
        version: process.version,
        mode,
        passed: true,
      });
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
    const expected =
      process.platform === "linux"
        ? ["Linux session keyring may be revoked", "fresh login/keyring session"]
        : ["OAuth credential store unavailable"];
    for (const text of expected) {
      expect(message).toContain(text);
    }
  });
});

describe("mcp-auth storage paths", () => {
  const originalEnv = {
    FITCH_MCP_OAUTH_DIR: process.env.FITCH_MCP_OAUTH_DIR,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
    PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY:
      process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER,
    PI_MCP_ADAPTER_FAKE_KEYRING_STORE: process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE,
  };
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-storage-"));
    process.env.FITCH_MCP_OAUTH_DIR = authDir;
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

  it.each([undefined, null, 42])("rejects non-string name %s at the storage boundary", (name) => {
    expect(() => getAuthEntryFilePath(name)).toThrow(/Invalid MCP server name/);
  });

  it("namespaces the configured oauthDir legacy import source", () => {
    delete process.env.FITCH_MCP_OAUTH_DIR;
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);
    const filePath = getAuthEntryFilePath("configured", options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        tokens: { accessToken: "legacy-token" },
        serverUrl: "https://example.com/mcp",
      }),
      "utf-8",
    );

    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    expect(filePath.startsWith(join(project, ".pi", "oauth", "fitch-mcp-adapter"))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    rmSync(project, { recursive: true, force: true });
  });

  it("does not migrate legacy credentials during status-only inspection", () => {
    const filePath = getAuthEntryFilePath("status-only");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        tokens: { accessToken: "legacy-token" },
        serverUrl: "https://example.com/mcp",
      }),
      "utf-8",
    );

    expect(inspectAuthForUrl("status-only", "https://example.com/mcp").status).toBe("present");
    expect(existsSync(filePath)).toBe(true);

    expect(getAuthEntry("status-only")?.tokens?.accessToken).toBe("legacy-token");
    expect(existsSync(filePath)).toBe(false);
  });

  it.each([
    { name: "tokens", payload: { tokens: { accessToken: 17 } } },
    { name: "client", payload: { clientInfo: { clientId: 17 } } },
    { name: "record", payload: [] },
  ])("keeps malformed legacy $name data out of secure storage", ({ name, payload }) => {
    const serverName = `invalid-${name}`;
    const filePath = getAuthEntryFilePath(serverName);
    const bytes = JSON.stringify(payload);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);

    expect(() => getAuthEntry(serverName)).toThrow(/Invalid OAuth credential record/);
    expect(readFileSync(filePath, "utf8")).toBe(bytes);
    rmSync(filePath);
    expect(getAuthEntry(serverName)).toBeUndefined();
  });

  it("preserves future JSON fields across legacy import and secure reads", () => {
    const entry = {
      tokens: { accessToken: "legacy-token", futureTokenMetadata: { version: 1 } },
      serverUrl: "https://example.com/mcp",
      futureEntryMetadata: { origin: "legacy" },
    };
    const filePath = getAuthEntryFilePath("future-fields");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(entry));

    expect(getAuthEntry("future-fields")).toEqual(entry);
    expect(existsSync(filePath)).toBe(false);
    expect(getAuthEntry("future-fields")).toEqual(entry);
  });

  it("does not use configured oauthDir values as secure-store namespaces", () => {
    delete process.env.FITCH_MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-b-"));
    const optionsA = getAuthStorageOptions(".pi/oauth", projectA);
    const optionsB = getAuthStorageOptions(".pi/oauth", projectB);

    saveAuthEntry(
      "same-server",
      { tokens: { accessToken: "token-a" } },
      "https://example.com/mcp",
      optionsA,
    );
    saveAuthEntry(
      "same-server",
      { tokens: { accessToken: "token-b" } },
      "https://example.com/mcp",
      optionsB,
    );

    expect(getAuthEntry("same-server", optionsA)?.tokens?.accessToken).toBe("token-b");
    expect(getAuthEntry("same-server", optionsB)?.tokens?.accessToken).toBe("token-b");
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("keeps FITCH_MCP_OAUTH_DIR as the explicit override over settings.oauthDir", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);

    saveAuthEntry(
      "env-override",
      { tokens: { accessToken: "token" } },
      "https://example.com/mcp",
      options,
    );

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
      const manifestPayload = Object.entries(store).find(
        ([account]) => !account.includes(".chunk."),
      )?.[1];
      expect(manifestPayload).toBeDefined();
      const manifest = z
        .object({ __piMcpAdapterOAuthChunked: z.number(), chunkCount: z.number() })
        .parse(JSON.parse(z.string().parse(manifestPayload)));
      expect(manifest.__piMcpAdapterOAuthChunked).toBe(1);
      expect(chunkEntries).toHaveLength(manifest.chunkCount);
      expect(chunkEntries.every(([, payload]) => payload.length <= 1800)).toBe(true);
    });

    it("reports unavailable status when a chunk is missing", () => {
      const serverUrl = "https://example.com/mcp";
      saveAuthEntry("corrupt", { tokens: { accessToken: "x".repeat(5000) } }, serverUrl);
      const store = readRecoveryStore(storePath);
      const missingChunk = z
        .string()
        .parse(Object.keys(store).find((account) => account.includes(".chunk.")));
      delete store[missingChunk];
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
      expect(
        Object.keys(readRecoveryStore(storePath)).some((account) => account.includes(".chunk.")),
      ).toBe(true);
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
