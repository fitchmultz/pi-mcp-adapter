import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const source = process.cwd();
const roots: string[] = [];
const recordSchema = z.record(z.string(), z.unknown());

function write(root: string, file: string, content: string): void {
  const destination = join(root, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "adapter-policy-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const file of [
    ".gitignore",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "package.json",
    "tsconfig.json",
    "tsconfig.declarations.json",
    "examples/interactive-visualizer/tsconfig.json",
    "docs/strict-quality-standard.md",
    "scripts/check-policy.mjs",
    "scripts/tsc.mjs",
  ]) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, file), destination);
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "junction");
  write(root, "cli.d.ts", "export {};\n");
  write(
    root,
    "__tests__/fixtures/android-keyring-binding.d.cts",
    "declare const binding: object; export = binding;\n",
  );
  write(root, "example.ts", "export const value = 1;\n");
  write(root, "examples/interactive-visualizer/src/example.ts", "export const value = 1;\n");
  return root;
}

function updateJson(
  root: string,
  file: string,
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): void {
  const path = join(root, file);
  const config = recordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, `${JSON.stringify(update(config), null, 2)}\n`);
}

function check(root: string) {
  return spawnSync(process.execPath, [resolve(root, "scripts/check-policy.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}

function lint(root: string, file: string) {
  return spawnSync(
    process.execPath,
    [join(root, "node_modules/oxlint/bin/oxlint"), "--deny-warnings", file],
    { cwd: root, encoding: "utf8" },
  );
}

function compile(root: string, project: string) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/tsc.mjs"), "--noEmit", "--project", project],
    { cwd: root, encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("quality policy", () => {
  it("accepts the adopted configuration and covered source", () => {
    const result = check(repository());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "category downgrade",
      (root: string) =>
        updateJson(root, ".oxlintrc.json", (config) => {
          const categories = recordSchema.parse(config.categories);
          return { ...config, categories: { ...categories, correctness: "warn" } };
        }),
      "Oxlint categories",
    ],
    [
      "profile rule disablement",
      (root: string) =>
        updateJson(root, ".oxlintrc.json", (config) => {
          const profiles = z.array(recordSchema).parse(config.overrides);
          const profile = profiles[0];
          if (profile === undefined) {
            throw new Error("missing test profile");
          }
          const rules = recordSchema.parse(profile.rules);
          return {
            ...config,
            overrides: [
              { ...profile, rules: { ...rules, "no-debugger": "off" } },
              ...profiles.slice(1),
            ],
          };
        }),
      "Oxlint overrides",
    ],
    [
      "nested config",
      (root: string) => write(root, "scripts/.oxlintrc.json", "{}\n"),
      "Unclassified nested quality configuration",
    ],
    [
      "lint ignore file",
      (root: string) => write(root, ".oxlintignore", "**/*.ts\n"),
      "Unclassified nested quality configuration",
    ],
    [
      "formatter exclusion",
      (root: string) =>
        updateJson(root, ".oxfmtrc.json", (config) => {
          const patterns = z.array(z.string()).parse(config.ignorePatterns);
          return { ...config, ignorePatterns: [...patterns, "**/*.ts"] };
        }),
      "Oxfmt configuration",
    ],
    [
      "compiler strictness",
      (root: string) =>
        updateJson(root, "tsconfig.json", (config) => {
          const options = recordSchema.parse(config.compilerOptions);
          return { ...config, compilerOptions: { ...options, strict: false } };
        }),
      "compilerOptions.strict",
    ],
    [
      "checked JavaScript",
      (root: string) =>
        updateJson(root, "examples/interactive-visualizer/tsconfig.json", (config) => {
          const options = recordSchema.parse(config.compilerOptions);
          return { ...config, compilerOptions: { ...options, checkJs: false } };
        }),
      "compilerOptions.checkJs",
    ],
    [
      "unchecked declarations",
      (root: string) =>
        updateJson(root, "tsconfig.declarations.json", (config) => {
          const options = recordSchema.parse(config.compilerOptions);
          return { ...config, compilerOptions: { ...options, skipLibCheck: true } };
        }),
      "compilerOptions.skipLibCheck",
    ],
    [
      "uncovered source",
      (root: string) => write(root, "uncovered/feature.ts", "export const value = 1;\n"),
      "Maintained source is absent from compiler projects",
    ],
    [
      "ignored source",
      (root: string) => {
        appendFileSync(join(root, ".gitignore"), "\nignored/\n");
        write(root, "ignored/feature.ts", "export const value = 1;\n");
      },
      "Unclassified ignored source",
    ],
    [
      "ignored quality config",
      (root: string) => {
        appendFileSync(join(root, ".gitignore"), "\n.oxlintignore\n");
        write(root, ".oxlintignore", "**/*.ts\n");
      },
      "Unclassified ignored source or quality configuration",
    ],
    [
      "uncovered declaration",
      (root: string) => write(root, "other.d.ts", "export {};\n"),
      "Declaration is absent from the declaration project",
    ],
  ])("rejects %s", (_name, mutate, diagnostic) => {
    const root = repository();
    mutate(root);
    const result = check(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it.each([
    ["base rule", "probe.ts", "debugger;\nexport const value = 1;\n", "no-debugger"],
    [
      "base rule in tests",
      "__tests__/quality/probe.test.ts",
      "debugger;\nexport const value = 1;\n",
      "no-debugger",
    ],
    [
      "category-only rule",
      "probe.ts",
      "export function value() { return 1; return 2; }\n",
      "no-unreachable",
    ],
    [
      "category-only rule in tests",
      "__tests__/quality/probe.test.ts",
      "export function value() { return 1; return 2; }\n",
      "no-unreachable",
    ],
    [
      "type-aware TypeScript rule",
      "probe.ts",
      "export function parse(text: string): string { return JSON.parse(text); }\n",
      "no-unsafe-return",
    ],
    [
      "type-aware JavaScript rule",
      "probe.mjs",
      "/** @param {string} text */\nexport function parse(text) { return JSON.parse(text).name; }\n",
      "no-unsafe-member-access",
    ],
    [
      "test framework rule",
      "__tests__/quality/probe.test.ts",
      'import { expect, it } from "vitest";\nit.only("probe", () => { expect(1).toBe(1); });\n',
      "vitest(no-focused-tests)",
    ],
  ])("enforces the composed %s", (_name, file, sourceText, diagnostic) => {
    const root = repository();
    write(root, file, sourceText);
    const result = lint(root, file);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(diagnostic);
  });

  it("leaves the framework profile off unrelated source", () => {
    const root = repository();
    const file = "probe.ts";
    write(
      root,
      file,
      'import { expect, it } from "vitest";\nit.only("probe", () => { expect(1).toBe(1); });\n',
    );
    const result = lint(root, file);
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts safe typed code in the base profile", () => {
    const root = repository();
    const file = "probe.ts";
    write(
      root,
      file,
      "export function parse(text: string): unknown { return JSON.parse(text); }\n",
    );
    const result = lint(root, file);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ["root TypeScript", "tsconfig.json", "probe.ts", 'export const value: number = "wrong";\n'],
    [
      "root JavaScript",
      "tsconfig.json",
      "probe.mjs",
      '/** @type {number} */\nexport const value = "wrong";\n',
    ],
    [
      "JavaScript beside a declaration",
      "tsconfig.json",
      "cli.js",
      '/** @type {number} */\nexport const value = "wrong";\n',
    ],
    [
      "example TypeScript",
      "examples/interactive-visualizer/tsconfig.json",
      "examples/interactive-visualizer/src/probe.ts",
      'export const value: number = "wrong";\n',
    ],
    [
      "handwritten declaration",
      "tsconfig.declarations.json",
      "cli.d.ts",
      "export declare const value: MissingType;\n",
    ],
  ])("checks errors in %s", (_name, project, file, sourceText) => {
    const root = repository();
    write(root, file, sourceText);
    const result = compile(root, project);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stdout).toContain(file);
    expect(result.stdout).toMatch(/TS(?:2322|2304)/u);
  });
});
