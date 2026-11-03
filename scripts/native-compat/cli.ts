import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createMcpAdapter } from "@fitchmultz/pi-mcp-adapter";
import { VERSION, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixtureProvider, fixtureStream, type FixtureCall } from "./model.ts";
import { installPolicy } from "./policy.ts";

export default function nativeCli(pi: ExtensionAPI): void {
  const url = process.env.PI_NATIVE_URL;
  const identity = process.env.PI_NATIVE_IDENTITY;
  assert.ok(url !== undefined && url !== "", "native CLI requires its fixture URL");
  assert.ok(identity !== undefined && identity !== "", "native CLI requires its identity path");
  pi.on("session_start", () => {
    writeFileSync(identity, JSON.stringify({ version: VERSION, root: getPackageDir() }));
  });
  createMcpAdapter({
    config: {
      mcpServers: { local: { url, auth: false } },
      settings: { sampling: false, elicitation: false },
    },
  })(pi);
  installPolicy(pi);
  const steps: FixtureCall[] = [
    { name: "mcp_search", arguments: { query: "echo", server: "local" } },
    ...["coded-cli", "fail", "redact", "blocked"].map((value) => ({
      name: "codemode",
      arguments: { code: `return await tools.local_echo({value:${JSON.stringify(value)}});` },
    })),
  ];
  let stage = 0;
  pi.registerProvider("fixture", {
    ...fixtureProvider(url),
    streamSimple(model) {
      const call = steps[stage++];
      return fixtureStream(model, call, `cli-${stage}`);
    },
  });
}
