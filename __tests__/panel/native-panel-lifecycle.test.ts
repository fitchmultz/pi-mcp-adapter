import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("owns native panel rejection and disposes closed overlays", async () => {
  const result = await execute(
    process.execPath,
    [fileURLToPath(new URL("../fixtures/panel-native-lifecycle.ts", import.meta.url))],
    {
      env: { ...process.env, PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" },
      timeout: 30_000,
    },
  );
  expect(result.stdout).toContain("NATIVE_PANEL_LIFECYCLE_PASS");
}, 35_000);
