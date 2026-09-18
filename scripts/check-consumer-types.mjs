#!/usr/bin/env node
// Run from a development checkout against a separate production-only install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
assert.ok(process.argv[2], "Usage: node scripts/check-consumer-types.mjs <production-install>");
const installed = resolve(process.argv[2]);
for (const name of ["typescript", "@types/cross-spawn", "typebox"]) {
  assert.ok(!existsSync(join(installed, "node_modules", name)), `${name} must be pruned`);
}
const consumer = mkdtempSync(join(tmpdir(), "adapter-type-consumer-"));
try {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "pi-mcp-adapter": `file:${installed}` },
  }));
  // npm owns the link; the adapter's dependency tree stays production-only.
  execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", "--install-links=false",
    "--no-package-lock", "--no-audit", "--no-fund"], { cwd: consumer, stdio: "inherit" });
  copyFileSync(join(repo, "__tests__/fixtures/published-types-consumer.mts"), join(consumer, "consumer.mts"));
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    // Keep the repository's existing strict NodeNext compiler settings.
    extends: join(repo, "tsconfig.json"),
    compilerOptions: {
      // Only host SDK aliases, as supplied by Pi. No adapter or typebox alias.
      paths: Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui"].map(name => [
        `@earendil-works/${name}`,
        [join(repo, "node_modules/@earendil-works", name, "dist/index.d.ts")],
      ])),
      // Supply Node globals without exposing the checkout's private @types packages.
      types: [],
      typeRoots: [],
    },
    include: [],
    files: ["consumer.mts", join(repo, "node_modules/@types/node/index.d.ts")],
  }));
  execFileSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"),
    "--project", join(consumer, "tsconfig.json")], { cwd: consumer, stdio: "inherit" });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
