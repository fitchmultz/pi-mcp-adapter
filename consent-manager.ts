import type { McpConfig, McpUiToolConsent } from "./config-types.ts";
import { logger } from "./logger.ts";

export function resolveUiToolConsent(
  config: McpConfig | undefined,
  serverName: string,
): McpUiToolConsent {
  return (
    config?.mcpServers[serverName]?.uiToolConsent ??
    config?.settings?.uiToolConsent ??
    "once-per-server"
  );
}

export class ConsentManager {
  private readonly decisions = new Map<string, boolean>();
  private readonly log = logger.child({ component: "ConsentManager" });

  hasDecisions(): boolean {
    return this.decisions.size > 0;
  }

  requiresPrompt(serverName: string, policy: McpUiToolConsent = "once-per-server"): boolean {
    if (policy === "always" || policy === "never") {
      return false;
    }
    return this.decisions.get(serverName) !== true;
  }

  registerDecision(serverName: string, approved: boolean): void {
    this.decisions.set(serverName, approved);
    this.log.debug(`Consent ${approved ? "granted" : "denied"}`, { server: serverName });
  }

  clear(): void {
    this.decisions.clear();
  }

  ensureApproved(serverName: string, policy: McpUiToolConsent = "once-per-server"): void {
    if (policy === "always") {
      return;
    }
    if (policy === "never") {
      throw new Error(`Tool calls from UI are denied by configuration for "${serverName}"`);
    }
    const decision = this.decisions.get(serverName);
    if (decision === true) {
      return;
    }
    throw new Error(
      decision === false
        ? `Tool calls for "${serverName}" were denied for this session`
        : `Tool call approval required for "${serverName}"`,
    );
  }
}
