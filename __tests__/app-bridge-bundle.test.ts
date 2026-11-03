import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("reproduces the committed standalone bridge with the host's Apps v2 API", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-bridge-bundle-"));
  try {
    const output = join(dir, "app-bridge.mjs");
    execFileSync(process.execPath, [join(root, "scripts/build-app-bridge.mjs"), output], {
      cwd: root,
    });
    expect(readFileSync(output, "utf8")).toBe(
      readFileSync(join(root, "app-bridge.bundle.js"), "utf8"),
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          join(root, "__tests__/fixtures/app-bridge-bundle-loader.mjs"),
          join(root, "__tests__/fixtures/app-bridge-bundle-probe.ts"),
        ],
        { cwd: root, env: { ...process.env, MCP_TEST_BRIDGE_BUNDLE: output } },
      ),
    ).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
