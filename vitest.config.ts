import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const defaultTestAgentDir = mkdtempSync(join(tmpdir(), "pi-mcp-vitest-agent-"));
process.on("exit", () => {
  rmSync(defaultTestAgentDir, { recursive: true, force: true });
});

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
      PI_CODING_AGENT_DIR: defaultTestAgentDir,
    },
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test-d.ts"],
    coverage: {
      provider: "v8",
      include: ["*.ts"],
      exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
    },
  },
});
