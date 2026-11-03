import spawn from "cross-spawn";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

function repository(failing: string): string {
  const root = mkdtempSync(join(tmpdir(), "adapter-test-acceptance-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "__tests__"));
  for (const file of [
    "package.json",
    "vitest.config.ts",
    "scripts/check.mjs",
    "scripts/run-checks.mjs",
  ]) {
    copyFileSync(resolve(file), join(root, file));
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(
    join(root, "__tests__/probe.test.ts"),
    `import { expect, it } from "vitest";\nit("actual Vitest assertion", () => { expect(1).toBe(${failing === "vitest" ? 2 : 1}); });\n`,
  );
  for (const file of [
    "mcp-auth.test.ts",
    "mcp-auth-flow.test.ts",
    "mcp-callback-server.test.ts",
    "mcp-oauth-provider.test.ts",
  ]) {
    writeFileSync(
      join(root, file),
      `import assert from "node:assert/strict";\nimport { it as nodeIt } from "node:test";\nimport { writeFileSync } from "node:fs";\nnodeIt("actual Node assertion", () => { writeFileSync("${file}.ran", process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE ?? "unset"); assert.equal(1, ${failing === "node" ? 2 : 1}); });\n`,
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["vitest", "node", "neither"])(
  "propagates %s results through npm test without hiding independent Node assertions",
  (failing) => {
    const root = repository(failing);
    const result = spawn.sync("npm", ["test"], { cwd: root, encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(failing === "neither" ? 0 : 1);
    expect(result.stdout).toContain("[check] test:vitest: exit");
    expect(result.stdout).toContain("[check] test:oauth: exit");
    for (const file of [
      "mcp-auth.test.ts",
      "mcp-auth-flow.test.ts",
      "mcp-callback-server.test.ts",
      "mcp-oauth-provider.test.ts",
    ]) {
      expect(readFileSync(join(root, `${file}.ran`), "utf8")).toBe("memory");
    }
  },
);
