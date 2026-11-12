import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  clearOAuthState,
  getOAuthState,
  updateTokens,
  updateClientInfo,
  getAuthEntryFilePath,
  inspectAuthForUrl,
  getAuthEntry,
  getAuthForUrl,
  migrateLegacyAuthEntry,
  saveAuthEntry,
} from "../../mcp-auth.ts";

const server = "same-configured-server";
const account = `sha256-${createHash("sha256").update(server).digest("hex")}`;
const legacyKey = `pi-mcp-adapter.oauth\0${account}`;
const identity = { serverName: server, serverUrl: "https://example.com/mcp" };
const scopedAccount = `v2-sha256-${createHash("sha256")
  .update(JSON.stringify([identity.serverName, identity.serverUrl]))
  .digest("hex")}`;
const ownedKey = `fitch-mcp-adapter.oauth\0${scopedAccount}`;
const nameOnlyKey = `fitch-mcp-adapter.oauth\0${account}`;
const legacyEntry = {
  serverUrl: "https://example.com/mcp",
  tokens: {
    accessToken: "legacy-token",
    refreshToken: "refresh-token",
    issuer: "https://issuer.example",
  },
  clientInfo: {
    clientId: "existing-client",
    redirectUris: ["http://localhost:19876/callback"],
    issuer: "https://issuer.example",
  },
};

// Exercise the real storage and Linux recovery path against a fake OS credential
// backend. The fixture models the keyring's service/account boundary, not auth logic.
describe.skipIf(process.platform === "win32")("independent OAuth storage", () => {
  let root: string;
  let storePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fitch-mcp-auth-isolation-"));
    storePath = join(root, "keyring.json");
    const keyctl = join(root, "keyctl");
    const helper = join(root, "keyring.cjs");
    writeFileSync(keyctl, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
    copyFileSync(new URL("../fixtures/file-keyring.cjs", import.meta.url), helper);
    writeFileSync(storePath, JSON.stringify({ [legacyKey]: JSON.stringify(legacyEntry) }));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    vi.stubEnv("FITCH_TEST_KEYRING", storePath);
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "keyrevoked");
    vi.stubEnv("PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY", "1");
    vi.stubEnv("PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL", keyctl);
    vi.stubEnv("PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE", process.execPath);
    vi.stubEnv("PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER", helper);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function storedEntries(): Record<string, string> {
    return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(storePath, "utf8")));
  }

  function storedEntry(key: string): unknown {
    const entry = storedEntries()[key];
    if (entry === undefined) {
      throw new Error(`Missing keyring entry: ${key}`);
    }
    const value: unknown = JSON.parse(entry);
    return value;
  }

  it("keeps legacy credentials intact across reads, writes and logout for the same server name", () => {
    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();

    saveAuthEntry(
      { serverName: server, serverUrl: legacyEntry.serverUrl },
      { tokens: { accessToken: "fitch-token" } },
    );
    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" })?.tokens
        ?.accessToken,
    ).toBe("fitch-token");
    expect(storedEntry(legacyKey)).toEqual(legacyEntry);
    expect(storedEntry(ownedKey)).toEqual({
      serverUrl: legacyEntry.serverUrl,
      tokens: { accessToken: "fitch-token" },
    });

    clearAllCredentials({ serverName: server, serverUrl: "https://example.com/mcp" });
    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();
    expect(storedEntries()).toEqual({ [legacyKey]: JSON.stringify(legacyEntry) });
  });

  it.each(["secure", "plaintext"])(
    "promotes a live current %s grant before the historical grant",
    (source) => {
      const current = {
        ...legacyEntry,
        tokens: { accessToken: "CURRENT-GRANT", refreshToken: "CURRENT-REFRESH" },
      };
      const stale = { ...legacyEntry, tokens: { accessToken: "STALE-V4-GRANT" } };
      writeFileSync(storePath, JSON.stringify({ [legacyKey]: JSON.stringify(stale) }));
      if (source === "secure") {
        writeFileSync(
          storePath,
          JSON.stringify({
            ...storedEntries(),
            [nameOnlyKey]: JSON.stringify(current),
          }),
        );
      } else {
        const path = getAuthEntryFilePath(server);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(current));
      }

      expect(migrateLegacyAuthEntry(identity)).toBe("existing");
      expect(getAuthEntry(identity)).toEqual(current);
      expect(storedEntry(ownedKey)).toEqual(current);
      expect(storedEntries()[nameOnlyKey]).toBeUndefined();
      expect(existsSync(getAuthEntryFilePath(server))).toBe(false);
      updateTokens(identity, { accessToken: "CURRENT-UPDATED" });
      expect(getAuthEntry(identity)).toEqual({
        ...current,
        tokens: { accessToken: "CURRENT-UPDATED" },
      });
      expect(storedEntry(legacyKey)).toEqual(stale);
    },
  );

  it("ignores another URL's current grant when explicitly copying a matching historical grant", () => {
    const other = {
      ...legacyEntry,
      serverUrl: identity.serverUrl + "/",
      tokens: { accessToken: "OTHER-URL" },
    };
    writeFileSync(
      storePath,
      JSON.stringify({
        [nameOnlyKey]: JSON.stringify(other),
        [legacyKey]: JSON.stringify(legacyEntry),
      }),
    );
    expect(migrateLegacyAuthEntry(identity)).toBe("copied");
    expect(getAuthEntry(identity)).toEqual(legacyEntry);
    updateTokens(identity, { accessToken: "UPDATED" });
    expect(storedEntry(nameOnlyKey)).toEqual(other);
    expect(storedEntry(legacyKey)).toEqual(legacyEntry);
  });

  it("keeps a mismatched historical grant untouched when promoting a live current grant", () => {
    const other = { ...legacyEntry, serverUrl: identity.serverUrl + "/" };
    const current = { ...legacyEntry, tokens: { accessToken: "CURRENT-GRANT" } };
    writeFileSync(
      storePath,
      JSON.stringify({
        [nameOnlyKey]: JSON.stringify(current),
        [legacyKey]: JSON.stringify(other),
      }),
    );
    expect(migrateLegacyAuthEntry(identity)).toBe("existing");
    expect(getAuthEntry(identity)).toEqual(current);
    updateTokens(identity, { accessToken: "UPDATED" });
    expect(storedEntry(legacyKey)).toEqual(other);
  });

  it("explicitly copies native credentials and bindings once, without modifying the source", () => {
    expect(
      migrateLegacyAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBe("copied");
    expect(getAuthForUrl({ serverName: server, serverUrl: legacyEntry.serverUrl })).toEqual(
      legacyEntry,
    );
    expect(
      getAuthForUrl({ serverName: server, serverUrl: "https://different.example/mcp" }),
    ).toBeUndefined();
    expect(storedEntries()).toEqual({
      [legacyKey]: JSON.stringify(legacyEntry),
      [ownedKey]: JSON.stringify(legacyEntry),
    });

    saveAuthEntry(
      { serverName: server, serverUrl: legacyEntry.serverUrl },
      { tokens: { accessToken: "renewed-fitch-token" } },
    );
    expect(
      migrateLegacyAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBe("existing");
    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" })?.tokens
        ?.accessToken,
    ).toBe("renewed-fitch-token");
    clearAllCredentials({ serverName: server, serverUrl: "https://example.com/mcp" });
    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();
    expect(storedEntries()).toEqual({ [legacyKey]: JSON.stringify(legacyEntry) });
  });

  it("copies the pre-v5 chunked keyring format without removing its manifest or chunks", () => {
    const entry = { ...legacyEntry, tokens: { accessToken: "x".repeat(3000) } };
    const payload = JSON.stringify(entry);
    const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    const source = {
      [legacyKey]: JSON.stringify({
        __piMcpAdapterOAuthChunked: 1,
        chunkCount: 2,
        chunkDigest: digest,
      }),
      [`${legacyKey}.chunk.${digest}.0`]: payload.slice(0, 1800),
      [`${legacyKey}.chunk.${digest}.1`]: payload.slice(1800),
    };
    writeFileSync(storePath, JSON.stringify(source));

    expect(
      migrateLegacyAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBe("copied");
    expect(getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" })).toEqual(
      entry,
    );
    clearAllCredentials({ serverName: server, serverUrl: "https://example.com/mcp" });
    expect(storedEntries()).toEqual(source);
  });

  it("preserves the source when the destination credential store cannot write", () => {
    vi.stubEnv("FITCH_TEST_FAIL_WRITE", "1");
    expect(() =>
      migrateLegacyAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toThrow(/Failed to write OAuth credentials/);
    expect(storedEntries()).toEqual({ [legacyKey]: JSON.stringify(legacyEntry) });
  });

  it("does not import or delete the legacy plaintext directory during normal use", () => {
    const legacyFile = join(root, "mcp-oauth", account, "tokens.json");
    mkdirSync(dirname(legacyFile), { recursive: true });
    writeFileSync(legacyFile, JSON.stringify(legacyEntry));
    vi.stubEnv("MCP_OAUTH_DIR", join(root, "mcp-oauth"));

    expect(
      getAuthEntry({ serverName: server, serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();
    saveAuthEntry(
      { serverName: server, serverUrl: "https://example.com/mcp" },
      { tokens: { accessToken: "new-token" } },
    );
    clearAllCredentials({ serverName: server, serverUrl: "https://example.com/mcp" });
    expect(existsSync(legacyFile)).toBe(true);
    expect(JSON.parse(readFileSync(legacyFile, "utf8"))).toEqual(legacyEntry);
  });
  it("isolates writes, field clears, status and logout by the exact URL", () => {
    const other = { ...identity, serverUrl: identity.serverUrl + "/" };
    const otherEntry = {
      serverUrl: other.serverUrl,
      tokens: { accessToken: "other-token".repeat(400) },
      clientInfo: { clientId: "other-client" },
      codeVerifier: "other-verifier",
      oauthState: "other-state",
    };
    saveAuthEntry(identity, { ...otherEntry, tokens: { accessToken: "first-token" } });
    saveAuthEntry(other, otherEntry);
    const otherBytes = storedEntries();
    expect(getAuthEntry(identity)?.serverUrl).toBe(identity.serverUrl);
    expect(getAuthEntry(identity)?.tokens?.accessToken).toBe("first-token");
    updateTokens(identity, { accessToken: "updated-token" });
    updateClientInfo(identity, { clientId: "updated-client" });
    clearCodeVerifier(identity);
    clearOAuthState(identity);
    clearTokens(identity);
    clearClientInfo(identity);
    expect(getAuthEntry(identity)).toEqual({ serverUrl: identity.serverUrl });
    expect(getOAuthState(other)).toBe("other-state");
    expect(inspectAuthForUrl(other)).toEqual({ status: "present", entry: otherEntry });
    clearAllCredentials(identity);
    expect(getAuthEntry(identity)).toBeUndefined();
    expect(getAuthEntry(other)).toEqual(otherEntry);
    for (const [key, bytes] of Object.entries(otherBytes).filter(
      ([accountKey]) => accountKey !== ownedKey,
    )) {
      expect(storedEntries()[key]).toBe(bytes);
    }
    clearAllCredentials(other);
    expect(storedEntries()).toEqual({ [legacyKey]: JSON.stringify(legacyEntry) });
  });

  it.each([undefined, "https://different.example/mcp"])(
    "leaves name-only secure and plaintext records with URL %s untouched",
    (serverUrl) => {
      const entry = {
        tokens: { accessToken: "unmatched" },
        ...(serverUrl === undefined ? {} : { serverUrl }),
      };
      const payload = JSON.stringify(entry);
      const source = getAuthEntryFilePath(server);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, payload);
      writeFileSync(storePath, JSON.stringify({ [nameOnlyKey]: payload, [legacyKey]: payload }));
      const before = readFileSync(storePath, "utf8");
      expect(getAuthEntry(identity)).toBeUndefined();
      expect(migrateLegacyAuthEntry(identity, dirname(dirname(source)))).toBe("absent");
      clearCodeVerifier(identity);
      clearOAuthState(identity);
      clearClientInfo(identity);
      clearTokens(identity);
      clearAllCredentials(identity);
      expect(readFileSync(storePath, "utf8")).toBe(before);
      expect(readFileSync(source, "utf8")).toBe(payload);
    },
  );

  it("consumes matching automatic import sources and cannot resurrect logout", () => {
    const source = getAuthEntryFilePath(server);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, JSON.stringify(legacyEntry));
    writeFileSync(storePath, JSON.stringify({ [nameOnlyKey]: JSON.stringify(legacyEntry) }));
    expect(inspectAuthForUrl(identity)).toEqual({ status: "present", entry: legacyEntry });
    expect(existsSync(source)).toBe(true);
    expect(storedEntries()[nameOnlyKey]).toBeDefined();
    expect(getAuthEntry(identity)).toEqual(legacyEntry);
    expect(storedEntries()[nameOnlyKey]).toBeUndefined();
    expect(existsSync(source)).toBe(false);
    clearAllCredentials(identity);
    expect(getAuthEntry(identity)).toBeUndefined();
    expect(storedEntries()).toEqual({});
  });

  it("keeps a scoped record over matching legacy sources, including on logout before a read", () => {
    saveAuthEntry(identity, { tokens: { accessToken: "scoped-wins" } });
    writeFileSync(
      storePath,
      JSON.stringify({ ...storedEntries(), [nameOnlyKey]: JSON.stringify(legacyEntry) }),
    );
    expect(getAuthEntry(identity)?.tokens?.accessToken).toBe("scoped-wins");
    expect(storedEntries()[nameOnlyKey]).toBe(JSON.stringify(legacyEntry));
    writeFileSync(
      storePath,
      JSON.stringify({ ...storedEntries(), [nameOnlyKey]: JSON.stringify(legacyEntry) }),
    );
    clearAllCredentials(identity);
    expect(getAuthEntry(identity)).toBeUndefined();
    expect(storedEntries()).toEqual({ [legacyKey]: JSON.stringify(legacyEntry) });
  });

  it("does not consume automatic import sources when the scoped write fails", () => {
    writeFileSync(storePath, JSON.stringify({ [nameOnlyKey]: JSON.stringify(legacyEntry) }));
    vi.stubEnv("FITCH_TEST_FAIL_WRITE", "1");
    expect(() => getAuthEntry(identity)).toThrow(/Failed to write OAuth credentials/);
    expect(storedEntries()).toEqual({ [nameOnlyKey]: JSON.stringify(legacyEntry) });
  });
});
