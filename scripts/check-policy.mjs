#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const root = process.cwd();
const recordSchema = z.record(z.string(), z.unknown());
const compilerConfigSchema = z.object({
  compilerOptions: recordSchema,
  files: z.array(z.string()),
});
const profileSchema = z.looseObject({ files: z.array(z.string()) });
const ignorePatterns = [
  "node_modules/**",
  "dist/**",
  "dist.staging*/**",
  "conformance/results/**",
  ".pi/**",
  ".dogfood/**",
  "app-bridge.bundle.js",
  "examples/interactive-visualizer/dist/**",
  "examples/interactive-visualizer/node_modules/**",
];
const compilerMinimum = {
  strict: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noUncheckedSideEffectImports: true,
  forceConsistentCasingInFileNames: true,
  noCheck: false,
};
const strictFamily = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictBuiltinIteratorReturn",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];
const nodeRegistrationProfile = {
  files: [
    "mcp-auth-flow.test.ts",
    "mcp-auth.test.ts",
    "mcp-callback-server.test.ts",
    "mcp-oauth-provider.test.ts",
  ],
  excludeFiles: ["**/*/*"],
  rules: {
    "typescript/no-floating-promises": [
      "error",
      {
        checkThenables: true,
        ignoreIIFE: false,
        ignoreVoid: false,
        allowForKnownSafeCalls: [
          { from: "package", package: "node:test", name: ["nodeIt", "nodeDescribe"] },
        ],
        allowForKnownSafePromises: [],
      },
    ],
  },
};

/** @param {string} path @returns {unknown} */
function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/** @param {string} heading @returns {Record<string, unknown>} */
function standardConfig(heading) {
  const standard = readFileSync(join(root, "docs/strict-quality-standard.md"), "utf8");
  const section = standard.split(heading)[1];
  const json = section?.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  if (json === undefined) {
    throw new Error(`Missing JSON configuration after ${heading}`);
  }
  return recordSchema.parse(JSON.parse(json));
}

/** @param {string} name @param {unknown} actual @param {unknown} expected */
function requireEqual(name, actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${name} does not match the standard and declared profiles`);
  }
}

function verifyLintConfig() {
  const expected = standardConfig("## Appendix A: Base Oxlint configuration");
  const profiles = z.array(profileSchema).parse(expected.overrides);
  const testProfile = profiles[0];
  if (testProfile === undefined) {
    throw new Error("The standard has no test profile");
  }
  const vitestProfile = {
    files: ["**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
    plugins: ["vitest"],
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/valid-expect": ["error", { minArgs: 1, maxArgs: 2 }],
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expectTypeOf", "assert", "assertType"] },
      ],
      "vitest/no-conditional-expect": "error",
    },
  };
  const samplingProfile = {
    files: ["sampling-handler.ts", "__tests__/runtime/sampling-handler.test.ts"],
    rules: {
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
              ],
            },
          ],
        },
      ],
    },
  };
  const exceptions = readFileSync(join(root, "docs/quality-exceptions.md"), "utf8");
  for (const id of ["QX-017", "QX-019"]) {
    if (!exceptions.includes(`## ${id}:`)) {
      throw new Error(`Missing quality exception record: ${id}`);
    }
  }
  expected.overrides = [
    nodeRegistrationProfile,
    {
      ...testProfile,
      files: [
        ...testProfile.files,
        "conformance/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "scripts/native-compat/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      ],
    },
    ...profiles.slice(1),
    vitestProfile,
    samplingProfile,
  ];
  expected.ignorePatterns = ignorePatterns;
  const actual = recordSchema.parse(readJson(".oxlintrc.json"));
  requireEqual(
    "Oxlint configuration keys",
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
  );
  for (const key of Object.keys(expected)) {
    requireEqual(`Oxlint ${key}`, actual[key], expected[key]);
  }
}

function verifyFormatterConfig() {
  const expected = standardConfig("### 7.1 Formatter ownership");
  expected.ignorePatterns = ignorePatterns;
  requireEqual("Oxfmt configuration", readJson(".oxfmtrc.json"), expected);
}

/** @param {string} project */
function resolvedCompilerConfig(project) {
  const output = execFileSync(
    process.execPath,
    [join(root, "scripts/tsc.mjs"), "--showConfig", "-p", project],
    { cwd: root, encoding: "utf8" },
  );
  return compilerConfigSchema.parse(JSON.parse(output));
}

/** @param {string} project @param {Record<string, unknown>} options @param {boolean} javascript */
function verifyCompilerOptions(project, options, javascript) {
  for (const [key, expected] of Object.entries(compilerMinimum)) {
    requireEqual(`${project} compilerOptions.${key}`, options[key], expected);
  }
  for (const key of strictFamily) {
    if (options[key] === false) {
      throw new Error(`${project} compilerOptions.${key} disables a strict option`);
    }
  }
  if (javascript) {
    requireEqual(`${project} compilerOptions.allowJs`, options.allowJs, true);
    requireEqual(`${project} compilerOptions.checkJs`, options.checkJs, true);
  }
}

/** @param {string[]} files @param {string} project */
function projectPaths(files, project) {
  const directory = dirname(resolve(root, project));
  return new Set(files.map((file) => resolve(directory, file)));
}

/** @returns {string[]} */
function repositoryFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

/** @param {string[]} files */
function verifyNestedConfigs(files) {
  for (const file of files) {
    if (
      /\/(?:\.oxlintrc|\.oxfmtrc)(?:\.|$)/u.test(file) ||
      /(?:^|\/)\.(?:oxlintignore|oxfmtignore|eslintignore)$/u.test(file)
    ) {
      throw new Error(`Unclassified nested quality configuration: ${file}`);
    }
  }
}

function verifyIgnoredSources() {
  const paths = [
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.cjs",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    ".oxlintrc*",
    ".oxfmtrc*",
    ".oxlintignore",
    ".oxfmtignore",
    ".eslintignore",
    ":!node_modules/**",
    ":!dist/**",
    ":!dist.staging*/**",
    ":!conformance/results/**",
    ":!.pi/**",
    ":!.dogfood/**",
    ":!examples/interactive-visualizer/dist/**",
    ":!examples/interactive-visualizer/node_modules/**",
  ];
  const ignored = execFileSync(
    "git",
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...paths],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file !== "" && file !== "app-bridge.bundle.js");
  if (ignored.length > 0) {
    throw new Error(`Unclassified ignored source or quality configuration: ${ignored.join(", ")}`);
  }
}

/** @param {string[]} files */
function verifyCompilerCoverage(files) {
  const projects = ["tsconfig.json", "examples/interactive-visualizer/tsconfig.json"];
  /** @type {Set<string>} */
  const covered = new Set();
  for (const project of projects) {
    const config = resolvedCompilerConfig(project);
    verifyCompilerOptions(project, config.compilerOptions, true);
    for (const file of projectPaths(config.files, project)) {
      covered.add(file);
    }
  }
  const declarations = resolvedCompilerConfig("tsconfig.declarations.json");
  verifyCompilerOptions("tsconfig.declarations.json", declarations.compilerOptions, false);
  requireEqual(
    "tsconfig.declarations.json compilerOptions.skipLibCheck",
    declarations.compilerOptions.skipLibCheck,
    false,
  );
  const checkedDeclarations = projectPaths(declarations.files, "tsconfig.declarations.json");
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) || file === "app-bridge.bundle.js") {
      continue;
    }
    if (!covered.has(resolve(root, file))) {
      throw new Error(`Maintained source is absent from compiler projects: ${file}`);
    }
    if (/\.d\.(?:ts|mts|cts)$/u.test(file) && !checkedDeclarations.has(resolve(root, file))) {
      throw new Error(`Declaration is absent from the declaration project: ${file}`);
    }
  }
}

const checks = {
  "lint policy": verifyLintConfig,
  "formatter policy": verifyFormatterConfig,
  "nested configs": () => verifyNestedConfigs(repositoryFiles()),
  "ignored sources": verifyIgnoredSources,
  "compiler projects": () => verifyCompilerCoverage(repositoryFiles()),
};
let failed = false;
for (const [name, check] of Object.entries(checks)) {
  try {
    check();
  } catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
if (failed) {
  process.exitCode = 1;
}
