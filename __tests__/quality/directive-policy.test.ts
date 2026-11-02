import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../../scripts/check-directives.mjs", import.meta.url));
const negativeTest = "__tests__/fixtures/published-types-consumer.test-d.mts";
const dirs: string[] = [];

function checkSource(file: string, source: string) {
  const cwd = mkdtempSync(join(tmpdir(), "adapter-directives-"));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), source);
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("directive policy", () => {
  it("permits literal examples and a described directive in the negative type fixture", () => {
    const literals = checkSource(
      "literal.ts",
      [
        'const text = "// oxlint-disable-next-line example";',
        "const regex = /https?:\\/\\//;",
        'const template = `// @ts-ignore ${regex.test("https://example.com")}`;',
      ].join("\n"),
    );
    const negative = checkSource(
      negativeTest,
      '// @ts-expect-error A string is not assignable to a number.\nconst number: number = "x";\n',
    );
    expect(literals.status, literals.stderr).toBe(0);
    expect(negative.status, negative.stderr).toBe(0);
  });

  it.each([
    [
      "oxlint",
      "src.ts",
      "// oxlint-disable-next-line no-console -- QX-001: reason\nfoo();\n",
      "lint directive",
    ],
    ["eslint", "src.ts", "/* eslint-disable no-console */\nfoo();\n", "lint directive"],
    ["ignore", "src.ts", "// @ts-ignore reason\nfoo();\n", "TypeScript error suppression"],
    ["triple-slash", "src.ts", "/// @ts-ignore reason\nfoo();\n", "TypeScript error suppression"],
    ["ignore suffix", "src.ts", "// @ts-ignoreXYZ\nfoo();\n", "TypeScript error suppression"],
    ["nocheck", "src.ts", "// @ts-nocheck\nfoo();\n", "TypeScript error suppression"],
    [
      "negative in implementation",
      "src.ts",
      "// @ts-expect-error mismatch\nfoo();\n",
      "restricted to approved type tests",
    ],
    [
      "short description",
      negativeTest,
      "// @ts-expect-error short\nfoo();\n",
      "at least ten characters",
    ],
    [
      "glued description",
      negativeTest,
      "// @ts-expect-errorThisIsNotADescription\nfoo();\n",
      "at least ten characters",
    ],
  ])("rejects %s", (_name, file, source, diagnostic) => {
    const result = checkSource(file, source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:1:`);
    expect(result.stderr).toContain(diagnostic);
  });

  it("finds a real directive inside a template expression", () => {
    const result = checkSource(
      "template.ts",
      "const text = `${(() => {\n// @ts-ignore mismatch\nreturn 1;\n})()}`;\n",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("template.ts:2: TypeScript error suppression");
  });

  it("finds a TypeScript directive at the end of a block comment", () => {
    const result = checkSource("block.ts", "/* notes\n @ts-ignore */\nfoo();\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("block.ts:2: TypeScript error suppression");
  });

  it("fails if a maintained source cannot be parsed", () => {
    const result = checkSource("broken.ts", "const = ;");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("broken.ts: parse error:");
  });
});
