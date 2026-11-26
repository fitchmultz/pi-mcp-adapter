import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
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
