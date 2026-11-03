import { runChecks } from "./run-checks.mjs";

/** @param {string} name @param {readonly string[]} requires */
function npmCheck(name, requires = []) {
  return { name, command: "npm", args: ["run", name], requires };
}

const quality = [
  npmCheck("format:check"),
  npmCheck("lint"),
  npmCheck("typecheck:all"),
  npmCheck("check:directives"),
  npmCheck("check:policy"),
  npmCheck("check:cache-schema"),
  npmCheck("check:browser"),
];
const tests = [npmCheck("test:vitest"), npmCheck("test:oauth")];
const mode = process.argv[2];
const plans = {
  test: tests,
  quality,
  compat: [
    { name: "host identity", command: process.execPath, args: ["scripts/compat-host.mjs"] },
    npmCheck("build"),
    npmCheck("typecheck"),
    npmCheck("test:vitest:compat", ["build"]),
    npmCheck("test:oauth"),
    {
      name: "packed consumer",
      command: process.execPath,
      args: ["scripts/compat-package-smoke.mjs"],
      requires: ["host identity", "build"],
    },
  ],
  all: [
    {
      name: "example build",
      command: "npm",
      args: ["run", "--prefix", "examples/interactive-visualizer", "build"],
    },
    npmCheck("build"),
    ...quality,
    npmCheck("test:vitest", ["example build", "build"]),
    npmCheck("test:oauth"),
    npmCheck("test:conformance"),
  ],
};
if (
  process.argv.length !== 3 ||
  (mode !== "test" && mode !== "quality" && mode !== "compat" && mode !== "all")
) {
  throw new Error("Usage: node scripts/check.mjs test|quality|compat|all");
}
process.exitCode = runChecks(plans[mode]);
