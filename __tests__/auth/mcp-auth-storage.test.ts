import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { once } from "node:events";
import { fileURLToPath } from "node:url";
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

describe("cross-process credential locking", () => {
  let home: string;
  let store: string;
  const firstUrl = "https://first.invalid/mcp";
  const secondUrl = "https://second.invalid/mcp";
  const worker = fileURLToPath(new URL("../fixtures/credential-lock-worker.ts", import.meta.url));
  const busy =
    "OAuth credential storage is busy in another process. Retry after its operation finishes.";
  const original = {
    tokens: { accessToken: "x".repeat(5000), refreshToken: "refresh" },
    clientInfo: { clientId: "first-client" },
    codeVerifier: "verifier",
    oauthState: "state",
    futureMetadata: { kept: true },
    serverUrl: firstUrl,
  };
  const other = {
    tokens: { accessToken: "second-token" },
    clientInfo: { clientId: "second-client" },
    serverUrl: secondUrl,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "credential-lock-"));
    store = join(home, "keyring.json");
    writeFileSync(store, "{}");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function environment() {
    return {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(home, "agent"),
      FITCH_MCP_OAUTH_DIR: join(home, "oauth"),
      MCP_OAUTH_DIR: join(home, "old-oauth"),
      PI_MCP_ADAPTER_FAKE_NATIVE_KEYRING: store,
    };
  }

  function run(action: string, url = firstUrl) {
    return spawnSync(process.execPath, [worker, action, url], {
      env: {
        ...environment(),
        // The lock must not depend on which Pi or legacy-import directory is selected.
        PI_CODING_AGENT_DIR: join(home, "other-agent"),
        FITCH_MCP_OAUTH_DIR: join(home, "other-oauth"),
      },
      encoding: "utf8",
    });
  }

  async function runAsync(
    action: string,
    url = firstUrl,
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [worker, action, url], {
        env: {
          ...environment(),
          PI_CODING_AGENT_DIR: join(home, "other-agent"),
          FITCH_MCP_OAUTH_DIR: join(home, "other-oauth"),
        },
        encoding: "utf8",
      });
      return { status: 0, stdout, stderr };
    } catch (error) {
      const stdout = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
      const status =
        error instanceof Error && "code" in error && typeof error.code === "number"
          ? error.code
          : 1;
      return { status, stdout, stderr };
    }
  }

  function successful(action: string) {
    const result = run(action);
    expect(result.status, result.stderr).toBe(0);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
  }

  it(
    "serves OAuth HTTP handshakes and tool calls while another process reads the same credential",
    { timeout: 15_000 },
    async () => {
      const http = spawn(process.execPath, [worker, "http"], {
        env: environment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let httpOutput = "";
      let httpError = "";
      http.stdout.setEncoding("utf8");
      http.stderr.setEncoding("utf8");
      http.stdout.on("data", (data: string) => {
        httpOutput += data;
      });
      http.stderr.on("data", (data: string) => {
        httpError += data;
      });
      const httpClosed = once(http, "close");
      const announcement: unknown = await once(http.stdout, "data");
      const [line] = z.tuple([z.string()]).parse(announcement);
      const { url } = z.object({ url: z.string() }).parse(JSON.parse(line));
      const reader = spawn(process.execPath, [worker, "read", url], {
        env: { ...environment(), PI_MCP_ADAPTER_PAUSE_CHUNK_READ: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let readOutput = "";
      reader.stdout.setEncoding("utf8");
      reader.stdout.on("data", (data: string) => {
        readOutput += data;
      });
      const readerClosed = once(reader, "close");
      try {
        const ready: unknown = await once(reader.stdout, "data");
        expect(ready).toEqual(["reading-chunk\n"]);
        http.stdin.end("x");
        expect(await httpClosed, httpError).toEqual([0, null]);
        const result: unknown = JSON.parse(httpOutput.slice(line.length));
        expect(result).toMatchObject({
          first: { content: [{ type: "text", text: "authorized" }] },
          second: { content: [{ type: "text", text: "authorized" }] },
        });
        const { methods } = z.object({ methods: z.array(z.string()) }).parse(result);
        expect(methods.filter((method) => method === "tools/call")).toHaveLength(2);
        expect(run("clear", url).status).toBe(1);
        reader.stdin.end("x");
        expect(await readerClosed).toEqual([0, null]);
        const readback: unknown = JSON.parse(readOutput.slice("reading-chunk\n".length));
        expect(readback).toMatchObject({ entry: { tokens: { accessToken: "x".repeat(5000) } } });
      } finally {
        http.kill("SIGKILL");
        reader.kill("SIGKILL");
        await httpClosed;
        await readerClosed;
      }
    },
  );

  it(
    "rechecks and imports missing scoped credentials only after acquiring an exclusive lock",
    { timeout: 15_000 },
    async () => {
      successful("seed");
      const { path } = z.object({ path: z.string() }).parse(successful("legacy-source"));
      const locks = join(home, ".fitch-mcp-adapter", "locks");
      const files = readdirSync(locks);
      expect(files).toHaveLength(1);
      const lockPath = join(locks, z.string().parse(files[0]));
      const holder = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/storage-lock-worker.ts", import.meta.url)),
          "lock",
          lockPath,
          "read",
        ],
        { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
      );
      holder.stdout.setEncoding("utf8");
      const closed = once(holder, "close");
      try {
        const ready: unknown = await once(holder.stdout, "data");
        expect(ready).toEqual(["locked\n"]);
        const before = readFileSync(store, "utf8");
        const read = run("read");
        expect(read.status, read.stderr).toBe(1);
        const receipt: unknown = JSON.parse(read.stdout);
        expect(receipt).toMatchObject({ error: { operation: "write", message: busy } });
        expect(successful("inspect")).toEqual({
          status: "present",
          entry: { serverUrl: firstUrl, tokens: { accessToken: "legacy-token" } },
        });
        expect(readFileSync(store, "utf8")).toBe(before);
        expect(existsSync(path)).toBe(true);
        holder.stdin.end("x");
        expect(await closed).toEqual([0, null]);
        expect(successful("read")).toEqual({
          entry: { serverUrl: firstUrl, tokens: { accessToken: "legacy-token" } },
          other,
        });
        expect(existsSync(path)).toBe(false);
      } finally {
        holder.kill("SIGKILL");
        await closed;
      }
    },
  );

  it(
    "protects a chunked read from field updates, other-URL logout and migration, then permits updates after release",
    { timeout: 15_000 },
    async () => {
      expect(successful("seed")).toEqual({ entry: original, other });
      const before = readFileSync(store, "utf8");
      expect(Object.keys(readRecoveryStore(store)).some((key) => key.includes(".chunk."))).toBe(
        true,
      );
      const reader = spawn(process.execPath, [worker, "read"], {
        env: { ...environment(), PI_MCP_ADAPTER_PAUSE_CHUNK_READ: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      reader.stdout.setEncoding("utf8");
      reader.stderr.setEncoding("utf8");
      reader.stdout.on("data", (data: string) => {
        stdout += data;
      });
      reader.stderr.on("data", (data: string) => {
        stderr += data;
      });
      const closed = once(reader, "close");
      try {
        const ready: unknown = await Promise.race([
          once(reader.stdout, "data"),
          closed.then(() => {
            throw new Error(`Credential reader exited before pausing: ${stderr}`);
          }),
        ]);
        expect(ready).toEqual(["reading-chunk\n"]);
        const attempts = [
          { action: "update", url: firstUrl, operation: "write" },
          { action: "clear", url: firstUrl, operation: "write" },
          { action: "client", url: secondUrl, operation: "write" },
          { action: "logout", url: secondUrl, operation: "remove" },
          { action: "migrate", url: firstUrl, operation: "write" },
        ];
        const results = await Promise.all(
          attempts.map(async (attempt) => ({
            attempt,
            result: await runAsync(attempt.action, attempt.url),
          })),
        );
        for (const { attempt, result } of results) {
          expect(result.status, result.stderr).toBe(1);
          const receipt: unknown = JSON.parse(result.stdout);
          expect(receipt).toEqual({
            error: {
              code: "OAUTH_CREDENTIAL_STORE_UNAVAILABLE",
              operation: attempt.operation,
              message: busy,
            },
          });
          expect(readFileSync(store, "utf8")).toBe(before);
        }
        expect(successful("inspect")).toEqual({ status: "present", entry: original });
        expect(successful("read")).toEqual({ entry: original, other });
        reader.stdin.end("x");
        expect(await closed, stderr).toEqual([0, null]);
        const readback: unknown = JSON.parse(stdout.slice("reading-chunk\n".length));
        expect(readback).toEqual({ entry: original, other });
        expect(readFileSync(store, "utf8")).toBe(before);
      } finally {
        reader.kill("SIGKILL");
        await closed;
      }
      const { codeVerifier: _removed, ...cleared } = original;
      expect(successful("clear")).toEqual({ entry: cleared, other });
      expect(successful("update")).toEqual({
        entry: { ...cleared, tokens: { accessToken: "updated-token" } },
        other,
      });
      expect(Object.keys(readRecoveryStore(store)).some((key) => key.includes(".chunk."))).toBe(
        false,
      );
    },
  );

  it(
    "waits for a brief concurrent reader via SQLite busy_timeout and skips write locks on absent reads",
    { timeout: 15_000 },
    async () => {
      successful("seed");
      const locks = join(home, ".fitch-mcp-adapter", "locks");
      const lockPath = join(locks, z.string().parse(readdirSync(locks)[0]));
      const holder = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/storage-lock-worker.ts", import.meta.url)),
          "lock",
          lockPath,
          "read",
        ],
        { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
      );
      holder.stdout.setEncoding("utf8");
      const closed = once(holder, "close");
      try {
        expect(await once(holder.stdout, "data")).toEqual(["locked\n"]);
        // An absent URL read must NOT escalate to an exclusive write lock while a reader holds the lock.
        const absentRead = await runAsync("read", "https://absent.invalid/mcp");
        expect(absentRead.status, absentRead.stderr).toBe(0);
        // A writer waits briefly (busy_timeout) and succeeds once the reader releases within 2.5s.
        const pendingWrite = runAsync("update", firstUrl);
        setTimeout(() => {
          holder.stdin.end("x");
        }, 200);
        const writeResult = await pendingWrite;
        expect(writeResult.status, writeResult.stderr).toBe(0);
        expect(await closed).toEqual([0, null]);
        expect(JSON.parse(writeResult.stdout)).toMatchObject({
          entry: { tokens: { accessToken: "updated-token" } },
        });
      } finally {
        holder.kill("SIGKILL");
        await closed;
      }
    },
  );

  it(
    "waits for a concurrent writer under 2.5s instead of aborting credential reads on SQLITE_BUSY",
    { timeout: 15_000 },
    async () => {
      successful("seed");
      const locks = join(home, ".fitch-mcp-adapter", "locks");
      const lockPath = join(locks, z.string().parse(readdirSync(locks)[0]));
      const holder = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/storage-lock-worker.ts", import.meta.url)),
          "lock",
          lockPath,
          "write",
        ],
        { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
      );
      holder.stdout.setEncoding("utf8");
      const closed = once(holder, "close");
      try {
        expect(await once(holder.stdout, "data")).toEqual(["locked\n"]);
        const pendingRead = runAsync("read", firstUrl);
        setTimeout(() => {
          holder.stdin.end("x");
        }, 350);
        const readResult = await pendingRead;
        expect(readResult.status, readResult.stderr).toBe(0);
        expect(await closed).toEqual([0, null]);
        expect(JSON.parse(readResult.stdout)).toMatchObject({
          entry: original,
          other,
        });
      } finally {
        holder.kill("SIGKILL");
        await closed;
      }
    },
  );

  it(
    "does not keep Node alive when waiting on a contended async storage lock",
    { timeout: 10_000 },
    async () => {
      const lockPath = join(home, ".fitch-mcp-adapter", "locks", "unref-wait.sqlite");
      const holder = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/storage-lock-worker.ts", import.meta.url)),
          "lock",
          lockPath,
          "write",
        ],
        { env: environment(), stdio: ["pipe", "pipe", "pipe"] },
      );
      holder.stdout.setEncoding("utf8");
      const holderClosed = once(holder, "close");
      try {
        expect(await once(holder.stdout, "data")).toEqual(["locked\n"]);
        const waiterCode = [
          `import { withAsyncStorageLock } from ${JSON.stringify(new URL("../../storage-lock.ts", import.meta.url).href)};`,
          `void withAsyncStorageLock(${JSON.stringify(lockPath)}, async () => {}, { mode: "write", timeoutMs: 15_000, initialPollMs: 50, maxPollMs: 250, ref: false });`,
        ].join("\n");
        const startedAt = Date.now();
        const waiter = spawn(process.execPath, ["--input-type=module", "-e", waiterCode], {
          env: environment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const closed = await once(waiter, "close");
        const elapsedMs = Date.now() - startedAt;
        expect(closed).toEqual([0, null]);
        expect(elapsedMs).toBeLessThan(3_000);
      } finally {
        holder.kill("SIGKILL");
        await holderClosed;
      }
    },
  );
});

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
        "storage-lock.ts",
        "keyring-recovery.ts",
        "agent-dir.ts",
        "config.ts",
        "config-contracts.ts",
        "config-diff.ts",
        "config-disabled.ts",
        "config-file.ts",
        "config-imports.ts",
        "config-merge.ts",
        "config-native-pi.ts",
        "config-native-pi-exposure.ts",
        "config-native-pi-oauth.ts",
        "config-opencode.ts",
        "config-paths.ts",
        "config-protocol.ts",
        "config-types.ts",
        "config-validation.ts",
        "config-writes.ts",
        "types.ts",
        "ui-stream-types.ts",
        "abort.ts",
        "utils.ts",
        "mcp-output-values.ts",
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

  it("keeps arbitrary configured server names under safe hashed legacy import paths", async () => {
    const names = ["Cloudflare Workers", "сервер", "../escape", "@scope/name", ""];

    for (const [index, name] of names.entries()) {
      const token = `token-${index}`;
      await saveAuthEntry(
        { serverName: name, serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken: token } },
      );

      expect(
        (await getAuthEntry({ serverName: name, serverUrl: "https://example.com/mcp" }))?.tokens
          ?.accessToken,
      ).toBe(token);
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

  it("namespaces the configured oauthDir legacy import source", async () => {
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

    expect(
      (
        await getAuthEntry(
          { serverName: "configured", serverUrl: "https://example.com/mcp" },
          options,
        )
      )?.tokens?.accessToken,
    ).toBe("legacy-token");
    expect(filePath.startsWith(join(project, ".pi", "oauth", "fitch-mcp-adapter"))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(
      (
        await getAuthEntry(
          { serverName: "configured", serverUrl: "https://example.com/mcp" },
          options,
        )
      )?.tokens?.accessToken,
    ).toBe("legacy-token");
    rmSync(project, { recursive: true, force: true });
  });

  it("does not migrate legacy credentials during status-only inspection", async () => {
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

    expect(
      (await inspectAuthForUrl({ serverName: "status-only", serverUrl: "https://example.com/mcp" }))
        .status,
    ).toBe("present");
    expect(existsSync(filePath)).toBe(true);

    expect(
      (await getAuthEntry({ serverName: "status-only", serverUrl: "https://example.com/mcp" }))
        ?.tokens?.accessToken,
    ).toBe("legacy-token");
    expect(existsSync(filePath)).toBe(false);
  });

  it.each([
    { name: "tokens", payload: { tokens: { accessToken: 17 } } },
    { name: "client", payload: { clientInfo: { clientId: 17 } } },
    { name: "record", payload: [] },
  ])("keeps malformed legacy $name data out of secure storage", async ({ name, payload }) => {
    const serverName = `invalid-${name}`;
    const filePath = getAuthEntryFilePath(serverName);
    const bytes = JSON.stringify(payload);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);

    await expect(
      getAuthEntry({ serverName, serverUrl: "https://example.com/mcp" }),
    ).rejects.toThrow(/Invalid OAuth credential record/);
    expect(readFileSync(filePath, "utf8")).toBe(bytes);
    rmSync(filePath);
    expect(
      await getAuthEntry({ serverName, serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();
  });

  it("preserves future JSON fields across legacy import and secure reads", async () => {
    const entry = {
      tokens: { accessToken: "legacy-token", futureTokenMetadata: { version: 1 } },
      serverUrl: "https://example.com/mcp",
      futureEntryMetadata: { origin: "legacy" },
    };
    const filePath = getAuthEntryFilePath("future-fields");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(entry));

    expect(
      await getAuthEntry({ serverName: "future-fields", serverUrl: "https://example.com/mcp" }),
    ).toEqual(entry);
    expect(existsSync(filePath)).toBe(false);
    expect(
      await getAuthEntry({ serverName: "future-fields", serverUrl: "https://example.com/mcp" }),
    ).toEqual(entry);
  });

  it("does not use configured oauthDir values as secure-store namespaces", async () => {
    delete process.env.FITCH_MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-b-"));
    const optionsA = getAuthStorageOptions(".pi/oauth", projectA);
    const optionsB = getAuthStorageOptions(".pi/oauth", projectB);

    await saveAuthEntry(
      { serverName: "same-server", serverUrl: "https://example.com/mcp" },
      { tokens: { accessToken: "token-a" } },
      optionsA,
    );
    await saveAuthEntry(
      { serverName: "same-server", serverUrl: "https://example.com/mcp" },
      { tokens: { accessToken: "token-b" } },
      optionsB,
    );

    expect(
      (
        await getAuthEntry(
          { serverName: "same-server", serverUrl: "https://example.com/mcp" },
          optionsA,
        )
      )?.tokens?.accessToken,
    ).toBe("token-b");
    expect(
      (
        await getAuthEntry(
          { serverName: "same-server", serverUrl: "https://example.com/mcp" },
          optionsB,
        )
      )?.tokens?.accessToken,
    ).toBe("token-b");
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("keeps FITCH_MCP_OAUTH_DIR as the explicit override over settings.oauthDir", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);

    await saveAuthEntry(
      { serverName: "env-override", serverUrl: "https://example.com/mcp" },
      { tokens: { accessToken: "token" } },
      options,
    );

    const filePath = getAuthEntryFilePath("env-override", options);
    expect(filePath.startsWith(authDir)).toBe(true);
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("round-trips large secure-store entries", async () => {
    const accessToken = "x".repeat(5000);
    await saveAuthEntry(
      { serverName: "large-entry", serverUrl: "https://example.com/mcp" },
      { tokens: { accessToken } },
    );
    expect(
      (await getAuthEntry({ serverName: "large-entry", serverUrl: "https://example.com/mcp" }))
        ?.tokens?.accessToken,
    ).toBe(accessToken);
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

    it("routes revoked keyring operations through the helper", async () => {
      await saveAuthEntry(
        { serverName: "recovered", serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken: "token" } },
      );
      expect(
        (await getAuthEntry({ serverName: "recovered", serverUrl: "https://example.com/mcp" }))
          ?.tokens?.accessToken,
      ).toBe("token");
      await clearAllCredentials({ serverName: "recovered", serverUrl: "https://example.com/mcp" });
      expect(readRecoveryStore(storePath)).toEqual({});
    });

    it("chunks large entries within the secure-store payload limit", async () => {
      const accessToken = "x".repeat(5000);
      await saveAuthEntry(
        { serverName: "large", serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken } },
      );
      expect(
        (await getAuthEntry({ serverName: "large", serverUrl: "https://example.com/mcp" }))?.tokens
          ?.accessToken,
      ).toBe(accessToken);

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

    it("reports unavailable status when a chunk is missing", async () => {
      const serverUrl = "https://example.com/mcp";
      await saveAuthEntry(
        { serverName: "corrupt", serverUrl },
        { tokens: { accessToken: "x".repeat(5000) } },
      );
      const store = readRecoveryStore(storePath);
      const missingChunk = z
        .string()
        .parse(Object.keys(store).find((account) => account.includes(".chunk.")));
      delete store[missingChunk];
      writeFileSync(storePath, JSON.stringify(store));
      expect((await inspectAuthForUrl({ serverName: "corrupt", serverUrl })).status).toBe(
        "unavailable",
      );
    });

    it("cleans stale chunks when a large entry is replaced", async () => {
      await saveAuthEntry(
        { serverName: "shrinking", serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken: "x".repeat(5000) } },
      );
      await saveAuthEntry(
        { serverName: "shrinking", serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken: "small" } },
      );

      expect(
        (await getAuthEntry({ serverName: "shrinking", serverUrl: "https://example.com/mcp" }))
          ?.tokens?.accessToken,
      ).toBe("small");
      const accounts = Object.keys(readRecoveryStore(storePath));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).not.toContain(".chunk.");
    });

    it("removes chunk payloads when credentials are cleared", async () => {
      await saveAuthEntry(
        { serverName: "removing", serverUrl: "https://example.com/mcp" },
        { tokens: { accessToken: "x".repeat(5000) } },
      );
      expect(
        Object.keys(readRecoveryStore(storePath)).some((account) => account.includes(".chunk.")),
      ).toBe(true);
      await clearAllCredentials({ serverName: "removing", serverUrl: "https://example.com/mcp" });
      expect(readRecoveryStore(storePath)).toEqual({});
    });

    it("runs keyctl recovery asynchronously without blocking the event loop", async () => {
      const marker = join(harnessDir, "event-loop-ticked");
      const keyctlPath = process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL;
      expect(keyctlPath).toBeDefined();
      writeFileSync(
        z.string().parse(keyctlPath),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
for _ in $(seq 1 200); do
  if [ -f "${marker}" ]; then break; fi
  sleep 0.01
done
if [ ! -f "${marker}" ]; then exit 77; fi
shift 2
exec "$@"
`,
        { mode: 0o755 },
      );
      const timer = setTimeout(() => {
        writeFileSync(marker, "ticked");
      }, 25);
      try {
        await saveAuthEntry(
          { serverName: "async-recovery", serverUrl: "https://example.com/mcp" },
          { tokens: { accessToken: "non-blocking-token" } },
        );
        expect(existsSync(marker)).toBe(true);
        expect(
          (
            await getAuthEntry({
              serverName: "async-recovery",
              serverUrl: "https://example.com/mcp",
            })
          )?.tokens?.accessToken,
        ).toBe("non-blocking-token");
      } finally {
        clearTimeout(timer);
      }
    });
  });

  it("does not use the recovery helper for generic secure-store failures", async () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-no-recovery-"));
    const keyctlPath = join(harnessDir, "keyctl");
    const storePath = join(harnessDir, "store.json");
    writeFileSync(keyctlPath, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 });

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
    process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;

    await expect(
      getAuthEntry({ serverName: "generic-unavailable", serverUrl: "https://example.com/mcp" }),
    ).rejects.toThrow(/OS secure credential store/);
    expect(existsSync(storePath)).toBe(false);
    rmSync(harnessDir, { recursive: true, force: true });
  });
});
