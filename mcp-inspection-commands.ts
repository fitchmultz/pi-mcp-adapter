import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import {
  getPiGlobalWriteTarget,
  inspectMcpConfigSnapshot,
  type BlockedServerInfo,
  type LoadMcpConfigOptions,
  type McpDiscoverySummary,
} from "./config.ts";
import { loadOnboardingState } from "./onboarding-state.ts";
import {
  isServerDisabled,
  type McpConfig,
  type McpConfigValidationError,
  type PromptMetadata,
  type ServerProvenance,
} from "./types.ts";
import { estimateToolTokens, formatTokenCount } from "./tool-metadata.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import { inspectionStatus, serverStage } from "./server-status.ts";
import { sanitizeTerminalText } from "./utils.ts";

export interface PanelNoticeInput {
  readonly discoverySummary?: McpDiscoverySummary;
  readonly errors?: readonly McpConfigValidationError[];
  readonly blockedServers?: readonly BlockedServerInfo[];
}

export interface PanelNoticesResult {
  readonly noticeLines: string[];
  readonly sharedConfigHintShown: boolean;
}

function formatSharedConfigNotice(
  discovery: McpDiscoverySummary | undefined,
  sharedConfigHintShownBefore: boolean,
): string[] {
  if (!discovery || !discovery.hasSharedServers || sharedConfigHintShownBefore) {
    return [];
  }
  const sharedSources = discovery.sources.filter(
    (source) => source.kind === "shared" && source.serverCount > 0,
  );
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return [
    `Using standard MCP config from ${sourceList}.`,
    "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
  ];
}

function formatConfigErrorNotices(errors: readonly McpConfigValidationError[]): string[] {
  const lines = errors.slice(0, 3).map((err) => {
    const scope = [err.serverName, err.field].filter(Boolean).join(".");
    const loc = scope.length > 0 ? `${err.filePath} (${scope})` : err.filePath;
    return `Config ${err.severity}: ${sanitizeTerminalText(loc)} — ${sanitizeTerminalText(err.message)}`;
  });
  if (errors.length > 3) {
    lines.push(`… +${errors.length - 3} more config issues (run /mcp doctor)`);
  }
  return lines;
}

function resolveNoticeInputs(
  configOverridePath: string | undefined,
  cwd: string,
  discoveryOptions:
    | Pick<LoadMcpConfigOptions, "includeNativePi" | "includeNativePiProject">
    | undefined,
  precomputed: PanelNoticeInput | undefined,
): {
  discovery: McpDiscoverySummary | undefined;
  errors: readonly McpConfigValidationError[];
  blocked: readonly BlockedServerInfo[];
} {
  if (precomputed?.discoverySummary !== undefined) {
    return {
      discovery: precomputed.discoverySummary,
      errors: precomputed.errors ?? [],
      blocked: precomputed.blockedServers ?? [],
    };
  }
  const snapshot = inspectMcpConfigSnapshot(configOverridePath, cwd, discoveryOptions);
  return {
    discovery: snapshot.discoverySummary,
    errors: precomputed?.errors ?? snapshot.errors,
    blocked: precomputed?.blockedServers ?? snapshot.blockedServers,
  };
}

export function buildPanelNotices(
  configOverridePath: string | undefined,
  cwd: string,
  discoveryOptions?: Pick<LoadMcpConfigOptions, "includeNativePi" | "includeNativePiProject">,
  precomputed?: PanelNoticeInput,
): PanelNoticesResult {
  const { discovery, errors, blocked } = resolveNoticeInputs(
    configOverridePath,
    cwd,
    discoveryOptions,
    precomputed,
  );
  const onboardingState = loadOnboardingState();
  const sharedLines = formatSharedConfigNotice(discovery, onboardingState.sharedConfigHintShown);
  const noticeLines = [...sharedLines, ...formatConfigErrorNotices(errors)];
  if (blocked.length > 0) {
    noticeLines.push(
      `Blocked (untrusted project): ${blocked.map((entry) => sanitizeTerminalText(entry.name)).join(", ")}`,
    );
  }
  return { noticeLines, sharedConfigHintShown: sharedLines.length > 0 };
}

export function buildSharedConfigNoticeLines(
  configOverridePath: string | undefined,
  cwd: string,
  discoveryOptions?: Pick<LoadMcpConfigOptions, "includeNativePi" | "includeNativePiProject">,
  precomputed?: PanelNoticeInput,
): string[] {
  return buildPanelNotices(configOverridePath, cwd, discoveryOptions, precomputed).noticeLines;
}

export function withFallbackServerProvenance(
  config: McpConfig,
  provenance: Map<string, ServerProvenance>,
  overridePath: string | undefined,
  cwd = process.cwd(),
): Map<string, ServerProvenance> {
  const { writePath, aliasesSharedProject } = getPiGlobalWriteTarget(overridePath, cwd);
  const kind = aliasesSharedProject ? "project" : "user";
  for (const serverName of Object.keys(config.mcpServers)) {
    if (!provenance.has(serverName)) {
      provenance.set(serverName, { path: writePath, kind });
    }
  }
  return provenance;
}

function statusLabel(state: McpExtensionState, name: string): ReturnType<typeof inspectionStatus> {
  const failedAgo = getFailureAgeSeconds(state, name);
  const stage = serverStage({
    definition: state.config.mcpServers[name],
    transport: state.manager.getConnection(name)?.status,
    failedAgoSeconds: failedAgo,
    catalogKnown: state.toolMetadata.get(name) !== undefined,
  });
  return inspectionStatus(stage, failedAgo, getFailureMessage(state, name));
}

function formatStatusToolSuffix(input: {
  hasMetadata: boolean;
  toolCount: number;
  resourceCount: number;
  skillCount: number;
  status: string;
}): string {
  const { hasMetadata, toolCount, resourceCount, skillCount, status } = input;
  if (!hasMetadata) {
    return " (undiscovered)";
  }
  const toolLabel = `${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  const resourceLabel = `${resourceCount} resource${resourceCount === 1 ? "" : "s"}`;
  const skillPart = skillCount > 0 ? `, ${skillCount} skill${skillCount === 1 ? "" : "s"}` : "";
  const cachedPart = status === "cached" ? ", cached" : "";
  return ` (${toolLabel}, ${resourceLabel}${skillPart}${cachedPart})`;
}

function serverStatusLine(state: McpExtensionState, name: string): string {
  const metadata = state.toolMetadata.get(name);
  const toolCount = metadata?.filter((tool) => tool.resourceUri === undefined).length ?? 0;
  const resourceCount = metadata?.filter((tool) => tool.resourceUri !== undefined).length ?? 0;
  const skillCount = state.skillMetadata?.get(name)?.length ?? 0;
  const { status, statusIcon, failed } = statusLabel(state, name);
  const toolSuffix = failed
    ? ""
    : formatStatusToolSuffix({
        hasMetadata: metadata !== undefined,
        toolCount,
        resourceCount,
        skillCount,
        status,
      });
  return `${statusIcon} ${name}: ${status}${toolSuffix}`;
}

function blockedStatusEntries(state: McpExtensionState, ctx: ExtensionContext) {
  if (state.programmaticConfig === true || ctx.isProjectTrusted()) {
    return [];
  }
  return inspectMcpConfigSnapshot(state.configPath, ctx.cwd, { includeProject: false })
    .blockedServers;
}

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const lines: string[] = ["MCP Server Status:", ""];
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    lines.push(
      isServerDisabled(definition)
        ? `⊘ ${name}: disabled (run /mcp enable ${name})`
        : serverStatusLine(state, name),
    );
  }

  const blocked = blockedStatusEntries(state, ctx).filter(
    (entry) => !(entry.name in state.config.mcpServers),
  );
  for (const entry of blocked) {
    lines.push(
      `⊘ ${sanitizeTerminalText(entry.name)}: blocked (${sanitizeTerminalText(entry.reason)})`,
    );
  }

  if (Object.keys(state.config.mcpServers).length === 0 && blocked.length === 0) {
    lines.push("No MCP servers configured");
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
  }

  const configErrors = state.configErrors ?? [];
  if (configErrors.length > 0) {
    lines.push("");
    lines.push(`Config validation issues (${configErrors.length} — run /mcp doctor for details):`);
    for (const err of configErrors.slice(0, 3)) {
      lines.push(`  • [${err.severity}] ${err.message}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function groupPromptLines(allPrompts: PromptMetadata[]): string[] {
  const lines: string[] = [];
  const grouped = new Map<string, PromptMetadata[]>();
  for (const prompt of allPrompts) {
    const list = grouped.get(prompt.serverName) ?? [];
    list.push(prompt);
    grouped.set(prompt.serverName, list);
  }
  for (const [serverName, prompts] of [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`${serverName}:`);
    for (const prompt of prompts.sort((a, b) => a.commandName.localeCompare(b.commandName))) {
      const args = prompt.arguments
        .map((argument) =>
          argument.required === true ? `<${argument.name}>` : `[${argument.name}]`,
        )
        .join(" ");
      lines.push(`  /${prompt.commandName}${args.length > 0 ? ` ${args}` : ""}`);
      if (prompt.description.length > 0) {
        lines.push(`      ${prompt.description}`);
      }
    }
    lines.push("");
  }

  return lines;
}

export async function showPrompts(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }
  const allPrompts = [...state.promptMetadata.values()].flat();
  const failedPromptServers = [...state.manager.getAllConnections()]
    .filter(
      ([, connection]) =>
        connection.status === "connected" && connection.promptDiscoveryFailed === true,
    )
    .map(([serverName]) => serverName)
    .sort();
  if (allPrompts.length === 0) {
    const failureNote =
      failedPromptServers.length > 0
        ? ` Prompt discovery failed for: ${failedPromptServers.join(", ")}.`
        : "";
    ctx.ui.notify(
      `No MCP prompts available. Prompts are discovered when servers with the \`prompts\` capability connect.${failureNote}`,
      "info",
    );
    return;
  }
  const lines = ["MCP Prompts:", ""];
  lines.push(...groupPromptLines(allPrompts));
  lines.push(`Total: ${allPrompts.length} prompt${allPrompts.length === 1 ? "" : "s"}`);
  if (failedPromptServers.length > 0) {
    lines.push(
      `Prompt discovery failed for: ${failedPromptServers.join(", ")}. Cached prompt metadata may be stale.`,
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function validateToolsServerTarget(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer: string | undefined,
): boolean {
  if (targetServer === undefined || targetServer.length === 0) {
    return true;
  }
  const entry = state.config.mcpServers[targetServer];
  if (!entry) {
    ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    return false;
  }
  if (isServerDisabled(entry)) {
    ctx.ui.notify(
      `Server "${targetServer}" is disabled. Run /mcp enable ${targetServer}.`,
      "warning",
    );
    return false;
  }
  return true;
}

function collectDiscoveredServerTools(
  state: McpExtensionState,
  targetServer: string | undefined,
): Array<{
  serverName: string;
  tools: Array<{ name: string; tokens: number }>;
  serverTokens: number;
}> {
  const hasFilter = targetServer !== undefined && targetServer.length > 0;
  return [...state.toolMetadata.entries()]
    .filter(([serverName]) => {
      if (hasFilter && serverName !== targetServer) {
        return false;
      }
      return !isServerDisabled(state.config.mcpServers[serverName]);
    })
    .map(([serverName, metadata]) => {
      const tools = metadata
        .filter((tool) => tool.resourceUri === undefined)
        .map((tool) => ({ name: tool.name, tokens: estimateToolTokens(tool) }));
      return {
        serverName,
        tools,
        serverTokens: tools.reduce((sum, tool) => sum + tool.tokens, 0),
      };
    })
    .filter((entry) => entry.tools.length > 0);
}

export async function showTools(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string,
): Promise<void> {
  if (!ctx.hasUI || !validateToolsServerTarget(state, ctx, targetServer)) {
    return;
  }

  const serverEntries = collectDiscoveredServerTools(state, targetServer);
  const totalTools = serverEntries.reduce((sum, entry) => sum + entry.tools.length, 0);
  if (totalTools === 0) {
    const emptyMsg =
      targetServer !== undefined && targetServer.length > 0
        ? `No MCP tools discovered for "${targetServer}". Connect with mcp({ action: "connect", server: "${targetServer}" }).`
        : 'No MCP tools discovered. Connect a server with mcp({ action: "connect" }).';
    ctx.ui.notify(emptyMsg, "info");
    return;
  }

  const totalTokens = serverEntries.reduce((sum, entry) => sum + entry.serverTokens, 0);
  const lines = ["Discovered MCP Tools:", ""];
  for (const entry of serverEntries) {
    lines.push(
      `${entry.serverName} (${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}, ~${formatTokenCount(entry.serverTokens)} tokens):`,
    );
    for (const tool of entry.tools) {
      lines.push(`  ${tool.name} (~${formatTokenCount(tool.tokens)} tokens)`);
    }
  }
  lines.push("");
  lines.push(
    `Total: ${totalTools} tool${totalTools === 1 ? "" : "s"} (~${formatTokenCount(totalTokens)} tokens)`,
  );

  ctx.ui.notify(lines.join("\n"), "info");
}
