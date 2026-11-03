import { KNOWN_SERVER_PRESETS, type McpDiscoverySummary } from "./config.ts";
import type { Action, Screen } from "./mcp-setup-contract.ts";
function repoPromptActions(discovery: McpDiscoverySummary): Action[] {
  const actions: Action[] = [];
  if (
    !discovery.repoPrompt.configured &&
    (discovery.repoPrompt.executablePath ?? "").length > 0 &&
    (discovery.repoPrompt.targetPath ?? "").length > 0 &&
    discovery.repoPrompt.entry &&
    (discovery.repoPrompt.serverName ?? "").length > 0
  ) {
    actions.push({
      id: "add-repoprompt",
      label: "Add RepoPrompt to shared MCP config",
      description:
        "Write a standard MCP entry for RepoPrompt to the recommended shared target, then reload MCP in-session.",
    });
  }

  return actions;
}

export function getSetupActions(discovery: McpDiscoverySummary, screen: Screen): Action[] {
  const actions: Action[] = [];
  if (screen === "empty") {
    actions.push({
      id: "run-setup",
      label: "Run setup",
      description: "Inspect detected configs, adopt imports, and scaffold a minimal `.mcp.json`.",
    });
  }
  if (discovery.imports.length > 0) {
    actions.push({
      id: "adopt-imports",
      label: "Adopt detected compatibility imports",
      description: `Choose which host-specific MCP configs Pi should import into its own override file. ${discovery.imports.length} source${discovery.imports.length === 1 ? "" : "s"} found.`,
    });
  }
  actions.push({
    id: "view-example",
    label: "View example `.mcp.json`",
    description: "Preview a working shared MCP config you can paste or adapt.",
  });
  if (!discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
    actions.push({
      id: "scaffold-project",
      label: "Scaffold project `.mcp.json`",
      description:
        "Write a minimal project config using the standard shared MCP file path, then reload Pi.",
    });
  }
  actions.push({
    id: "show-precedence",
    label: "Explain config precedence",
    description: "Show the read order and where Pi writes compatibility settings.",
  });
  if (getDetectedPaths(discovery).length > 0) {
    actions.push({
      id: "open-paths",
      label: "Open detected config paths",
      description: "Browse the actual config files that Pi discovered on this machine.",
    });
  }
  for (const preset of KNOWN_SERVER_PRESETS) {
    actions.push({
      id: "add-known-server",
      label: preset.name,
      description: preset.summary,
      preset,
    });
  }
  actions.push(...repoPromptActions(discovery));
  actions.push({ id: "close", label: "Close", description: "Exit the onboarding flow." });
  return actions;
}

export function getDetectedPaths(discovery: McpDiscoverySummary): string[] {
  const paths = [
    ...discovery.sources.filter((source) => source.exists).map((source) => source.path),
    ...discovery.imports.map((entry) => entry.path),
  ];
  return [...new Set(paths)];
}
