import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAdapterPath, getAgentPath } from "./agent-dir.ts";
import { loadMcpConfig, resolveConfiguredOAuthDir } from "./config.ts";
import { getAuthStorageOptions, migrateLegacyAuthEntry } from "./mcp-auth.ts";
import { resolveServerUrl } from "./utils.ts";

interface FileMigration {
  source: string;
  destination: string;
  status: "absent" | "existing" | "would-copy" | "copied";
}

/** Preserve historical sources and existing destinations; consume current OAuth sources only after verified promotion. */
export interface CredentialMigration {
  server: string;
  status: Awaited<ReturnType<typeof migrateLegacyAuthEntry>> | "error";
  error?: string;
}

export async function migrateLegacyState({
  cwd = process.cwd(),
  dryRun = false,
}: { cwd?: string; dryRun?: boolean } = {}): Promise<{
  files: FileMigration[];
  credentials: CredentialMigration[];
}> {
  const paths = ["mcp.json", "mcp-cache.json", "mcp-onboarding.json", "mcp-npx-cache.json"].map(
    (name) => ({ source: getAgentPath(name), destination: getAdapterPath(name) }),
  );

  const files: FileMigration[] = paths.map(({ source, destination }) => {
    if (!existsSync(source)) {
      return { source, destination, status: "absent" };
    }
    if (existsSync(destination)) {
      return { source, destination, status: "existing" };
    }
    if (dryRun) {
      return { source, destination, status: "would-copy" };
    }
    const contents = readFileSync(source);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return { source, destination, status: "existing" };
      }
      throw error;
    }
    if (!readFileSync(destination).equals(contents)) {
      throw new Error(`Failed to verify migrated file: ${destination}`);
    }
    return { source, destination, status: "copied" };
  });

  const credentials = dryRun ? [] : await migrateLegacyCredentials(cwd);
  return { files, credentials };
}

async function migrateSingleServerCredential(input: {
  server: string;
  definition: ReturnType<typeof loadMcpConfig>["mcpServers"][string];
  legacyDirectory: string;
  authStorageOptions: ReturnType<typeof getAuthStorageOptions>;
}): Promise<CredentialMigration | null> {
  const { server, definition, legacyDirectory, authStorageOptions } = input;
  try {
    const serverUrl = resolveServerUrl(definition);
    if (serverUrl === undefined) {
      return null;
    }
    const status = await migrateLegacyAuthEntry(
      { serverName: server, serverUrl },
      legacyDirectory,
      authStorageOptions,
    );
    return { server, status };
  } catch (error) {
    return {
      server,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function migrateLegacyCredentials(cwd: string): Promise<CredentialMigration[]> {
  const credentials: CredentialMigration[] = [];
  const config = loadMcpConfig(undefined, cwd);
  const envLegacyDirectory = process.env.MCP_OAUTH_DIR?.trim();
  const legacyDirectory =
    envLegacyDirectory !== undefined && envLegacyDirectory !== ""
      ? envLegacyDirectory
      : (resolveConfiguredOAuthDir(config.settings?.oauthDir, cwd) ?? getAgentPath("mcp-oauth"));
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);
  for (const [server, definition] of Object.entries(config.mcpServers)) {
    const migrated = await migrateSingleServerCredential({
      server,
      definition,
      legacyDirectory,
      authStorageOptions,
    });
    if (migrated !== null) {
      credentials.push(migrated);
    }
  }
  return credentials;
}
