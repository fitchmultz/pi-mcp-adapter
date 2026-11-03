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
// Object schemas emit declared keys before the user's other keys, so the document
// passes through a schema without declared keys and the server map is validated at
// its own path, then spread back into its original position.
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

/** @returns {Promise<{ [key: string]: unknown; mcpServers?: Record<string, unknown> | null | undefined } | undefined>} */
export async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf-8");
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    const config = jsonObjectSchema.parse(parsed);
    return { ...config, ...serversFieldSchema.parse(config) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}
