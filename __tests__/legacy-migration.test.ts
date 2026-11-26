import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const globalConfig =
  '{\n // Keep the existing JSONC and formatting.\n "mcpServers": { "global": { "command": "unused-global-server" } }\n}\n';
const projectConfig = '{"mcpServers":{"project":{"command":"unused-project-server"}}}\n';

function globalSourceFiles(agent: string): Map<string, string> {
  return new Map([
    [join(agent, "mcp.json"), globalConfig],
    [join(agent, "mcp-cache.json"), '{"version":1,"servers":{}}'],
    [
      join(agent, "mcp-onboarding.json"),
      '{"version":1,"setupCompleted":true,"sharedConfigHintShown":true}',
    ],
    [join(agent, "mcp-npx-cache.json"), '{"version":1,"entries":{}}'],
  ]);
}

describe("explicit pre-v5 state migration", () => {
  let root: string;
  let agent: string;
  let project: string;

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), "fitch-mcp-migration-"));
    agent = join(root, "agent");
    project = join(root, "project");
    mkdirSync(project);
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("MCP_OAUTH_DIR", "");
    vi.stubEnv("FITCH_MCP_OAUTH_DIR", "");
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["https://${FITCH_MIGRATION_HOST}/mcp", "https://$env:FITCH_MIGRATION_HOST/mcp"])(
    "copies credentials under the resolved configured URL: %s",
    async (url) => {
      vi.stubEnv("FITCH_MIGRATION_HOST", "resolved.example.com");
      write(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { oauth: { url } } }));
      const account = `sha256-${createHash("sha256").update("oauth").digest("hex")}`;
      const source = join(agent, "mcp-oauth", account, "tokens.json");
      const identity = { serverName: "oauth", serverUrl: "https://resolved.example.com/mcp" };
      const entry = { serverUrl: identity.serverUrl, tokens: { accessToken: "legacy-token" } };
      write(source, JSON.stringify(entry));
      const { migrateLegacyState } = await import("../legacy-migration.ts");
      const { getAuthEntry } = await import("../mcp-auth.ts");
      expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
        { server: "oauth", status: "copied" },
      ]);
      expect(await getAuthEntry(identity)).toEqual(entry);
      expect(readFileSync(source, "utf8")).toBe(JSON.stringify(entry));
      expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
        { server: "oauth", status: "existing" },
      ]);
    },
  );

  it("reports unresolved migration URLs instead of counting credentials as absent", async () => {
    vi.stubEnv("FITCH_MISSING_MIGRATION_HOST", "");
    delete process.env.FITCH_MISSING_MIGRATION_HOST;
    write(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: { oauth: { url: "https://${FITCH_MISSING_MIGRATION_HOST}/mcp" } },
      }),
    );
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    await expect(migrateLegacyState({ cwd: project })).rejects.toThrow(
      /Missing environment variable.*FITCH_MISSING_MIGRATION_HOST/,
    );
  });

  it("ignores pre-v5 adapter defaults while reading native Pi global/project and shared MCP configs read-only", async () => {
    const legacyAdapterGlobalConfig = JSON.stringify({
      settings: { toolPrefix: "short" },
      mcpServers: { legacyGlobal: { command: "unused-legacy-global", directTools: true } },
    });
    write(join(agent, "mcp.json"), legacyAdapterGlobalConfig);
    write(join(project, ".pi", "mcp.json"), projectConfig);
    write(join(agent, "mcp-cache.json"), '{"version":1,"servers":{}}');
    write(
      join(agent, "mcp-onboarding.json"),
      '{"version":1,"setupCompleted":true,"sharedConfigHintShown":true}',
    );
    write(
      join(project, ".mcp.json"),
      '{"mcpServers":{"shared":{"command":"unused-shared-server"}}}',
    );

    const { loadMcpConfig } = await import("../config.ts");
    const { loadMetadataCache } = await import("../metadata-cache.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");
    expect(Object.keys(loadMcpConfig(undefined, project).mcpServers).sort()).toEqual([
      "project",
      "shared",
    ]);
    expect(
      Object.keys(loadMcpConfig(undefined, project, { includeProject: false }).mcpServers),
    ).toEqual([]);
    // Valid native Pi global `<agentDir>/mcp.json` is loaded read-only when it does not use adapter-only keys.
    write(join(agent, "mcp.json"), globalConfig);
    expect(Object.keys(loadMcpConfig(undefined, project).mcpServers).sort()).toEqual([
      "global",
      "project",
      "shared",
    ]);
    expect(
      Object.keys(loadMcpConfig(undefined, project, { includeProject: false }).mcpServers),
    ).toEqual(["global"]);
    expect(loadMetadataCache()).toBeNull();
    expect(loadOnboardingState().setupCompleted).toBe(false);
    expect(existsSync(join(agent, "fitch-mcp-adapter"))).toBe(false);
    expect(existsSync(join(project, ".pi", "fitch-mcp-adapter"))).toBe(false);
  });

  it("copies owned state byte-for-byte and keeps later config/cache writes separate", async () => {
    const sources = globalSourceFiles(agent);
    for (const [path, contents] of sources) {
      write(path, contents);
    }
    write(join(project, ".pi", "mcp.json"), projectConfig);
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const result = await migrateLegacyState({ cwd: project });
    expect(result.files).toHaveLength(4);
    expect(result.files.every((file) => file.status === "copied")).toBe(true);
    expect(result.credentials).toEqual([]);
    for (const file of result.files) {
      expect(readFileSync(file.destination, "utf8")).toBe(sources.get(file.source));
    }
    // Native project .pi/mcp.json stays untouched and is not copied over into .pi/fitch-mcp-adapter/mcp.json.
    expect(existsSync(join(project, ".pi", "fitch-mcp-adapter", "mcp.json"))).toBe(false);

    const { loadMcpConfig, writeProjectServerDisabledOverride } = await import("../config.ts");
    const { saveMetadataCache } = await import("../metadata-cache.ts");
    expect(Object.keys(loadMcpConfig(undefined, project).mcpServers).sort()).toEqual([
      "global",
      "project",
    ]);
    writeProjectServerDisabledOverride(undefined, project, "global", true);
    saveMetadataCache({ version: 1, servers: {} });
    expect(loadMcpConfig(undefined, project).mcpServers.global?.disabled).toBe(true);
    for (const [path, contents] of sources) {
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
  });

  it.skipIf(process.platform === "win32")(
    "creates every migrated file with private permissions",
    async () => {
      for (const [path, contents] of globalSourceFiles(agent)) {
        write(path, contents);
      }
      const { migrateLegacyState } = await import("../legacy-migration.ts");
      const result = await migrateLegacyState({ cwd: project });
      expect(result.files).toHaveLength(4);
      for (const file of result.files) {
        expect(statSync(file.destination).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("does not overwrite destinations on first or repeated migration", async () => {
    write(join(agent, "mcp.json"), globalConfig);
    const destination = join(agent, "fitch-mcp-adapter", "mcp.json");
    const independent = '{"mcpServers":{"new":{"command":"unused-new-server"}}}';
    write(destination, independent);
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    for (let run = 0; run < 2; run++) {
      expect((await migrateLegacyState({ cwd: project })).files[0]?.status).toBe("existing");
      expect(readFileSync(destination, "utf8")).toBe(independent);
      expect(readFileSync(join(agent, "mcp.json"), "utf8")).toBe(globalConfig);
    }
  });

  it("previews files without copying them or reading an unavailable credential store", async () => {
    write(join(agent, "mcp.json"), globalConfig);
    write(join(project, ".pi", "mcp.json"), projectConfig);
    write(join(project, ".mcp.json"), '{"mcpServers":{"oauth":{"url":"https://example.com/mcp"}}}');
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "unavailable");
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const result = await migrateLegacyState({ cwd: project, dryRun: true });
    expect(result.files.filter((file) => file.status === "would-copy")).toHaveLength(1);
    expect(result.credentials).toEqual([]);
    expect(existsSync(join(agent, "fitch-mcp-adapter"))).toBe(false);
    expect(existsSync(join(project, ".pi", "fitch-mcp-adapter"))).toBe(false);
  });

  it("promotes configured current plaintext before copying an older plaintext grant", async () => {
    write(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: { oauth: { url: "https://example.com/mcp" } },
        settings: { oauthDir: ".pi/oauth" },
      }),
    );
    const account = `sha256-${createHash("sha256").update("oauth").digest("hex")}`;
    const directory = join(project, ".pi", "oauth");
    const historical = join(directory, account, "tokens.json");
    const active = join(directory, "fitch-mcp-adapter", account, "tokens.json");
    const identity = { serverName: "oauth", serverUrl: "https://example.com/mcp" };
    const current = { serverUrl: identity.serverUrl, tokens: { accessToken: "CURRENT-GRANT" } };
    const stale = { serverUrl: identity.serverUrl, tokens: { accessToken: "STALE-V4-GRANT" } };
    write(historical, JSON.stringify(stale));
    write(active, JSON.stringify(current));
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const { getAuthEntry, updateTokens } = await import("../mcp-auth.ts");
    expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
      { server: "oauth", status: "existing" },
    ]);
    expect(await getAuthEntry(identity)).toEqual(current);
    expect(existsSync(active)).toBe(false);
    await updateTokens(identity, { accessToken: "CURRENT-UPDATED" });
    expect((await getAuthEntry(identity))?.tokens?.accessToken).toBe("CURRENT-UPDATED");
    expect(readFileSync(historical, "utf8")).toBe(JSON.stringify(stale));
  });

  it("keeps a custom legacy directory intact through runtime reads, refresh and logout", async () => {
    write(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: { oauth: { url: "https://example.com/mcp" } },
        settings: { oauthDir: ".pi/mcp-oauth" },
      }),
    );
    const account = `sha256-${createHash("sha256").update("oauth").digest("hex")}`;
    const source = join(project, ".pi", "mcp-oauth", account, "tokens.json");
    const entry = {
      serverUrl: "https://example.com/mcp",
      tokens: { accessToken: "original-token" },
    };
    const original = JSON.stringify(entry);
    write(source, original);

    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const { loadMcpConfig } = await import("../config.ts");
    const { getAuthStorageOptions, getAuthForUrl, updateTokens, clearAllCredentials } =
      await import("../mcp-auth.ts");
    expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
      { server: "oauth", status: "copied" },
    ]);
    const config = loadMcpConfig(undefined, project);
    const options = getAuthStorageOptions(config.settings?.oauthDir, project);
    expect(
      await getAuthForUrl({ serverName: "oauth", serverUrl: entry.serverUrl }, options),
    ).toEqual(entry);
    expect(readFileSync(source, "utf8")).toBe(original);
    await updateTokens(
      { serverName: "oauth", serverUrl: entry.serverUrl },
      { accessToken: "refreshed-token" },
      options,
    );
    expect(
      (await getAuthForUrl({ serverName: "oauth", serverUrl: entry.serverUrl }, options))?.tokens
        ?.accessToken,
    ).toBe("refreshed-token");
    expect(readFileSync(source, "utf8")).toBe(original);
    await clearAllCredentials(
      { serverName: "oauth", serverUrl: "https://example.com/mcp" },
      options,
    );
    expect(
      await getAuthForUrl({ serverName: "oauth", serverUrl: entry.serverUrl }, options),
    ).toBeUndefined();
    expect(readFileSync(source, "utf8")).toBe(original);
  });

  it("imports configured legacy plaintext credentials once without deleting or falling back to them", async () => {
    write(join(agent, "mcp.json"), '{"mcpServers":{"oauth":{"url":"https://example.com/mcp"}}}');
    const account = `sha256-${createHash("sha256").update("oauth").digest("hex")}`;
    const source = join(agent, "mcp-oauth", account, "tokens.json");
    const entry = {
      serverUrl: "https://example.com/mcp",
      tokens: { accessToken: "legacy-token", refreshToken: "legacy-refresh" },
    };
    write(source, JSON.stringify(entry));

    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const { getAuthEntry, clearAllCredentials } = await import("../mcp-auth.ts");
    expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
      { server: "oauth", status: "copied" },
    ]);
    expect(
      await getAuthEntry({ serverName: "oauth", serverUrl: "https://example.com/mcp" }),
    ).toEqual(entry);
    expect((await migrateLegacyState({ cwd: project })).credentials).toEqual([
      { server: "oauth", status: "existing" },
    ]);
    await clearAllCredentials({ serverName: "oauth", serverUrl: "https://example.com/mcp" });
    expect(
      await getAuthEntry({ serverName: "oauth", serverUrl: "https://example.com/mcp" }),
    ).toBeUndefined();
    expect(JSON.parse(readFileSync(source, "utf8"))).toEqual(entry);
  });

  it("skips servers-only native <agentDir>/mcp.json adapter entries and warns during CLI migration", async () => {
    write(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          legacyOnly: { command: "unused-legacy-entry", directTools: true },
          nativeEntry: { command: "unused-native-entry" },
        },
      }),
    );
    const { loadMcpConfig } = await import("../config.ts");
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const loaded = loadMcpConfig(undefined, project);
      expect(loaded.mcpServers.legacyOnly).toBeUndefined();
      expect(loaded.mcpServers.nativeEntry).toBeDefined();
      expect(
        warnings.some((message) => message.includes('Ignoring native Pi MCP entry "legacyOnly"')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(process.execPath, [join(process.cwd(), "cli.js"), "migrate"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      encoding: "utf8",
    });
    expect(output).toContain("user-global native MCP config");
    expect(output).toContain("remove or rename a retired pre-v5 <agentDir>/mcp.json");
  });
});
