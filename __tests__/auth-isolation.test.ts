import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllCredentials, getAuthEntry, getAuthForUrl, migrateLegacyAuthEntry, saveAuthEntry } from "../mcp-auth.ts";

const server = "same-configured-server";
const account = `sha256-${createHash("sha256").update(server).digest("hex")}`;
const upstreamKey = `pi-mcp-adapter.oauth\0${account}`;
const ownedKey = `fitch-mcp-adapter.oauth\0${account}`;
const upstreamEntry = {
  serverUrl: "https://example.com/mcp",
  tokens: { accessToken: "upstream-token", refreshToken: "refresh-token", issuer: "https://issuer.example" },
  clientInfo: { clientId: "existing-client", redirectUris: ["http://localhost:19876/callback"], issuer: "https://issuer.example" },
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
    writeFileSync(helper, `
const { readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
const path = process.env.FITCH_TEST_KEYRING;
const entries = JSON.parse(readFileSync(path, "utf8"));
const key = request.service + "\\0" + request.account;
if (request.operation === "read") {
  const value = entries[key];
  process.stdout.write(JSON.stringify(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value }));
} else {
  if (request.operation === "write") {
    if (process.env.FITCH_TEST_FAIL_WRITE === "1") throw new Error("Fixture write failure");
    entries[key] = request.payload;
  }
  else if (request.operation === "remove") delete entries[key];
  else throw new Error("Unexpected keyring operation");
  writeFileSync(path, JSON.stringify(entries));
  process.stdout.write(JSON.stringify({ ok: true }));
}
`);
    writeFileSync(storePath, JSON.stringify({ [upstreamKey]: JSON.stringify(upstreamEntry) }));
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
    return JSON.parse(readFileSync(storePath, "utf8"));
  }

  it("keeps upstream credentials intact across reads, writes and logout for the same server name", () => {
    expect(getAuthEntry(server)).toBeUndefined();

    saveAuthEntry(server, { tokens: { accessToken: "fitch-token" } }, upstreamEntry.serverUrl);
    expect(getAuthEntry(server)?.tokens?.accessToken).toBe("fitch-token");
    expect(JSON.parse(storedEntries()[upstreamKey]!)).toEqual(upstreamEntry);
    expect(JSON.parse(storedEntries()[ownedKey]!)).toEqual({
      serverUrl: upstreamEntry.serverUrl,
      tokens: { accessToken: "fitch-token" },
    });

    clearAllCredentials(server);
    expect(getAuthEntry(server)).toBeUndefined();
    expect(storedEntries()).toEqual({ [upstreamKey]: JSON.stringify(upstreamEntry) });
  });

  it("explicitly copies native credentials and bindings once, without modifying the source", () => {
    expect(migrateLegacyAuthEntry(server)).toBe("copied");
    expect(getAuthForUrl(server, upstreamEntry.serverUrl)).toEqual(upstreamEntry);
    expect(getAuthForUrl(server, "https://different.example/mcp")).toBeUndefined();
    expect(storedEntries()).toEqual({
      [upstreamKey]: JSON.stringify(upstreamEntry),
      [ownedKey]: JSON.stringify(upstreamEntry),
    });

    saveAuthEntry(server, { tokens: { accessToken: "renewed-fitch-token" } }, upstreamEntry.serverUrl);
    expect(migrateLegacyAuthEntry(server)).toBe("existing");
    expect(getAuthEntry(server)?.tokens?.accessToken).toBe("renewed-fitch-token");
    clearAllCredentials(server);
    expect(getAuthEntry(server)).toBeUndefined();
    expect(storedEntries()).toEqual({ [upstreamKey]: JSON.stringify(upstreamEntry) });
  });

  it("copies the pre-v5 chunked keyring format without removing its manifest or chunks", () => {
    const entry = { ...upstreamEntry, tokens: { accessToken: "x".repeat(3000) } };
    const payload = JSON.stringify(entry);
    const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    const source = {
      [upstreamKey]: JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest }),
      [`${upstreamKey}.chunk.${digest}.0`]: payload.slice(0, 1800),
      [`${upstreamKey}.chunk.${digest}.1`]: payload.slice(1800),
    };
    writeFileSync(storePath, JSON.stringify(source));

    expect(migrateLegacyAuthEntry(server)).toBe("copied");
    expect(getAuthEntry(server)).toEqual(entry);
    clearAllCredentials(server);
    expect(storedEntries()).toEqual(source);
  });

  it("preserves the source when the destination credential store cannot write", () => {
    vi.stubEnv("FITCH_TEST_FAIL_WRITE", "1");
    expect(() => migrateLegacyAuthEntry(server)).toThrow(/Failed to write OAuth credentials/);
    expect(storedEntries()).toEqual({ [upstreamKey]: JSON.stringify(upstreamEntry) });
  });

  it("does not import or delete the upstream plaintext directory during normal use", () => {
    const upstreamFile = join(root, "mcp-oauth", account, "tokens.json");
    mkdirSync(dirname(upstreamFile), { recursive: true });
    writeFileSync(upstreamFile, JSON.stringify(upstreamEntry));
    vi.stubEnv("MCP_OAUTH_DIR", join(root, "mcp-oauth"));

    expect(getAuthEntry(server)).toBeUndefined();
    saveAuthEntry(server, { tokens: { accessToken: "new-token" } });
    clearAllCredentials(server);
    expect(existsSync(upstreamFile)).toBe(true);
    expect(JSON.parse(readFileSync(upstreamFile, "utf8"))).toEqual(upstreamEntry);
  });
});
