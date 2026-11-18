import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

function repository(file: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "adapter-native-boundary-"));
  roots.push(root);
  for (const config of [".oxlintrc.json", ".oxfmtrc.json", "tsconfig.json", "package.json"]) {
    copyFileSync(resolve(config), join(root, config));
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), source);
  return root;
}

function native(root: string, tool: "oxlint" | "oxfmt", args: string[]) {
  return spawnSync(process.execPath, [resolve(`node_modules/${tool}/bin/${tool}`), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function branches(count: number): string {
  return `export function count(value: number): number {\n${Array.from({ length: count }, (_, n) => `if (value === ${n}) { return ${n}; }`).join("\n")}\nreturn -1;\n}\n`;
}

function nesting(count: number): string {
  return `export function count(value: number): number {\n${"if (value > 0) {\n".repeat(count)}return value;\n${"}\n".repeat(count)}return 0;\n}\n`;
}

function parameters(count: number): string {
  const names = Array.from({ length: count }, (_, n) => `value${n}`);
  return `export function sum(${names.map((name) => `${name}: number`).join(", ")}): number { return ${names.join(" + ")}; }\n`;
}

function statements(count: number): string {
  return `export function sum(): number {\nlet value = 0;\n${"value += 1;\n".repeat(count - 2)}return value;\n}\n`;
}

function functionLines(count: number): string {
  return `export function values(): number[] {\nreturn [\n${Array.from({ length: count - 4 }, (_, n) => `${n},`).join("\n")}\n];\n}\n`;
}

function fileLines(count: number): string {
  return `${Array.from({ length: count }, (_, n) => `export const value${n} = ${n};`).join("\n")}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["complexity", "probe.ts", branches, 10, 9, 1],
  ["max-depth", "probe.ts", nesting, 4, 3, 5],
  ["max-params", "probe.ts", parameters, 5, 4, 1],
  ["max-statements", "probe.ts", statements, 41, 40, 1],
  ["max-lines-per-function", "probe.ts", functionLines, 81, 80, 1],
  ["max-lines", "probe.ts", fileLines, 501, 500, 501],
  ["complexity", "__tests__/quality/probe.test.ts", branches, 15, 14, 1],
  ["max-depth", "__tests__/quality/probe.test.ts", nesting, 5, 4, 6],
  ["max-params", "__tests__/quality/probe.test.ts", parameters, 7, 6, 1],
])(
  "enforces %s at the actual profile boundary in %s",
  (rule, file, generate, invalid, valid, line) => {
    const root = repository(file, generate(valid));
    const accepted = native(root, "oxlint", ["--deny-warnings", "--format=agent", "."]);
    expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
    writeFileSync(join(root, file), generate(invalid));
    const rejected = native(root, "oxlint", ["--deny-warnings", "--format=agent", "."]);
    expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(1);
    expect(rejected.stdout).toContain(`${file}:${line}:`);
    expect(rejected.stdout).toContain(`eslint(${rule})`);
  },
);

it("keeps long test bodies under the test structural profile", () => {
  const root = repository("__tests__/quality/probe.test.ts", statements(510));
  const result = native(root, "oxlint", ["--deny-warnings", "."]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

it.each([
  [
    "no-floating-promises",
    "export function run(): void { Promise.resolve(1); }\n",
    "export async function run(): Promise<number> { return await Promise.resolve(1); }\n",
  ],
  [
    "no-misused-promises",
    "export function run(): void { [1].forEach(async (value) => { await Promise.resolve(value); }); }\n",
    "export async function run(): Promise<void> { for (const value of [1]) { await Promise.resolve(value); } }\n",
  ],
  [
    "prefer-promise-reject-errors",
    'export function run(): Promise<never> { return Promise.reject("wrong"); }\n',
    "export function run(error: unknown): Promise<never> { return Promise.reject(error); }\n",
  ],
])(
  "enforces async %s without rejecting owned work or unknown forwarding",
  (rule, invalid, valid) => {
    const root = repository("probe.ts", valid);
    const accepted = native(root, "oxlint", ["--deny-warnings", "--format=agent", "."]);
    expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
    writeFileSync(join(root, "probe.ts"), invalid);
    const rejected = native(root, "oxlint", ["--deny-warnings", "--format=agent", "."]);
    expect(rejected.status, `${rejected.stdout}\n${rejected.stderr}`).toBe(1);
    expect(rejected.stdout).toMatch(/probe\.ts:1:\d+/u);
    expect(rejected.stdout).toContain(`typescript(${rule})`);
  },
);

it("rejects unformatted source and keeps fix then format idempotent", () => {
  const root = repository(
    "probe.ts",
    "export function value():number{let result=1;return result}\n",
  );
  const unformatted = native(root, "oxfmt", ["--check", "."]);
  expect(unformatted.status, `${unformatted.stdout}\n${unformatted.stderr}`).toBe(1);
  expect(`${unformatted.stdout}\n${unformatted.stderr}`).toContain("probe.ts");
  const fixed = native(root, "oxlint", ["--fix", "."]);
  expect(fixed.status, `${fixed.stdout}\n${fixed.stderr}`).toBe(0);
  expect(readFileSync(join(root, "probe.ts"), "utf8")).toContain("const result");
  const formatted = native(root, "oxfmt", ["--write", "."]);
  expect(formatted.status, `${formatted.stdout}\n${formatted.stderr}`).toBe(0);
  const first = readFileSync(join(root, "probe.ts"), "utf8");
  const repeated = native(root, "oxfmt", ["--write", "."]);
  expect(repeated.status, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
  expect(readFileSync(join(root, "probe.ts"), "utf8")).toBe(first);
  const checked = native(root, "oxfmt", ["--check", "."]);
  expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
  const linted = native(root, "oxlint", ["--deny-warnings", "."]);
  expect(linted.status, `${linted.stdout}\n${linted.stderr}`).toBe(0);
});
