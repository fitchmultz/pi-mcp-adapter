import { type ToolMetadata, isServerDisabled } from "./types.ts";
import type { ServerConnection } from "./server-manager.ts";
import type { McpExtensionState } from "./state.ts";
import { type ProxyToolResult, disabledResult } from "./proxy-result.ts";
import { paginate } from "./search-ranking.ts";
import { truncateAtWord } from "./utils.ts";
const INSTRUCTIONS_PREVIEW_LENGTH = 300;

interface EmptyList {
  server: string;
  metadata: ToolMetadata[] | undefined;
  connection: ServerConnection | undefined;
  instructions: string | undefined;
  instructionsText: string;
}
function emptyListResult({
  server,
  metadata,
  connection,
  instructions,
  instructionsText,
}: EmptyList): ProxyToolResult {
  if (connection?.status === "connected") {
    return {
      content: [
        { type: "text" as const, text: `Server "${server}" has no tools.${instructionsText}` },
      ],
      details: {
        mode: "list",
        server,
        tools: [],
        count: 0,
        hasInstructions: Boolean(instructions),
      },
    };
  }
  if (metadata !== undefined) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${server}" has no cached tools (not connected).${instructionsText}`,
        },
      ],
      details: {
        mode: "list",
        server,
        tools: [],
        count: 0,
        cached: true,
        hasInstructions: Boolean(instructions),
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Server "${server}" is configured but not connected. Use mcp({ action: "connect", server: "${server}" }) or /mcp reconnect ${server} to retry.${instructionsText}`,
      },
    ],
    details: {
      mode: "list",
      server,
      tools: [],
      count: 0,
      error: "not_connected",
      hasInstructions: Boolean(instructions),
    },
  };
}
function instructionPreview(instructions: string | undefined, server: string): string {
  if (instructions === undefined || instructions.length === 0) {
    return "";
  }
  const preview = truncateAtWord(instructions, INSTRUCTIONS_PREVIEW_LENGTH);
  const more =
    preview !== instructions
      ? `\nUse mcp({ action: "instructions", server: "${server}" }) for the full text.`
      : "";
  return `\n\nServer instructions:\n${preview}${more}`;
}
function formatListPage(
  page: ReturnType<typeof paginate<ToolMetadata>>,
  {
    connection,
    server,
    offset,
    limit,
    instructionsText,
  }: {
    connection: ServerConnection | undefined;
    server: string;
    offset: number;
    limit: number;
    instructionsText: string;
  },
): string {
  const cachedNote = connection?.status === "connected" ? "" : ", not connected, cached";
  let text = `${server} (${page.total} tools${cachedNote}):\n\n`;

  for (const tool of page.items) {
    const description = truncateAtWord(tool.description, 50);
    text += `- ${tool.name}`;
    if (description.length > 0) {
      text += ` - ${description}`;
    }
    text += "\n";
  }
  const first = (Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0) + 1;
  text += page.hasMore
    ? `\n${first}-${first + page.items.length - 1} of ${page.total} — mcp({ action: "list", server: ${JSON.stringify(server)}, limit: ${limit}, offset: ${String(page.nextOffset)} }) for more`
    : `\n${first}-${first + page.items.length - 1} of ${page.total} — end`;
  return text + instructionsText;
}

export function executeList(
  state: McpExtensionState,
  server: string,
  limit = 12,
  offset = 0,
): ProxyToolResult {
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${server}" not found. Use mcp({ action: "status" }) to see available servers (load it first with mcp_search({ enable: ["gateway"] }) if inactive).`,
        },
      ],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("list", server);
  }

  const metadata = state.toolMetadata
    .get(server)
    ?.filter((tool) => (tool.resourceUri ?? "").length === 0);
  const connection = state.manager.getConnection(server);
  const instructions = state.serverInstructions.get(server);
  const instructionsText = instructionPreview(instructions, server);

  if (metadata === undefined || metadata.length === 0) {
    return emptyListResult({ server, metadata, connection, instructions, instructionsText });
  }

  const page = paginate(metadata, offset, limit);
  if (page.items.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No tools at offset ${offset}; "${server}" has ${page.total} tools. Retry with mcp({ action: "list", server: ${JSON.stringify(server)}, limit: ${limit}, offset: 0 }).`,
        },
      ],
      details: {
        mode: "list",
        error: "offset_out_of_range",
        server,
        tools: [],
        count: page.total,
        hasMore: false,
        nextOffset: null,
        hasInstructions: Boolean(instructions),
      },
    };
  }

  const text = formatListPage(page, { connection, server, offset, limit, instructionsText });

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "list",
      server,
      tools: page.items.map((tool) => tool.name),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      hasInstructions: Boolean(instructions),
    },
  };
}

export function executeInstructions(state: McpExtensionState, server: string): ProxyToolResult {
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Server "${server}" not found. Use mcp({ action: "status" }) to see available servers (load it first with mcp_search({ enable: ["gateway"] }) if inactive).`,
        },
      ],
      details: { mode: "instructions", server, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) {
    return disabledResult("instructions", server);
  }

  const instructions = state.serverInstructions.get(server);
  if (instructions !== undefined && instructions.length > 0) {
    return {
      content: [{ type: "text" as const, text: `${server} instructions:\n\n${instructions}` }],
      details: { mode: "instructions", server, length: instructions.length },
    };
  }

  const connection = state.manager.getConnection(server);
  if (connection?.status === "connected") {
    return {
      content: [
        { type: "text" as const, text: `Server "${server}" does not provide instructions.` },
      ],
      details: { mode: "instructions", server, error: "no_instructions" },
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `No instructions cached for "${server}". Use mcp({ action: "connect", server: "${server}" }) to connect and refresh.`,
      },
    ],
    details: { mode: "instructions", server, error: "not_connected" },
  };
}
