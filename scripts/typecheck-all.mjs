#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const projects = [
  { name: "root", args: ["--noEmit"] },
  { name: "declarations", args: ["--noEmit", "--project", "tsconfig.declarations.json"] },
  {
    name: "interactive-visualizer",
    args: ["--noEmit", "--project", "examples/interactive-visualizer/tsconfig.json"],
  },
];

const results = [];
for (const project of projects) {
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "tsc.mjs"), ...project.args],
    { stdio: "inherit" },
  );
  results.push({ name: project.name, status: result.status ?? 1 });
}

const failed = results.filter((result) => result.status !== 0);
if (failed.length > 0) {
  console.error(`typecheck failed for: ${failed.map((result) => result.name).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`typecheck passed for: ${results.map((result) => result.name).join(", ")}`);
}
