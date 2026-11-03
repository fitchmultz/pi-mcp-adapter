import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const QUALITY_AGGREGATE_TIMEOUT_MS = 30_000;

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
    ".github/workflows/ci.yml",
    "tsconfig.json",
    "tsconfig.build.json",
    "tsconfig.declarations.json",
    "examples/interactive-visualizer/tsconfig.json",
    "docs/strict-quality-standard.md",
    "docs/quality-exceptions.md",
    "scripts/check-policy.mjs",
    "scripts/check-directives.mjs",
    "scripts/quality-exceptions.mjs",
    "scripts/check.mjs",
    "scripts/run-checks.mjs",
    "scripts/typecheck-all.mjs",
    "scripts/tsc.mjs",
    "scripts/generate-metadata-cache-schema.mts",
    "metadata-cache-validator.ts",
    "scripts/build-host-browser.mjs",
    "host-browser.bundle.js",
    "ui-stream-types.ts",
    ...readdirSync(source).filter((name) => /^host-browser-.*\.ts$/u.test(name)),
  ]) {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, file), destination);
  }
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "junction");
  write(root, "cli.d.ts", "export declare const version: string;\n");
  write(
    root,
    "__tests__/fixtures/android-keyring-binding.d.cts",
    "declare const binding: object; export = binding;\n",
  );
  write(root, "example.ts", "export const value = 1;\n");
  write(root, "quality-exceptions.json", "[]\n");
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
    [join(root, "node_modules/oxlint/bin/oxlint"), "--deny-warnings", "--format=agent", file],
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

function quality(root: string) {
  return spawnSync(process.execPath, [join(root, "scripts/check.mjs"), "quality"], {
    cwd: root,
    encoding: "utf8",
  });
}

function formattedRepository(): string {
  const root = repository();
  execFileSync(process.execPath, [resolve("node_modules/oxfmt/bin/oxfmt"), "--write", "."], {
    cwd: root,
  });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("quality policy", () => {
  it(
    "runs the actual quality aggregate on a valid reduced compiler and policy graph",
    {
      timeout: QUALITY_AGGREGATE_TIMEOUT_MS,
    },
    () => {
      const result = quality(formattedRepository());
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );

  it.each([
    ["lint", "debugger;\nexport const value = 1;\n", "no-debugger", "lint"],
    [
      "semantic",
      "export function parse(text: string): string {\n  return JSON.parse(text);\n}\n",
      "no-unsafe-return",
      "lint",
    ],
    ["compiler", 'export const value: number = "wrong";\n', "TS2322", "typecheck:all"],
    ["formatter", "export const value=1;\n", "example.ts", "format:check"],
    ["policy", "export const value = 1;\n", "Oxlint categories", "check:policy"],
  ])(
    "propagates a real %s failure through the quality aggregate",
    { timeout: QUALITY_AGGREGATE_TIMEOUT_MS },
    (fault, sourceText, diagnostic, gate) => {
      const root = formattedRepository();
      write(root, "example.ts", sourceText);
      if (fault === "policy") {
        updateJson(root, ".oxlintrc.json", (config) => {
          const categories = recordSchema.parse(config.categories);
          return { ...config, categories: { ...categories, correctness: "warn" } };
        });
        execFileSync(
          process.execPath,
          [resolve("node_modules/oxfmt/bin/oxfmt"), "--write", ".oxlintrc.json"],
          { cwd: root },
        );
      }
      const result = quality(root);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(diagnostic);
      expect(result.stdout).toContain(`[check] ${gate}: exit 1`);
      expect(result.stdout).toContain("[check] check:directives: exit 0");
      expect(result.stdout).toContain(`[check] check:policy: exit ${fault === "policy" ? 1 : 0}`);
      expect(result.stdout).toContain(
        `[check] typecheck:all: exit ${fault === "compiler" ? 1 : 0}`,
      );
      expect(result.stdout).toContain("[check] interactive-visualizer: exit 0");
      expect(result.stdout).toContain(`[check] build: exit ${fault === "compiler" ? 1 : 0}`);
      expect(result.stdout).toContain("[check] declarations: exit 0");
      expect(result.stdout).toContain(
        `[check] format:check: exit ${fault === "formatter" ? 1 : 0}`,
      );
      expect(result.stdout).toContain(
        `[check] lint: exit ${fault === "lint" || fault === "semantic" ? 1 : 0}`,
      );
      expect(result.stdout).toContain("[check] check:cache-schema: exit 0");
      expect(result.stdout).toContain("[check] check:browser: exit 0");
    },
  );

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
      "implicit formatter ignore file",
      (root: string) => write(root, ".prettierignore", "example.ts\n"),
      "Unclassified nested quality configuration",
    ],
    [
      "Git-ignored implicit formatter ignore file",
      (root: string) => {
        appendFileSync(join(root, ".gitignore"), "\n.prettierignore\n");
        write(root, ".prettierignore", "example.ts\n");
      },
      "Unclassified ignored source or quality configuration",
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
      "build compiler strictness",
      (root: string) =>
        updateJson(root, "tsconfig.build.json", (config) => {
          const options = recordSchema.parse(config.compilerOptions);
          return { ...config, compilerOptions: { ...options, noUncheckedIndexedAccess: false } };
        }),
      "tsconfig.build.json compilerOptions.noUncheckedIndexedAccess",
    ],
    [
      "reduced native lint scope",
      (root: string) =>
        updateJson(root, "package.json", (config) => {
          const scripts = recordSchema.parse(config.scripts);
          return { ...config, scripts: { ...scripts, lint: "oxlint --deny-warnings scripts" } };
        }),
      "Required acceptance script lint",
    ],
    [
      "short-circuiting tests",
      (root: string) =>
        updateJson(root, "package.json", (config) => {
          const scripts = recordSchema.parse(config.scripts);
          return { ...config, scripts: { ...scripts, test: "vitest run && npm run test:oauth" } };
        }),
      "Required acceptance script test",
    ],
    [
      "missing full CI quality acceptance",
      (root: string) => {
        const file = join(root, ".github/workflows/ci.yml");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace("npm run check:quality", "npm run lint:quality"),
        );
      },
      "Required independent CI step is missing or changed",
    ],
    [
      "swallowed CI quality status",
      (root: string) => {
        const file = join(root, ".github/workflows/ci.yml");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(
            "npm run check:quality",
            "npm run check:quality || true",
          ),
        );
      },
      "Required independent CI step is missing or changed",
    ],
    [
      "shared automation inside required native source scope",
      (root: string) => {
        const file = join(root, ".github/workflows/ci.yml");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replaceAll("path: automation", "path: extension/automation"),
        );
      },
      "CI quality must check the extension checkout with shared automation as a sibling",
    ],
    [
      "production import of test-only support",
      (root: string) => {
        write(root, "__tests__/support.ts", "export const value = 1;\n");
        write(root, "example.ts", 'export { value } from "./__tests__/support.ts";\n');
      },
      "Production build depends on test-only or diagnostic source:",
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

  it.each(["QX-017", "QX-019"])("requires the %s configuration exception record", (id) => {
    const root = repository();
    write(
      root,
      "docs/quality-exceptions.md",
      readFileSync(join(root, "docs/quality-exceptions.md"), "utf8").replace(
        `## ${id}:`,
        "## Unrecorded:",
      ),
    );
    const result = check(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`Missing quality exception record: ${id}`);
  });

  it("rejects an expanded Node registration allowance", () => {
    const root = repository();
    updateJson(root, ".oxlintrc.json", (config) => {
      const profiles = z.array(recordSchema).parse(config.overrides);
      const index = profiles.findIndex((profile) =>
        z.array(z.string()).parse(profile.files).includes("mcp-auth.test.ts"),
      );
      const profile = profiles[index];
      if (profile === undefined) {
        throw new Error("Missing Node registration profile");
      }
      const files = z.array(z.string()).parse(profile.files);
      profiles[index] = { ...profile, files: [...files, "probe.ts"] };
      return { ...config, overrides: profiles };
    });
    const result = check(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Oxlint overrides");
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
      "base rule in native contract fixtures",
      "scripts/native-compat/probe.ts",
      "debugger;\nexport const value = 1;\n",
      "no-debugger",
    ],
    [
      "category-only rule in native contract fixtures",
      "scripts/native-compat/probe.ts",
      "export function value() { return 1; return 2; }\n",
      "no-unreachable",
    ],
    [
      "type-aware rule in native contract fixtures",
      "scripts/native-compat/probe.ts",
      "export function parse(text: string): string { return JSON.parse(text); }\n",
      "no-unsafe-return",
    ],
    [
      "parameter limit in native contract fixtures",
      "scripts/native-compat/probe.ts",
      "export function value(a: number, b: number, c: number, d: number, e: number, f: number, g: number): number { return a + b + c + d + e + f + g; }\n",
      "max-params",
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
    expect(result.stdout).toContain(`${file}:`);
    expect(result.stdout).toContain(diagnostic);
  });

  it("accepts a six-parameter native contract fixture", () => {
    const root = repository();
    const file = "scripts/native-compat/probe.ts";
    write(
      root,
      file,
      "export function value(a: number, b: number, c: number, d: number, e: number, f: number): number { return a + b + c + d + e + f; }\n",
    );
    const result = lint(root, file);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
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

  it.each(["sampling-handler.ts", "__tests__/runtime/sampling-handler.test.ts"])(
    "allows the supported native sampling types in %s",
    (file) => {
      const root = repository();
      write(
        root,
        file,
        'import type { CreateMessageRequest, CreateMessageResult, ModelPreferences, SamplingMessage, SamplingMessageContentBlock } from "@modelcontextprotocol/client";\nexport type SamplingBridge = [CreateMessageRequest, CreateMessageResult, ModelPreferences, SamplingMessage, SamplingMessageContentBlock];\n',
      );
      const result = lint(root, file);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );

  it.each([
    ["sampling-handler.ts", "./other.ts", "ModelPreferences"],
    ["__tests__/runtime/sampling-handler.test.ts", "../../other.ts", "ModelPreferences"],
    ["sampling-handler.ts", "@modelcontextprotocol/client", "ModelHint"],
    ["__tests__/runtime/sampling-handler.test.ts", "@modelcontextprotocol/client", "ModelHint"],
    ["probe.ts", "@modelcontextprotocol/client", "ModelPreferences"],
  ])("rejects deprecated %s imports from %s named %s", (file, origin, name) => {
    const root = repository();
    write(
      root,
      "other.ts",
      "/** @deprecated Native SDK types only. */\nexport type ModelPreferences = string;\n",
    );
    write(root, file, `import type { ${name} } from "${origin}";\nexport type Probe = ${name};\n`);
    const result = lint(root, file);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toContain(`${file}:2:`);
    expect(result.stdout).toContain("typescript(no-deprecated)");
  });

  it.each(["scope", "symbol"])("rejects an expanded sampling %s allowance", (change) => {
    const root = repository();
    updateJson(root, ".oxlintrc.json", (config) => {
      const profiles = z.array(recordSchema).parse(config.overrides);
      const index = profiles.findIndex((profile) =>
        z.array(z.string()).parse(profile.files).includes("sampling-handler.ts"),
      );
      const profile = profiles[index];
      if (profile === undefined) {
        throw new Error("Missing sampling profile");
      }
      const files = z.array(z.string()).parse(profile.files);
      const rules = recordSchema.parse(profile.rules);
      profiles[index] =
        change === "scope"
          ? { ...profile, files: [...files, "probe.ts"] }
          : {
              ...profile,
              rules: {
                ...rules,
                "typescript/no-deprecated": [
                  "error",
                  {
                    allow: [
                      {
                        from: "package",
                        package: "@modelcontextprotocol/client",
                        name: [
                          "CreateMessageRequest",
                          "CreateMessageResult",
                          "ModelPreferences",
                          "SamplingMessage",
                          "SamplingMessageContentBlock",
                          "ModelHint",
                        ],
                      },
                    ],
                  },
                ],
              },
            };
      return { ...config, overrides: profiles };
    });
    const result = check(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Oxlint overrides");
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

  it("counts actual imported compiler members outside configured root globs", () => {
    const root = repository();
    write(root, "uncovered/feature.ts", "export const value = 1;\n");
    write(root, "example.ts", 'export { value } from "./uncovered/feature.ts";\n');
    const result = check(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "build TypeScript",
      "tsconfig.build.json",
      "probe.ts",
      'export const value: number = "wrong";\n',
    ],
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
