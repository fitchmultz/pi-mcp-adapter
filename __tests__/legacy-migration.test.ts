import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const globalConfig = '{\n // Keep the existing JSONC and formatting.\n "mcpServers": { "global": { "command": "unused-global-server" } }\n}\n';
const projectConfig = '{"mcpServers":{"project":{"command":"unused-project-server"}}}\n';

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

  it("ignores upstream-owned defaults while retaining shared standard MCP discovery", async () => {
    write(join(agent, "mcp.json"), globalConfig);
    write(join(project, ".pi", "mcp.json"), projectConfig);
    write(join(agent, "mcp-cache.json"), '{"version":1,"servers":{}}');
    write(join(agent, "mcp-onboarding.json"), '{"version":1,"setupCompleted":true,"sharedConfigHintShown":true}');
    write(join(project, ".mcp.json"), '{"mcpServers":{"shared":{"command":"unused-shared-server"}}}');

    const { loadMcpConfig } = await import("../config.ts");
    const { loadMetadataCache } = await import("../metadata-cache.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");
    expect(Object.keys(loadMcpConfig(undefined, project).mcpServers)).toEqual(["shared"]);
    expect(loadMetadataCache()).toBeNull();
    expect(loadOnboardingState().setupCompleted).toBe(false);
    expect(existsSync(join(agent, "fitch-mcp-adapter"))).toBe(false);
  });

  it("copies owned state byte-for-byte and keeps later config/cache writes separate", async () => {
    const sourceFiles = new Map([
      [join(agent, "mcp.json"), globalConfig],
      [join(agent, "mcp-cache.json"), '{"version":1,"servers":{}}'],
      [join(agent, "mcp-onboarding.json"), '{"version":1,"setupCompleted":true,"sharedConfigHintShown":true}'],
      [join(agent, "mcp-npx-cache.json"), '{"version":1,"entries":{}}'],
      [join(project, ".pi", "mcp.json"), projectConfig],
    ]);
    for (const [path, contents] of sourceFiles) write(path, contents);
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const result = migrateLegacyState({ cwd: project });
    expect(result.files).toHaveLength(5);
    expect(result.files.every((file) => file.status === "copied")).toBe(true);
    expect(result.credentials).toEqual([]);
    for (const file of result.files) {
      expect(readFileSync(file.destination, "utf8")).toBe(sourceFiles.get(file.source));
      if (process.platform !== "win32") expect(statSync(file.destination).mode & 0o777).toBe(0o600);
    }

    const { loadMcpConfig, writeProjectServerDisabledOverride } = await import("../config.ts");
    const { saveMetadataCache } = await import("../metadata-cache.ts");
    expect(Object.keys(loadMcpConfig(undefined, project).mcpServers).sort()).toEqual(["global", "project"]);
    writeProjectServerDisabledOverride(undefined, project, "global", true);
    saveMetadataCache({ version: 1, servers: {} });
    expect(loadMcpConfig(undefined, project).mcpServers.global.disabled).toBe(true);
    for (const [path, contents] of sourceFiles) expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("does not overwrite destinations on first or repeated migration", async () => {
    write(join(agent, "mcp.json"), globalConfig);
    const destination = join(agent, "fitch-mcp-adapter", "mcp.json");
    const independent = '{"mcpServers":{"new":{"command":"unused-new-server"}}}';
    write(destination, independent);
    const { migrateLegacyState } = await import("../legacy-migration.ts");
    for (let run = 0; run < 2; run++) {
      expect(migrateLegacyState({ cwd: project }).files[0].status).toBe("existing");
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
    const result = migrateLegacyState({ cwd: project, dryRun: true });
    expect(result.files.filter((file) => file.status === "would-copy")).toHaveLength(2);
    expect(result.credentials).toEqual([]);
    expect(existsSync(join(agent, "fitch-mcp-adapter"))).toBe(false);
    expect(existsSync(join(project, ".pi", "fitch-mcp-adapter"))).toBe(false);
  });

  it("imports configured legacy plaintext credentials once without deleting or falling back to them", async () => {
    write(join(agent, "mcp.json"), '{"mcpServers":{"oauth":{"url":"https://example.com/mcp"}}}');
    const account = `sha256-${createHash("sha256").update("oauth").digest("hex")}`;
    const source = join(agent, "mcp-oauth", account, "tokens.json");
    const entry = { serverUrl: "https://example.com/mcp", tokens: { accessToken: "legacy-token", refreshToken: "legacy-refresh" } };
    write(source, JSON.stringify(entry));

    const { migrateLegacyState } = await import("../legacy-migration.ts");
    const { getAuthEntry, clearAllCredentials } = await import("../mcp-auth.ts");
    expect(migrateLegacyState({ cwd: project }).credentials).toEqual([{ server: "oauth", status: "copied" }]);
    expect(getAuthEntry("oauth")).toEqual(entry);
    expect(migrateLegacyState({ cwd: project }).credentials).toEqual([{ server: "oauth", status: "existing" }]);
    clearAllCredentials("oauth");
    expect(getAuthEntry("oauth")).toBeUndefined();
    expect(JSON.parse(readFileSync(source, "utf8"))).toEqual(entry);
  });
});
