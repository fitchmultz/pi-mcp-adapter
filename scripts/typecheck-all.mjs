#!/usr/bin/env node
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { runChecks } from "./run-checks.mjs";

const {
  values: { "skip-build": skipBuild },
} = parseArgs({
  options: { "skip-build": { type: "boolean", default: false } },
  strict: true,
  allowPositionals: false,
});

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
