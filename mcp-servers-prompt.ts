import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { asObjectRecord } from "./mcp-output-values.ts";
import { isServerCacheValid, loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig, type ServerEntry } from "./types.ts";
import { truncateAtWord } from "./utils.ts";

/** System prompt section tag matching Pi's built-in MCP extension. */
export const MCP_SERVERS_SECTION = "mcp_servers";

/** Character cap per server summary in `<mcp_servers>`, matching Pi and Codex deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;

/** Total character cap for `<mcp_servers>` (and per-server loaded instructions), matching Pi's built-in MCP extension. */
export const MAX_SERVERS_SECTION_CHARS = 4096;

function firstLineSummary(text: string | undefined): string {
  if (text === undefined) {
    return "";
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return "";
  }
  const line = trimmed.split(/\r?\n/, 1)[0] ?? "";
  return line.replace(/\s+/g, " ").trim();
}

function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return maxChars <= 1 ? "" : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function serverSummary(
  serverName: string,
  definition: ServerEntry,
  instructions: ReadonlyMap<string, string>,
  cache: MetadataCache | null,
): string {
  const configured = firstLineSummary(definition.description);
  if (configured !== "") {
    return configured;
  }
  const liveInstructions = firstLineSummary(instructions.get(serverName));
  if (liveInstructions !== "") {
    return liveInstructions;
  }
  const cached = cache?.servers[serverName];
  if (cached && isServerCacheValid(cached, definition)) {
    return firstLineSummary(cached.instructions);
  }
  return "";
}

function serversSectionIntro(disableProxyTool: boolean): string {
  if (disableProxyTool) {
    return "Configured MCP servers. Load deferred tools with `tool_search` or call them from `codemode`.";
  }
  return "Configured MCP servers. Load deferred tools with `tool_search`, call them from `codemode`, or inspect servers with `mcp`.";
}

function omittedLine(count: number): string[] {
  return count > 0
    ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with \`tool_search\``]
    : [];
}

/**
 * Render a cache-stable `<mcp_servers>` prompt section listing enabled servers in sorted order
 * with their one-line description or concise instructions summary. Excludes volatile connection
 * status, tool counts, and timestamps so prompt prefixes stay stable across turns and reconnects.
 */
export function renderMcpServersSection(
  config: McpConfig,
  instructions: ReadonlyMap<string, string>,
  cache: MetadataCache | null,
): string | undefined {
  const listed = Object.entries(config.mcpServers)
    .filter(([, definition]) => !isServerDisabled(definition))
    .sort(([left], [right]) => left.localeCompare(right));
  if (listed.length === 0) {
    return undefined;
  }

  const intro = serversSectionIntro(config.settings?.disableProxyTool === true);
  const heads = listed.map(([name]) => `- ${name}`);
  const size = (kept: number) =>
    [intro, ...heads.slice(0, kept), ...omittedLine(listed.length - kept)].join("\n").length;

  let kept = listed.length;
  while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) {
    kept -= 1;
  }

  // Reserve two characters per line for the ": " separator before each summary.
  const perServer =
    kept === 0
      ? 0
      : Math.min(
          MAX_SERVER_DESCRIPTION_CHARS,
          Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2,
        );

  const lines = listed.slice(0, kept).map(([name, definition], index) => {
    const head = heads[index] ?? `- ${name}`;
    if (perServer <= 0) {
      return head;
    }
    const summary = truncateLine(serverSummary(name, definition, instructions, cache), perServer);
    return summary !== "" ? `${head}: ${summary}` : head;
  });

  return [intro, ...lines, ...omittedLine(listed.length - kept)].join("\n");
}

/**
 * Format concise per-server instructions for servers whose tools were just loaded by `tool_search`.
 */
export function formatLoadedServerInstructions(
  servers: readonly string[],
  instructions: ReadonlyMap<string, string>,
  disableProxyTool: boolean,
): string | undefined {
  const blocks: string[] = [];
  for (const server of servers) {
    const text = instructions.get(server)?.trim();
    if (text === undefined || text === "") {
      continue;
    }
    const preview = truncateAtWord(text, MAX_SERVERS_SECTION_CHARS);
    const more =
      preview !== text && !disableProxyTool
        ? `\nUse mcp({ action: "instructions", server: ${JSON.stringify(server)} }) for the full text.`
        : "";
    blocks.push(`Server instructions (${server}):\n${preview}${more}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * Write or clear `sections.mcp_servers` on a `before_agent_start` event while preserving
 * any built-in Pi MCP section when both extensions coexist.
 */
export function applyMcpServersSection(
  event: { readonly systemPromptOptions?: { readonly sections?: Record<string, string> } },
  section: string | undefined,
  builtinActive: boolean,
): void {
  const sections = event.systemPromptOptions?.sections;
  if (!sections) {
    return;
  }
  if (section !== undefined) {
    const existing = sections[MCP_SERVERS_SECTION];
    sections[MCP_SERVERS_SECTION] =
      builtinActive && existing !== undefined && existing !== ""
        ? `${existing}\n\n${section}`
        : section;
    return;
  }
  if (!builtinActive) {
    delete sections[MCP_SERVERS_SECTION];
  }
}

interface SurfaceOptions {
  readonly serverForTool: (name: string) => string | undefined;
  readonly instructions: ReadonlyMap<string, string>;
  readonly surfaced: Set<string>;
  readonly disableProxyTool: boolean;
}

function collectFreshInstructionServers(loaded: unknown[], options: SurfaceOptions): string[] {
  const servers = new Set<string>();
  for (const name of loaded) {
    if (typeof name !== "string") {
      continue;
    }
    const server = options.serverForTool(name);
    if (server !== undefined && !options.surfaced.has(server)) {
      servers.add(server);
    }
  }
  return [...servers]
    .filter((server) => (options.instructions.get(server)?.trim() ?? "") !== "")
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Append concise server instructions once per server when `tool_search` loads MCP tools.
 */
export function surfaceLoadedServerInstructions(
  event: ToolResultEvent,
  options: SurfaceOptions,
): ToolResultEventResult | undefined {
  const loaded = asObjectRecord(event.details)?.loaded;
  if (!Array.isArray(loaded) || loaded.length === 0) {
    return undefined;
  }
  const freshServers = collectFreshInstructionServers(loaded, options);
  if (freshServers.length === 0) {
    return undefined;
  }
  const text = formatLoadedServerInstructions(
    freshServers,
    options.instructions,
    options.disableProxyTool,
  );
  if (text === undefined) {
    return undefined;
  }
  for (const server of freshServers) {
    options.surfaced.add(server);
  }
  return { content: [...event.content, { type: "text", text }] };
}

const EMPTY_INSTRUCTIONS: ReadonlyMap<string, string> = new Map();

/**
 * Tracks cache-stable `<mcp_servers>` rendering and one-shot `tool_search` server instructions
 * across turns, session resets, and `freezeDirectTools` snapshots.
 */
export class McpServersPromptState {
  private readonly surfaced = new Set<string>();
  private frozenSection: string | undefined;
  private frozenCaptured = false;

  clearSurfaced(): void {
    this.surfaced.clear();
  }

  resetFrozen(keepFrozen: boolean): void {
    if (!keepFrozen) {
      this.frozenSection = undefined;
      this.frozenCaptured = false;
    }
  }

  resetAll(): void {
    this.surfaced.clear();
    this.frozenSection = undefined;
    this.frozenCaptured = false;
  }

  applyBeforeAgentStart(
    event: { readonly systemPromptOptions?: { readonly sections?: Record<string, string> } },
    context: {
      readonly state: McpExtensionState | null;
      readonly fallbackConfig: McpConfig;
      readonly cacheEnabled: boolean;
      readonly frozen: boolean;
      readonly builtinActive: boolean;
    },
  ): void {
    const section = this.resolveSection(context);
    applyMcpServersSection(event, section, context.builtinActive);
  }

  private resolveSection(context: {
    readonly state: McpExtensionState | null;
    readonly fallbackConfig: McpConfig;
    readonly cacheEnabled: boolean;
    readonly frozen: boolean;
  }): string | undefined {
    if (context.frozen && this.frozenCaptured) {
      return this.frozenSection;
    }
    const section = renderMcpServersSection(
      context.state?.config ?? context.fallbackConfig,
      context.state?.serverInstructions ?? EMPTY_INSTRUCTIONS,
      context.state ? null : loadMetadataCache(context.cacheEnabled),
    );
    if (context.frozen) {
      this.frozenSection = section;
      this.frozenCaptured = true;
    }
    return section;
  }

  surfaceToolResult(
    event: ToolResultEvent,
    context: {
      readonly serverForTool: (name: string) => string | undefined;
      readonly state: McpExtensionState | null;
    },
  ): ToolResultEventResult | undefined {
    if (event.toolName !== "tool_search" || event.isError || !context.state) {
      return undefined;
    }
    return surfaceLoadedServerInstructions(event, {
      serverForTool: context.serverForTool,
      instructions: context.state.serverInstructions,
      surfaced: this.surfaced,
      disableProxyTool: context.state.config.settings?.disableProxyTool === true,
    });
  }
}
