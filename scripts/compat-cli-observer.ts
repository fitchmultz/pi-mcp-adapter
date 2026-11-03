import { writeFileSync } from "node:fs";
import { VERSION, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CliObservation } from "./compat-consumer-results.mjs";

export default function observeConsumer(pi: ExtensionAPI): void {
  const marker = process.env.PI_COMPAT_OBSERVATION;
  if (marker === undefined || marker === "") {
    throw new Error("compat-cli-observer: PI_COMPAT_OBSERVATION is required");
  }
  pi.on("session_start", (_event, ctx) => {
    const observation: CliObservation = {
      version: VERSION,
      packageDir: getPackageDir(),
      tools: pi.getAllTools().map((tool) => tool.name),
      activeTools: pi.getActiveTools(),
      commands: pi.getCommands().map((command) => command.name),
    };
    writeFileSync(marker, JSON.stringify(observation));
    ctx.shutdown();
  });
}
