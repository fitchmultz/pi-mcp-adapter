import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUnsafe } from "typebox";
import type { McpExtensionState } from "./state.ts";
import type { McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpConfig } from "./types.ts";

export interface McpAdapterHost {
  readonly state: McpExtensionState | null;
  readonly owner: McpRuntimeOwner | null;
  readonly initPromise: Promise<McpExtensionState> | null;
  readonly config: McpConfig;
  readonly configPath: string | undefined;
  readonly programmaticConfig: boolean;
  readonly directToolsFrozen: boolean;
  syncToolSurface: () => void;
  applyDirectToolConfigChanges: (changes: Map<string, true | string[] | false>) => void;
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
