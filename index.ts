import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpAdapterOptions } from "./types.ts";
import { cloneMcpConfig } from "./config.ts";
import { McpHostRuntime } from "./host-runtime.ts";

export type {
  McpAdapterOptions,
  McpOperationContext,
  McpToolCallEvent,
  McpToolCallIdentity,
} from "./types.ts";
export {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  type McpServerRuntimeStatus,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
} from "./types.ts";

export function createMcpAdapter(options: McpAdapterOptions = {}): (pi: ExtensionAPI) => void {
  const factoryConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
  return function mcpAdapter(pi: ExtensionAPI) {
    const runtime = new McpHostRuntime(pi, {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.outputDirectory !== undefined
        ? { outputDirectory: options.outputDirectory }
        : {}),
      ...(factoryConfig !== undefined ? { config: cloneMcpConfig(factoryConfig) } : {}),
      ...(options.beforeExecute ? { beforeExecute: options.beforeExecute } : {}),
      ...(options.transformConfig ? { transformConfig: options.transformConfig } : {}),
      ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    });
    runtime.install();
  };
}

export default createMcpAdapter();
