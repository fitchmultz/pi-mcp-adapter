#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import stripJsonComments from "strip-json-comments";
import { z } from "zod";

const HOME = os.homedir();

/** @param {string} input @returns {string} */
function expandHome(input) {
  if (input === "~") {
    return HOME;
  }
  if (input.startsWith("~/")) {
    return path.resolve(HOME, input.slice(2));
  }
  return path.resolve(input);
}

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim() ?? "";
const AGENT_DIR =
  configuredAgentDir !== "" ? expandHome(configuredAgentDir) : path.join(HOME, ".pi", "agent");
const PI_CONFIG_PATH = path.join(AGENT_DIR, "fitch-mcp-adapter", "mcp.json");
const GENERIC_GLOBAL_CONFIG_PATH = path.join(HOME, ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATH = path.join(HOME, ".agents", "mcp.json");
const AGENTS_NESTED_GLOBAL_CONFIG_PATH = path.join(HOME, ".agents", "mcp", "mcp.json");
const PROJECT_CONFIG_PATH = path.resolve(process.cwd(), ".mcp.json");
const PROJECT_PI_CONFIG_PATH = path.resolve(process.cwd(), ".pi", "fitch-mcp-adapter", "mcp.json");

const IMPORT_PATHS = {
  cursor: [path.join(HOME, ".cursor", "mcp.json")],
  "claude-code": [
    path.join(HOME, ".claude", "mcp.json"),
    path.join(HOME, ".claude.json"),
    path.join(HOME, ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [
    path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ],
  codex: [path.join(HOME, ".codex", "config.toml"), path.join(HOME, ".codex", "config.json")],
  opencode: [
    path.join(HOME, ".config", "opencode", "opencode.json"),
    path.resolve(process.cwd(), "opencode.json"),
  ],
  windsurf: [path.join(HOME, ".windsurf", "mcp.json")],
  vscode: [path.resolve(process.cwd(), ".vscode", "mcp.json")],
};

function printHelp(log = console.log) {
  log("Fitch MCP Adapter helper\n");
  log("Install the package with:");
  log("  pi install npm:@fitchmultz/pi-mcp-adapter\n");
  log("Then optionally run:");
  log("  fitch-mcp-adapter init       Detect host configs and scaffold Pi imports");
  log("  fitch-mcp-adapter init --dry-run");
  log("  fitch-mcp-adapter init --discover-host-configs  Opt in to host config fallback discovery");
  log("  fitch-mcp-adapter migrate [--dry-run]  Copy pre-v5 state without changing its sources");
}

// Init edits only imports and the discovery setting. Keep other config values
// intact; full server validation belongs to the runtime config loader. Object
// schemas return a copy that omits an own "__proto__" key, so init rewrites the
// parsed objects themselves. The schemas report a malformed document or settings
// container at its path.
const jsonObjectSchema = z.looseObject({});
const settingsFieldSchema = z.object({ settings: jsonObjectSchema.nullish() });
const importsSchema = z.array(z.unknown());

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @typedef {{
 *   [key: string]: unknown;
 *   mcpServers: Record<string, unknown>;
 *   imports?: string[] | undefined;
 *   settings?: Record<string, unknown> | null | undefined;
 * }} PiConfig
 */

/** @returns {PiConfig} */
function loadPiConfig() {
  if (!fs.existsSync(PI_CONFIG_PATH)) {
    return { mcpServers: {} };
  }

  /** @type {unknown} */
  const parsed = JSON.parse(
    stripJsonComments(fs.readFileSync(PI_CONFIG_PATH, "utf-8"), { trailingCommas: true }),
  );
  const raw = isJsonObject(parsed) ? parsed : jsonObjectSchema.parse(parsed);
  const { settings: rawSettings } = raw;
  const settings =
    rawSettings === undefined || rawSettings === null || isJsonObject(rawSettings)
      ? rawSettings
      : settingsFieldSchema.parse(raw).settings;
  const servers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!isJsonObject(servers)) {
    throw new Error(
      `Invalid MCP config at ${PI_CONFIG_PATH}: expected "mcpServers" to be an object`,
    );
  }

  const normalized = { ...raw };
  delete normalized["mcp-servers"];

  const imports = importsSchema.safeParse(raw.imports);
  // Assigned last: an added settings key follows the existing keys and imports.
  return {
    ...normalized,
    mcpServers: servers,
    imports: imports.success
      ? imports.data.filter((value) => typeof value === "string")
      : undefined,
    settings,
  };
}

function findAvailableImports() {
  const found = [];

  for (const [kind, candidates] of Object.entries(IMPORT_PATHS)) {
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    if (existing !== undefined) {
      found.push({ kind, path: existing });
    }
  }

  return found;
}

/** @param {(line: string) => void} log @param {{ kind: string; path: string }[]} imports */
function printDiscovery(log, imports) {
  log("Config discovery:\n");

  const paths = {
    "User-global standard MCP": GENERIC_GLOBAL_CONFIG_PATH,
    "User-global .agents MCP": AGENTS_GLOBAL_CONFIG_PATH,
    "User-global .agents nested MCP": AGENTS_NESTED_GLOBAL_CONFIG_PATH,
    "Pi global override": PI_CONFIG_PATH,
    "Project standard MCP": PROJECT_CONFIG_PATH,
    "Project Pi override": PROJECT_PI_CONFIG_PATH,
  };

  for (const [label, filePath] of Object.entries(paths)) {
    const prefix = fs.existsSync(filePath) ? "✓" : "-";
    log(`${prefix} ${label}: ${filePath}`);
  }

  log("\nCompatibility imports:\n");
  if (imports.length === 0) {
    log("- No host-specific MCP configs detected");
    return;
  }

  for (const entry of imports) {
    log(`✓ ${entry.kind}: ${entry.path}`);
  }
}

/**
 * @param {PiConfig} config
 * @param {string[]} importsToAdd
 * @param {boolean} discoverHostConfigs
 */
function extendPiConfig(config, importsToAdd, discoverHostConfigs) {
  return {
    ...config,
    ...(discoverHostConfigs ? { settings: { ...config.settings, hostConfigDiscovery: "on" } } : {}),
    ...(importsToAdd.length > 0 ? { imports: [...new Set(config.imports), ...importsToAdd] } : {}),
  };
}

/** @param {string[]} argv @param {(line: string) => void} [log] */
async function runInit(argv, log = console.log) {
  const dryRun = argv.includes("--dry-run");
  const discoverHostConfigs = argv.includes("--discover-host-configs");
  const foundImports = findAvailableImports();
  const existingConfig = loadPiConfig();
  const existingImports = new Set(existingConfig.imports);
  const importsToAdd = foundImports
    .map((entry) => entry.kind)
    .filter((kind) => !existingImports.has(kind));

  printDiscovery(log, foundImports);

  const discoverySettingChanged =
    discoverHostConfigs && existingConfig.settings?.hostConfigDiscovery !== "on";
  if (importsToAdd.length === 0 && !discoverySettingChanged) {
    log("\nNo Pi config changes needed.");
    log(
      "Standard MCP configs are discovered automatically, and host-specific imports are already configured or unavailable.",
    );
    return 0;
  }

  if (importsToAdd.length > 0) {
    log(`\nDetected host configs to import into Pi: ${importsToAdd.join(", ")}`);
  }
  if (discoverySettingChanged) {
    log(
      "Opting in to host-specific fallback discovery (standard and Pi-owned configs still take precedence).",
    );
  }

  if (dryRun) {
    log(`Dry run: would update ${PI_CONFIG_PATH}`);
    return 0;
  }

  const { withConfigWrite, writeRawConfigObject } = await import("./dist/config-file.js");
  withConfigWrite(PI_CONFIG_PATH, () => {
    const current = loadPiConfig();
    const currentImports = new Set(current.imports);
    const additions = foundImports
      .map((entry) => entry.kind)
      .filter((kind) => !currentImports.has(kind));
    writeRawConfigObject(PI_CONFIG_PATH, extendPiConfig(current, additions, discoverHostConfigs));
  });
  log(`Updated ${PI_CONFIG_PATH}`);
  log(
    "Pi will now keep reading standard MCP configs automatically, while these imports cover host-specific config formats.",
  );
  if (discoverySettingChanged) {
    log(
      "Host config discovery is explicit and does not write to or execute commands from external host files.",
    );
  }
  return 0;
}

/** @param {string[]} argv @param {(line: string) => void} log */
async function runMigration(argv, log) {
  const { migrateLegacyState } = await import("./dist/legacy-migration.js");
  const dryRun = argv.includes("--dry-run");
  const result = migrateLegacyState({ dryRun });
  for (const file of result.files) {
    log(`${file.status}: ${file.source} -> ${file.destination}`);
  }
  for (const credential of result.credentials) {
    log(`OAuth ${credential.server}: ${credential.status}`);
  }
  log(
    dryRun
      ? "Dry run: no files changed and no credential store accessed."
      : "Migration complete. Historical sources and existing destinations were preserved. Matching current OAuth sources are removed after verified promotion. Restart Pi to use the independent adapter.",
  );
  return 0;
}

/**
 * @param {string[]} [argv]
 * @param {(line: string) => void} [log]
 * @param {(line: string) => void} [error]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), log = console.log, error = console.error) {
  const [command = "", ...rest] = argv;

  switch (command) {
    case "":
    case "help":
    case "--help":
    case "-h":
      printHelp(log);
      return 0;
    case "install":
      error("The custom downloader has been retired.");
      error(
        "Use `pi install npm:@fitchmultz/pi-mcp-adapter` instead, then optionally run `fitch-mcp-adapter init`.",
      );
      return 1;
    case "init":
      return runInit(rest, log);
    case "migrate":
      return runMigration(rest, log);
    default:
      error(`Unknown command: ${command}`);
      printHelp(log);
      return 1;
  }
}

const entrypoint = process.argv[1] ?? "";
const resolvedEntrypoint = entrypoint !== "" ? fs.realpathSync(entrypoint) : undefined;
const isEntrypoint =
  resolvedEntrypoint !== undefined && import.meta.url === pathToFileURL(resolvedEntrypoint).href;

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((/** @type {unknown} */ err) => {
      console.error(`\nHelper failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
