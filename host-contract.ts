import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUnsafe } from "typebox";
import type { McpExtensionState } from "./state.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpConfig } from "./types.ts";

export interface LiveServerToggleResult {
  readonly applied: boolean;
  readonly outcome?: "disabled" | "connected" | "needs-auth" | "failed";
  readonly toolCount?: number;
  readonly errorMessage?: string;
}

export interface McpAdapterHost {
  readonly state: McpExtensionState | null;
  readonly owner: McpRuntimeOwner | null;
  readonly initPromise: Promise<McpExtensionState> | null;
  readonly config: McpConfig;
  readonly configPath: string | undefined;
  readonly programmaticConfig: boolean;
  readonly directToolsFrozen: boolean;
  syncToolSurface: () => void;
  consumePendingSkillReload?: () => boolean;
  applyDirectToolConfigChanges: (changes: Map<string, true | string[] | false>) => void;
  setServerDisabled: (
    serverName: string,
    disabled: boolean,
    ctx: ExtensionContext,
  ) => Promise<LiveServerToggleResult>;
  syncWorkingDirectory: (ctx: ExtensionContext) => Promise<void>;
  ensureCommandState: (
    owner: McpRuntimeOwner | null,
    ctx: ExtensionContext,
  ) => Promise<McpExtensionState | null>;
  getToolState: (signal?: AbortSignal) => Promise<
    | McpExtensionState
    | {
        content: Array<{ type: "text"; text: string }>;
        details: { error: string; message?: string; timeoutMs?: number };
      }
  >;
}

export type HostToolExecute<Params> = ToolDefinition<
  TUnsafe<Params>,
  Record<string, unknown>,
  unknown
>["execute"];

export type HostToolArguments<Params> = Parameters<HostToolExecute<Params>>;

const BUILTIN_MCP_EXTENSION_PATH = "builtin:mcp";
const MCP_COMMAND_NAME_PATTERN = /^mcp(?::\d+)?$/;

/**
 * Detect whether another Pi MCP extension (either `builtin:mcp` or an inline
 * SDK `createMcpExtension()` factory) is coexisting alongside this adapter.
 * In the Pi CLI, `builtin:mcp` is `replaceable: true` and yields automatically
 * to the adapter; in SDK hosts that add `createMcpExtension()` directly, both
 * extensions load and produce two `/mcp` extension commands (`mcp:1`, `mcp:2`).
 * When another MCP extension is active, the adapter skips `<project>/.pi/mcp.json`
 * so configured servers are never started twice.
 */
export function isBuiltinMcpActive(pi: Pick<ExtensionAPI, "getCommands"> | undefined): boolean {
  if (typeof pi?.getCommands !== "function") {
    return false;
  }
  const commands = pi.getCommands();
  if (commands.some((command) => command.sourceInfo.path === BUILTIN_MCP_EXTENSION_PATH)) {
    return true;
  }
  const mcpExtensionCommands = commands.filter(
    (command) => command.source === "extension" && MCP_COMMAND_NAME_PATTERN.test(command.name),
  );
  return mcpExtensionCommands.length > 1;
}

export function nativePiConfigOptions(
  pi: Pick<ExtensionAPI, "getCommands"> | undefined,
): { readonly includeNativePi: false } | undefined {
  return isBuiltinMcpActive(pi) ? { includeNativePi: false } : undefined;
}
