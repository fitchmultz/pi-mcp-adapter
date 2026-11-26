import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  formatToolName,
  resolveToolPrefix,
  type ServerEntry,
  type ToolMetadata,
  type ToolPrefix,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

export type ProxyToolResult = AgentToolResult<Record<string, unknown>>;
export type ProxyToolUpdateCallback = AgentToolUpdateCallback<Record<string, unknown>>;

export function emitProxyUpdate(
  onUpdate: ProxyToolUpdateCallback | undefined,
  text: string,
  details: Record<string, unknown>,
): void {
  if (!onUpdate) {
    return;
  }
  const sanitized = sanitizeTerminalText(text);
  if (sanitized === "") {
    return;
  }
  onUpdate({ content: [{ type: "text", text: sanitized }], details });
}

export function disabledResult(mode: string, serverName: string): ProxyToolResult {
  const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName} and /reload to enable it.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: { mode, error: "server_disabled", server: serverName, message },
  };
}

export function resourcesDisabledResult(serverName: string, resourceUri: string): ProxyToolResult {
  return {
    content: [{ type: "text", text: `Resources are disabled for server "${serverName}".` }],
    details: { mode: "call", error: "resources_disabled", server: serverName, resourceUri },
  };
}

export function dynamicResourceTarget(
  serverName: string,
  uri: string,
  definition: ServerEntry | undefined,
  globalPrefix: ToolPrefix | undefined,
): ToolMetadata {
  const originalName = "read_resource";
  const prefix = resolveToolPrefix(definition, globalPrefix);
  return {
    name: formatToolName(originalName, serverName, prefix),
    originalName,
    description: `Read resource: ${uri}`,
    resourceUri: uri,
  };
}
