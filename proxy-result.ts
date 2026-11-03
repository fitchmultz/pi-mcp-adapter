import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
export type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

export function disabledResult(mode: string, serverName: string): ProxyToolResult {
  const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName} and /reload to enable it.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: { mode, error: "server_disabled", server: serverName, message },
  };
}
