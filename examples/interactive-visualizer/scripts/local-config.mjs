import { readFile } from "node:fs/promises";
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

// These commands own one entry, not validation of unrelated server definitions.
const configSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).nullish(),
});
const installedEntrySchema = z.looseObject({
  command: z.literal(process.execPath),
  args: z.tuple([z.literal(distServer)]).rest(z.unknown()),
});

/** @param {unknown} entry @returns {boolean} */
export function isInstalledExample(entry) {
  return installedEntrySchema.safeParse(entry).success;
}

/** @returns {Promise<z.infer<typeof configSchema> | undefined>} */
export async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf-8");
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    return configSchema.parse(parsed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
