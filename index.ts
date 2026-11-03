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
  const { defaultScriptTimeoutMs } = options;
  if (
    defaultScriptTimeoutMs !== undefined &&
    defaultScriptTimeoutMs !== null &&
    (!Number.isInteger(defaultScriptTimeoutMs) ||
      defaultScriptTimeoutMs < 1 ||
      defaultScriptTimeoutMs > 2_147_483_647)
  ) {
    throw new RangeError("defaultScriptTimeoutMs must be an integer from 1 to 2147483647, or null");
  }
  const factoryConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
  return function mcpAdapter(pi: ExtensionAPI) {
    const runtime = new McpHostRuntime(pi, {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(defaultScriptTimeoutMs !== undefined ? { defaultScriptTimeoutMs } : {}),
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
