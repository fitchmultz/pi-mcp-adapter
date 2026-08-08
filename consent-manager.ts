import { logger } from "./logger.ts";

export class ConsentManager {
  private decisions = new Map<string, boolean>();
  private log = logger.child({ component: "ConsentManager" });

  requiresPrompt(serverName: string): boolean {
    return this.decisions.get(serverName) !== true;
  }

  registerDecision(serverName: string, approved: boolean): void {
    this.decisions.set(serverName, approved);
    this.log.debug(`Consent ${approved ? "granted" : "denied"}`, { server: serverName });
  }

  ensureApproved(serverName: string): void {
    const decision = this.decisions.get(serverName);
    if (decision === true) return;
    throw new Error(decision === false
      ? `Tool calls for "${serverName}" were denied for this session`
      : `Tool call approval required for "${serverName}"`);
  }
}
