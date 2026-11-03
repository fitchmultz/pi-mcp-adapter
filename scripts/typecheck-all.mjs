#!/usr/bin/env node
import { join } from "node:path";
import process from "node:process";
import { runChecks } from "./run-checks.mjs";

const projects = [
  { name: "root", args: ["--noEmit"] },
  { name: "build", args: ["--noEmit", "--project", "tsconfig.build.json"] },
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
