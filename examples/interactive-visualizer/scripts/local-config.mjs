import { readFile } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

function getAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim() ?? "";
  if (configured === "") {
    return path.join(homedir(), ".pi", "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return path.resolve(homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

const root = fileURLToPath(new URL("../", import.meta.url));
export const distServer = path.join(root, "dist", "server.js");
export const configPath = path.join(getAgentDir(), "fitch-mcp-adapter", "mcp.json");
export const serverName = "interactive-visualizer";

/**
 * The example is independently runnable, so it uses native SQLite rather than importing
 * the adapter. Its sidecar matches the adapter's persistent config-writer lock.
 * @param {() => Promise<void>} operation
 */
export async function mutateConfig(operation) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const database = new DatabaseSync(`${path.resolve(configPath)}.lock.sqlite`);
  try {
    chmodSync(`${path.resolve(configPath)}.lock.sqlite`, 0o600);
    database.exec("BEGIN EXCLUSIVE");
    await operation();
  } finally {
    database.close();
  }
}

// These commands own one entry, not validation of unrelated server definitions.
// Object schemas return a copy that omits an own "__proto__" key, so the commands
// rewrite the parsed objects themselves. The schemas report a malformed document or
// server map at its path.
const jsonObjectSchema = z.looseObject({});
const serversFieldSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).nullish() });
const installedEntrySchema = z.looseObject({
  command: z.literal(process.execPath),
  args: z.tuple([z.literal(distServer)]).rest(z.unknown()),
});

/** @param {unknown} entry @returns {boolean} */
export function isInstalledExample(entry) {
  return installedEntrySchema.safeParse(entry).success;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @returns {Promise<{ [key: string]: unknown; mcpServers?: Record<string, unknown> | null | undefined } | undefined>} */
export async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf-8");
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    const config = isJsonObject(parsed) ? parsed : jsonObjectSchema.parse(parsed);
    const { mcpServers } = config;
    return {
      ...config,
      mcpServers:
        mcpServers === undefined || mcpServers === null || isJsonObject(mcpServers)
          ? mcpServers
          : serversFieldSchema.parse(config).mcpServers,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
