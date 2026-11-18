#!/usr/bin/env node
import { join } from "node:path";
import process from "node:process";
import { runChecks } from "./run-checks.mjs";

const extraArgs = process.argv.slice(2);
const skipBuild = extraArgs.includes("--skip-build");
if (extraArgs.some((arg) => arg !== "--skip-build")) {
  throw new Error("Usage: node scripts/typecheck-all.mjs [--skip-build]");
}

const projects = [
  { name: "root", args: ["--noEmit"] },
  ...(skipBuild ? [] : [{ name: "build", args: ["--noEmit", "--project", "tsconfig.build.json"] }]),
  { name: "declarations", args: ["--noEmit", "--project", "tsconfig.declarations.json"] },
  {
    name: "interactive-visualizer",
    args: ["--noEmit", "--project", "examples/interactive-visualizer/tsconfig.json"],
  },
];

process.exitCode = runChecks(
  projects.map((project) => ({
    name: project.name,
    command: process.execPath,
    args: [join(process.cwd(), "scripts", "tsc.mjs"), ...project.args],
  })),
);
