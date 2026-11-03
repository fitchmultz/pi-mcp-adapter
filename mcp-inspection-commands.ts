import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type PromptMetadata } from "./types.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import { sanitizeTerminalText } from "./utils.ts";
function statusLabel(
  state: McpExtensionState,
  name: string,
): { status: string; statusIcon: string; failed: boolean } {
  const connection = state.manager.getConnection(name);
  const metadata = state.toolMetadata.get(name);
  const failedAgo = getFailureAgeSeconds(state, name);
  let status = "not connected";
  let statusIcon = "○";
  let failed = false;

  if (connection?.status === "connected") {
    status = "connected";
    statusIcon = "✓";
  } else if (connection?.status === "needs-auth") {
    status = "needs auth";
    statusIcon = "⚠";
  } else if (failedAgo !== null) {
    const reason = sanitizeTerminalText(getFailureMessage(state, name) ?? "");
    status =
      reason.length > 0 ? `failed ${failedAgo}s ago — ${reason}` : `failed ${failedAgo}s ago`;
    statusIcon = "✗";
    failed = true;
  } else if (metadata !== undefined) {
    status = "cached";
  }

  return { status, statusIcon, failed };
}

function serverStatusLine(state: McpExtensionState, name: string): string {
  const metadata = state.toolMetadata.get(name);
  const toolCount = metadata?.filter((tool) => tool.resourceUri === undefined).length ?? 0;
  const resourceCount = metadata?.filter((tool) => tool.resourceUri !== undefined).length ?? 0;
  const { status, statusIcon, failed } = statusLabel(state, name);
  let toolSuffix = "";
  if (!failed) {
    toolSuffix =
      metadata === undefined
        ? " (undiscovered)"
        : ` (${toolCount} tool${toolCount === 1 ? "" : "s"}, ${resourceCount} resource${resourceCount === 1 ? "" : "s"}${status === "cached" ? ", cached" : ""})`;
  }
  return `${statusIcon} ${name}: ${status}${toolSuffix}`;
}

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const definition = state.config.mcpServers[name];
    if (isServerDisabled(definition)) {
      lines.push(`⊘ ${name}: disabled (run /mcp enable ${name}, then /reload)`);
      continue;
    }
    lines.push(serverStatusLine(state, name));
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
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

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const allTools = [...state.toolMetadata.entries()]
    .filter(([serverName]) => !isServerDisabled(state.config.mcpServers[serverName]))
    .flatMap(([, metadata]) =>
      metadata.filter((tool) => tool.resourceUri === undefined).map((tool) => tool.name),
    );

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools discovered. Use mcp_search to discover tools.", "info");
    return;
  }

  const lines = [
    "Discovered MCP Tools:",
    "",
    ...allTools.map((t) => `  ${t}`),
    "",
    `Total: ${allTools.length} tool${allTools.length === 1 ? "" : "s"}`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}
