import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** Adapter-owned state lives under the Pi agent directory; Pi owns how that directory resolves. */
export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

export function getAdapterPath(...segments: string[]): string {
  return getAgentPath("fitch-mcp-adapter", ...segments);
}
