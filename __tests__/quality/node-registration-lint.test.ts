import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const diagnostic = z.object({
  code: z.string(),
  filename: z.string(),
  labels: z.array(z.object({ span: z.object({ line: z.number() }) })).min(1),
});

describe("Node test registration lint allowance", () => {
  it("allows registrations without allowing floating subtests or other work", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-node-registration-lint-"));
    try {
      await Promise.all(
        [".oxlintrc.json", "tsconfig.json", "package.json"].map((file) =>
          copyFile(resolve(file), join(root, file)),
        ),
      );
      await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
      await mkdir(join(root, "scripts", "nested"), { recursive: true });
      await Promise.all([
        writeFile(
          join(root, "mcp-auth.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { describe as nodeDescribe, it as nodeIt } from "node:test";',
            'nodeDescribe("suite", () => {',
            '  nodeDescribe("nested", () => { nodeIt("nested test", () => { assert.equal(1, 1); }); });',
            '  nodeIt("inside suite", () => { assert.equal(1, 1); });',
            "});",
            'nodeIt("top-level", () => { assert.equal(1, 1); });',
            'nodeIt("unsafe work", (t) => {',
            '  t.test("subtest", () => { assert.equal(1, 1); });',
            '  fetch("https://example.test");',
            "});",
            'fetch("https://example.test");',
          ].join("\n"),
        ),
        writeFile(
          join(root, "mcp-auth-flow.test.ts"),
          [
            "function nodeIt(): Promise<void> { return Promise.resolve(); }",
            "nodeIt();",
            "function nodeDescribe(): Promise<void> { return Promise.resolve(); }",
            "nodeDescribe();",
          ].join("\n"),
        ),
        writeFile(
          join(root, "mcp-callback-server.test.ts"),
          [
            'import { nodeIt, nodeDescribe } from "./other.ts";',
            "nodeIt();",
            "nodeDescribe();",
          ].join("\n"),
        ),
        writeFile(
          join(root, "other.ts"),
          [
            "export function nodeIt(): Promise<void> { return Promise.resolve(); }",
            "export function nodeDescribe(): Promise<void> { return Promise.resolve(); }",
          ].join("\n"),
        ),
        writeFile(
          join(root, "outside.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { describe as nodeDescribe, it as nodeIt } from "node:test";',
            'nodeIt("outside scope", () => { assert.equal(1, 1); });',
            'nodeDescribe("outside scope", () => { assert.equal(1, 1); });',
          ].join("\n"),
        ),
        writeFile(
          join(root, "scripts", "mcp-auth.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { it as nodeIt } from "node:test";',
            'nodeIt("same filename outside scope", () => { assert.equal(1, 1); });',
          ].join("\n"),
        ),
        writeFile(
          join(root, "scripts", "nested", "mcp-auth.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import { describe as nodeDescribe } from "node:test";',
            'nodeDescribe("nested scope", () => { assert.equal(1, 1); });',
          ].join("\n"),
        ),
      ]);
      const result = spawnSync(
        process.execPath,
        [
          resolve("node_modules/oxlint/bin/oxlint"),
          "--format=json",
          "mcp-auth.test.ts",
          "mcp-auth-flow.test.ts",
          "mcp-callback-server.test.ts",
          "outside.test.ts",
          "scripts/mcp-auth.test.ts",
          "scripts/nested/mcp-auth.test.ts",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(1);
      const output = z
        .object({ diagnostics: z.array(diagnostic) })
        .parse(JSON.parse(result.stdout));
      const findings = output.diagnostics.map((entry) => ({
        code: entry.code,
        file: entry.filename.replaceAll("\\", "/"),
        line: entry.labels[0]?.span.line,
      }));
      expect(findings).toEqual(
        expect.arrayContaining([
          { code: "typescript(no-floating-promises)", file: "mcp-auth.test.ts", line: 9 },
          { code: "typescript(no-floating-promises)", file: "mcp-auth.test.ts", line: 10 },
          { code: "typescript(no-floating-promises)", file: "mcp-auth.test.ts", line: 12 },
          { code: "typescript(no-floating-promises)", file: "mcp-auth-flow.test.ts", line: 2 },
          { code: "typescript(no-floating-promises)", file: "mcp-auth-flow.test.ts", line: 4 },
          {
            code: "typescript(no-floating-promises)",
            file: "mcp-callback-server.test.ts",
            line: 2,
          },
          {
            code: "typescript(no-floating-promises)",
            file: "mcp-callback-server.test.ts",
            line: 3,
          },
          { code: "typescript(no-floating-promises)", file: "outside.test.ts", line: 3 },
          { code: "typescript(no-floating-promises)", file: "outside.test.ts", line: 4 },
          { code: "typescript(no-floating-promises)", file: "scripts/mcp-auth.test.ts", line: 3 },
          {
            code: "typescript(no-floating-promises)",
            file: "scripts/nested/mcp-auth.test.ts",
            line: 3,
          },
        ]),
      );
      expect(findings, JSON.stringify(findings)).toHaveLength(11);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
