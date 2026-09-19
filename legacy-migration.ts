import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAdapterPath, getAgentPath } from "./agent-dir.ts";
import { getProjectPiConfigPath, loadMcpConfig, resolveConfiguredOAuthDir } from "./config.ts";
import { migrateLegacyAuthEntry } from "./mcp-auth.ts";

interface FileMigration {
  source: string;
  destination: string;
  status: "absent" | "existing" | "would-copy" | "copied";
}

/** Run explicitly before starting v5. Never overwrite a destination or remove a source. */
export function migrateLegacyState({ cwd = process.cwd(), dryRun = false }: { cwd?: string; dryRun?: boolean } = {}) {
  const paths = ["mcp.json", "mcp-cache.json", "mcp-onboarding.json", "mcp-npx-cache.json"]
    .map((name) => ({ source: getAgentPath(name), destination: getAdapterPath(name) }));
  paths.push({ source: resolve(cwd, ".pi", "mcp.json"), destination: getProjectPiConfigPath(cwd) });

  const files: FileMigration[] = paths.map(({ source, destination }) => {
    if (!existsSync(source)) return { source, destination, status: "absent" };
    if (existsSync(destination)) return { source, destination, status: "existing" };
    if (dryRun) return { source, destination, status: "would-copy" };
    const contents = readFileSync(source);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { source, destination, status: "existing" };
      throw error;
    }
    if (!readFileSync(destination).equals(contents)) throw new Error(`Failed to verify migrated file: ${destination}`);
    return { source, destination, status: "copied" };
  });

  const credentials: Array<{ server: string; status: ReturnType<typeof migrateLegacyAuthEntry> }> = [];
  if (!dryRun) {
    const config = loadMcpConfig(undefined, cwd);
    const legacyDirectory = process.env.MCP_OAUTH_DIR?.trim()
      || resolveConfiguredOAuthDir(config.settings?.oauthDir, cwd)
      || getAgentPath("mcp-oauth");
    for (const [server, definition] of Object.entries(config.mcpServers)) {
      if (typeof definition.url !== "string") continue;
      credentials.push({ server, status: migrateLegacyAuthEntry(server, legacyDirectory) });
    }
  }
  return { files, credentials };
}
