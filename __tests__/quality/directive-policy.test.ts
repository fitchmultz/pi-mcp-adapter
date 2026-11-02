import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../../scripts/check-directives.mjs", import.meta.url));
const lintConfig = fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url));
const linter = fileURLToPath(new URL("../../node_modules/.bin/oxlint", import.meta.url));
const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const compilerConfig = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
const negativeTest = "__tests__/fixtures/published-types-consumer.test-d.mts";
const dirs: string[] = [];

function checkSource(file: string, source: string, sites: unknown[] = []) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "adapter-directives-")));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), source);
  writeFileSync(join(cwd, "quality-exceptions.json"), JSON.stringify(sites));
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(
    join(cwd, "docs/quality-exceptions.md"),
    "## QX-001: Native transport observation\n## QX-009: Forward captured failures\n",
  );
  return { ...spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" }), cwd };
}

function nativeLint(cwd: string) {
  symlinkSync(modules, join(cwd, "node_modules"), "junction");
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify({
      extends: compilerConfig,
      compilerOptions: { rootDir: cwd },
      files: ["forward.ts"],
      include: [],
    }),
  );
  return spawnSync(linter, ["--deny-warnings", "--config", lintConfig, "forward.ts"], {
    cwd,
    encoding: "utf8",
  });
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
        "/* notes\n oxlint-disable no-debugger */",
        "/*\n * eslint-disable no-debugger\n */",
        "/** @ts-ignore\n * not a TypeScript directive */",
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
    ["JSDoc ignore", "src.ts", "/** @ts-ignore */\nfoo();\n", "TypeScript error suppression"],
    ["JSDoc glued", "src.ts", "/**@ts-ignore*/\nfoo();\n", "TypeScript error suppression"],
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
    [
      "JSDoc negative in implementation",
      "src.ts",
      "/** @ts-expect-error no description */\nfoo();\n",
      "restricted to approved type tests",
    ],
    [
      "JSDoc short description",
      negativeTest,
      "/** @ts-expect-error short */\nfoo();\n",
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

  it("finds a TypeScript directive at the end of a multiline JSDoc comment", () => {
    const result = checkSource("block.ts", "/**\n * @ts-ignore */\nfoo();\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("block.ts:2: TypeScript error suppression");
  });

  it("fails if a maintained source cannot be parsed", () => {
    const result = checkSource("broken.ts", "const = ;");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("broken.ts: parse error:");
  });
});

const site = {
  id: "QX-009",
  file: "forward.ts",
  rule: "typescript/only-throw-error",
  scope: { type: "FunctionDeclaration", name: "forward" },
  path: ["body", "body", 0],
  nodeType: "ThrowStatement",
  operation: "throw error;",
  guards: [],
};
const directive =
  "// oxlint-disable-next-line typescript/only-throw-error -- QX-009: preserve the captured failure.";
const forward = `export function forward(error: unknown): never {\n${directive}\nthrow error;\n}\n`;
const sendDirective =
  "// oxlint-disable-next-line eslint/no-param-reassign -- QX-001: observe native sends.";
const transportSource = `export function forward(transport: { send: (value: number) => number; close: (value: number) => number }): typeof transport {\n${sendDirective}\ntransport.send = (value) => value + 1;\nreturn transport;\n}\n`;

describe("operation-bound exceptions", () => {
  it.each([
    {
      name: "stored failure",
      source: forward,
      authorized: site,
      neighbor: `${forward}export function unrelated(error: unknown): never {\nthrow error;\n}\n`,
      diagnostic: "forward.ts:6:7: error typescript(only-throw-error)",
    },
    {
      name: "transport send assignment",
      source: transportSource,
      authorized: {
        ...site,
        id: "QX-001",
        rule: "eslint/no-param-reassign",
        path: ["body", "body", 0, "expression", "left"],
        nodeType: "MemberExpression",
        operation: "transport.send",
      },
      neighbor: transportSource.replace(
        "return transport;",
        "transport.close = (value) => value + 1;\nreturn transport;",
      ),
      diagnostic: "forward.ts:4:1: error eslint(no-param-reassign)",
    },
  ])(
    "qualifies $name attachment and neighboring native protection",
    ({ source, authorized, neighbor, diagnostic }) => {
      const accepted = checkSource("forward.ts", source, [authorized]);
      const unguarded = checkSource("forward.ts", neighbor, [authorized]);
      const nativeAccepted = nativeLint(accepted.cwd);
      const nativeRejected = nativeLint(unguarded.cwd);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(unguarded.status, unguarded.stderr).toBe(0);
      expect(nativeAccepted.status, nativeAccepted.stdout + nativeAccepted.stderr).toBe(0);
      expect(nativeRejected.status).toBe(1);
      expect(nativeRejected.stdout + nativeRejected.stderr).toContain(diagnostic);
    },
  );

  it.each([
    ["another file", "copied.ts", forward],
    ["another function", "forward.ts", forward.replace("function forward", "function unrelated")],
    [
      "another operation with the same directive count",
      "forward.ts",
      forward.replace("throw error;", "throw 42;"),
    ],
    [
      "another rule",
      "forward.ts",
      forward.replace("typescript/only-throw-error", "eslint/no-console"),
    ],
    ["another decision", "forward.ts", forward.replace("QX-009:", "QX-099:")],
    [
      "a range disable",
      "forward.ts",
      forward.replace("oxlint-disable-next-line", "oxlint-disable"),
    ],
    [
      "a blank line before the operation",
      "forward.ts",
      forward.replace("throw error;", "\nthrow error;"),
    ],
    [
      "a duplicate operation",
      "forward.ts",
      forward.replace("throw error;", `throw error;\n${directive}\nthrow error;`),
    ],
  ])("rejects %s", (_name, file, source) => {
    const result = checkSource(file, source, [site]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not authorized|scope is missing|operation changed/u);
  });

  it("rejects a stale site without a directive", () => {
    const result = checkSource("forward.ts", forward.replace(`${directive}\n`, ""), [site]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unused exception site QX-009");
  });

  it("rejects a changed enclosing condition even when operation and path are unchanged", () => {
    const guarded = {
      ...site,
      path: ["body", "body", 0, "consequent", "body", 0],
      guards: ["consequent: true"],
    };
    const source = `export function forward(error: unknown): never {\nif (false) {\n${directive}\nthrow error;\n}\nthrow error;\n}\n`;
    const result = checkSource("forward.ts", source, [guarded]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorized operation changed");
  });
});
