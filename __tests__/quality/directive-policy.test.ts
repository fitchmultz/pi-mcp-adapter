import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSync } from "oxc-parser";
import { loadExceptionSites, resolveExceptionSite } from "../../scripts/quality-exceptions.mjs";

const checker = fileURLToPath(new URL("../../scripts/check-directives.mjs", import.meta.url));
const lintConfig = fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url));
const linter = fileURLToPath(new URL("../../node_modules/.bin/oxlint", import.meta.url));
const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const compilerConfig = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
const negativeTest = "__tests__/fixtures/published-types-consumer.test-d.mts";
const dirs: string[] = [];

function checkSource(file: string, source: string, sites: unknown[] = []) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "adapter-directives-")));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), source);
  writeFileSync(join(cwd, "quality-exceptions.json"), JSON.stringify(sites));
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(
    join(cwd, "docs/quality-exceptions.md"),
    "## QX-001: Native transport observation\n## QX-007: Legacy initialized capabilities\n## QX-009: Forward captured failures\n## QX-010: Native client callbacks\n## QX-011: Invalid runtime options\n## QX-012: Mutating configuration hook\n## QX-016: Receiver-preserving native method captures\n## QX-013: Preserve the primary keyring load failure\n## QX-018: Native keyring module declarations\n## QX-020: Supplied auth-entry URL update\n## QX-021: Lazy declared Zod API\n## QX-022: Published positional filtering API\n## QX-023: Preserve ordered aggregate errors without adding cause\n## QX-024: Supported native SDK operations\n## QX-025: Native tool callback\n## QX-026: Native URL validation\n## QX-3003: Missing host theme\n## QX-3004: Native execute callback\n## QX-030: Standalone bridge callback contracts\n## QX-031: Native raw echo coercion\n## QX-7001: JSON Schema conditional keyword\n",
  );
  return { ...spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" }), cwd };
}

function nativeLint(cwd: string, file = "forward.ts") {
  symlinkSync(modules, join(cwd, "node_modules"), "junction");
  symlinkSync(fileURLToPath(new URL("../..", import.meta.url)), join(cwd, "adapter"), "junction");
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify({
      extends: compilerConfig,
      compilerOptions: { rootDir: cwd },
      files: [file],
      include: [],
    }),
  );
  return spawnSync(linter, ["--deny-warnings", "--format", "unix", "--config", lintConfig, file], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("directive policy", () => {
  it("permits literal examples and described directives in approved negative type fixtures", () => {
    const literals = checkSource(
      "literal.ts",
      [
        'const text = "// oxlint-disable-next-line example";',
        "const regex = /https?:\\/\\//;",
        'const template = `// @ts-ignore ${regex.test("https://example.com")}`;',
        "/* notes\n oxlint-disable no-debugger */",
        "/*\n * eslint-disable no-debugger\n */",
        "/** @ts-ignore\n * not a TypeScript directive */",
      ].join("\n"),
    );
    const negatives = [
      negativeTest,
      "__tests__/oauth-config.test-d.ts",
      "__tests__/catalog-metadata.test-d.ts",
    ].map((file) =>
      checkSource(
        file,
        '// @ts-expect-error A string is not assignable to a number.\nconst number: number = "x";\n',
      ),
    );
    expect(literals.status, literals.stderr).toBe(0);
    for (const negative of negatives) {
      expect(negative.status, negative.stderr).toBe(0);
    }
  });

  it.each([
    [
      "oxlint",
      "src.ts",
      "// oxlint-disable-next-line no-console -- QX-001: reason\nfoo();\n",
      "lint directive",
    ],
    ["eslint", "src.ts", "/* eslint-disable no-console */\nfoo();\n", "lint directive"],
    ["ignore", "src.ts", "// @ts-ignore reason\nfoo();\n", "TypeScript error suppression"],
    ["triple-slash", "src.ts", "/// @ts-ignore reason\nfoo();\n", "TypeScript error suppression"],
    ["ignore suffix", "src.ts", "// @ts-ignoreXYZ\nfoo();\n", "TypeScript error suppression"],
    ["JSDoc ignore", "src.ts", "/** @ts-ignore */\nfoo();\n", "TypeScript error suppression"],
    ["JSDoc glued", "src.ts", "/**@ts-ignore*/\nfoo();\n", "TypeScript error suppression"],
    ["nocheck", "src.ts", "// @ts-nocheck\nfoo();\n", "TypeScript error suppression"],
    [
      "negative in implementation",
      "src.ts",
      "// @ts-expect-error mismatch\nfoo();\n",
      "restricted to approved type tests",
    ],
    [
      "short description",
      negativeTest,
      "// @ts-expect-error short\nfoo();\n",
      "at least ten characters",
    ],
    [
      "glued description",
      negativeTest,
      "// @ts-expect-errorThisIsNotADescription\nfoo();\n",
      "at least ten characters",
    ],
    [
      "JSDoc negative in implementation",
      "src.ts",
      "/** @ts-expect-error no description */\nfoo();\n",
      "restricted to approved type tests",
    ],
    [
      "JSDoc short description",
      negativeTest,
      "/** @ts-expect-error short */\nfoo();\n",
      "at least ten characters",
    ],
  ])("rejects %s", (_name, file, source, diagnostic) => {
    const result = checkSource(file, source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:1:`);
    expect(result.stderr).toContain(diagnostic);
  });

  it("finds a real directive inside a template expression", () => {
    const result = checkSource(
      "template.ts",
      "const text = `${(() => {\n// @ts-ignore mismatch\nreturn 1;\n})()}`;\n",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("template.ts:2: TypeScript error suppression");
  });

  it("finds a TypeScript directive at the end of a block comment", () => {
    const result = checkSource("block.ts", "/* notes\n @ts-ignore */\nfoo();\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("block.ts:2: TypeScript error suppression");
  });

  it("finds a TypeScript directive at the end of a multiline JSDoc comment", () => {
    const result = checkSource("block.ts", "/**\n * @ts-ignore */\nfoo();\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("block.ts:2: TypeScript error suppression");
  });

  it("fails if a maintained source cannot be parsed", () => {
    const result = checkSource("broken.ts", "const = ;");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("broken.ts: parse error:");
  });
});

const managerFiles = [
  "connection-factory.ts",
  "connection-http.ts",
  "connection-runtime.ts",
  "connection-oauth-ownership.ts",
  "connection-handshake.ts",
  "tool-transport.ts",
];
const managerSites = loadExceptionSites().filter((entry) => managerFiles.includes(entry.file));

describe("manager operation inventory", () => {
  it.each(managerFiles)("accepts the actual native operations in %s", (file) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replaceAll(
      '"./',
      '"./adapter/',
    );
    const entries = managerSites
      .filter((entry) => entry.file === file)
      .map((entry) => Object.assign({}, entry, { file: "forward.ts" }));
    expect(entries.length).toBeGreaterThan(0);
    const result = checkSource("forward.ts", source, entries);
    expect(result.status, result.stderr).toBe(0);
    const native = nativeLint(result.cwd);
    expect(native.status, native.stdout + native.stderr).toBe(0);
  });

  it.each(managerSites)("rejects unauthorized uses of $file $operation", (entry) => {
    const source = readFileSync(new URL(`../../${entry.file}`, import.meta.url), "utf8").replaceAll(
      '"./',
      '"./adapter/',
    );
    const entries = managerSites
      .filter((siteEntry) => siteEntry.file === entry.file)
      .map((siteEntry) => Object.assign({}, siteEntry, { file: "forward.ts" }));
    const operation = resolveExceptionSite(
      entry,
      parseSync("forward.ts", source).program,
      source,
    ).start;
    const offset = source.lastIndexOf("// oxlint-disable-next-line", operation);
    expect(offset).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n", offset);
    const comment = source.slice(offset, end);
    const withoutDirective = source.slice(0, offset) + source.slice(end + 1);
    const copied = checkSource("copied.ts", source, entries);
    const missing = checkSource("forward.ts", withoutDirective, entries);
    const duplicate = checkSource(
      "forward.ts",
      source.slice(0, offset) + comment + "\n" + source.slice(offset),
      entries,
    );
    const misplaced = checkSource(
      "forward.ts",
      source.slice(0, end) + "\n" + source.slice(end),
      entries,
    );
    const replacement = checkSource(
      "forward.ts",
      source.slice(0, operation) +
        entry.operation.replace(
          /onclose|onerror|onmessage|SSEClientTransport|setLoggingLevel|saveAuthorizationServerUrl|cleanupError/u,
          "unauthorized",
        ) +
        source.slice(operation + entry.operation.length),
      entries,
    );
    for (const result of [copied, missing, duplicate, misplaced, replacement]) {
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(
        /not authorized|unused exception site|operation changed|scope is missing/u,
      );
    }
    const nativeMissing = nativeLint(missing.cwd);
    expect(nativeMissing.status).toBe(1);
    const line = withoutDirective.slice(0, offset).split("\n").length;
    const rule = entry.rule.replace("/", "(") + ")";
    expect(nativeMissing.stdout + nativeMissing.stderr).toContain(`forward.ts:${line}:`);
    expect(nativeMissing.stdout + nativeMissing.stderr).toContain(`[Error/${rule}]`);
    const unused = checkSource(
      "forward.ts",
      `${withoutDirective}\n${comment}\nexport const qxUnused = 1;\n`,
      entries,
    );
    expect(unused.status).toBe(1);
    expect(unused.stderr).toContain("lint directive is not authorized");
    const nativeUnused = nativeLint(unused.cwd);
    expect(nativeUnused.status).toBe(1);
    expect(nativeUnused.stdout + nativeUnused.stderr).toContain("Unused");
  });

  it("rejects a same-named SSE export from a different declaration origin", () => {
    const file = "connection-runtime.ts";
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
      .replaceAll('"./', '"./adapter/')
      .replace(
        'UnauthorizedError,\n} from "@modelcontextprotocol/client";',
        'UnauthorizedError,\n} from "node:events";',
      );
    const entries = managerSites
      .filter((entry) => entry.file === file)
      .map((entry) => Object.assign({}, entry, { file: "forward.ts" }));
    const result = checkSource("forward.ts", source, entries);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Exception scope is missing or ambiguous");
  });
});

const site = {
  id: "QX-009",
  file: "forward.ts",
  rule: "typescript/only-throw-error",
  scope: { type: "FunctionDeclaration", name: "forward" },
  path: ["body", "body", 0],
  nodeType: "ThrowStatement",
  operation: "throw error;",
  guards: [],
};
const directive =
  "// oxlint-disable-next-line typescript/only-throw-error -- QX-009: preserve the captured failure.";
const forward = `export function forward(error: unknown): never {\n${directive}\nthrow error;\n}\n`;
const sendDirective =
  "// oxlint-disable-next-line eslint/no-param-reassign -- QX-001: observe native sends.";
const transportSource = `export function forward(transport: { send: (value: number) => number; close: (value: number) => number }): typeof transport {\n${sendDirective}\ntransport.send = (value) => value + 1;\nreturn transport;\n}\n`;
const clientDirective =
  "// oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-010: the SDK exposes a callback.";
const clientSource = [
  'import { Client } from "@modelcontextprotocol/client";',
  "export const observe = function observeClientError(): { client: Client; errors: Error[] } {",
  'const client = new Client({ name: "fixture", version: "1" });',
  "const errors: Error[] = [];",
  clientDirective,
  "client.onerror = (error) => errors.push(error);",
  "return { client, errors };",
  "};",
  "",
].join("\n");
const clientSite = {
  ...site,
  id: "QX-010",
  rule: "unicorn/prefer-add-event-listener",
  scope: { type: "FunctionExpression", name: "observeClientError" },
  path: ["body", "body", 2, "expression", "left"],
  nodeType: "MemberExpression",
  operation: "client.onerror",
};
const messageSource = [
  'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";',
  "export const observe = function observesTransportMessage(): StreamableHTTPClientTransport {",
  'const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"));',
  clientDirective,
  "transport.onmessage = (message) => console.log(message);",
  "return transport;",
  "};",
  "",
].join("\n");
const captureDirective =
  "// oxlint-disable-next-line typescript/unbound-method -- QX-016: retain the original for a receiver-preserving call.";
const captures = [
  {
    name: "OAuth token reader",
    import: 'import { McpOAuthProvider } from "./adapter/mcp-oauth-provider.ts";',
    variable: "originalTokens",
    operation: "McpOAuthProvider.prototype.tokens",
    neighbor: "McpOAuthProvider.prototype.saveTokens",
  },
  {
    name: "OAuth token persistence",
    import: 'import { McpOAuthProvider } from "./adapter/mcp-oauth-provider.ts";',
    variable: "originalSaveTokens",
    operation: "McpOAuthProvider.prototype.saveTokens",
    neighbor: "McpOAuthProvider.prototype.tokens",
  },
  {
    name: "native Response body reader",
    import: "",
    variable: "originalJson",
    operation: "Response.prototype.json",
    neighbor: "Response.prototype.text",
  },
].map(({ name, import: importSource, variable, operation, neighbor }) => ({
  name,
  variable,
  operation,
  neighbor,
  source: [importSource, `export const ${variable} =`, captureDirective, `${operation};`, ""].join(
    "\n",
  ),
  authorized: {
    ...site,
    id: "QX-016",
    rule: "typescript/unbound-method",
    scope: { type: "VariableDeclarator", name: variable },
    path: ["init"],
    nodeType: "MemberExpression",
    operation,
  },
}));
const invalidDirective =
  "// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-011: exercise runtime validation.";
const invalidSource = [
  'import type { ServerEntry } from "./adapter/types.ts";',
  "export const invalid = function invalidProtocolOptions(value: unknown): ServerEntry {",
  "return (",
  invalidDirective,
  "value as ServerEntry",
  ");",
  "};",
  "",
].join("\n");
const transformSource = [
  'import assert from "node:assert/strict";',
  'import type { McpConfig } from "./adapter/types.ts";',
  "export const transform = function transformsSuppliedConfig(config: McpConfig): McpConfig {",
  "assert(config.mcpServers.docs?.env !== undefined);",
  "// oxlint-disable-next-line eslint/no-param-reassign -- QX-012: exercise the adapter-owned input snapshot.",
  'config.mcpServers.docs.env.ORIGINAL = "transformed";',
  "return config;",
  "};",
  "",
].join("\n");
const capabilitySource = [
  'import assert from "node:assert/strict";',
  'import { McpServer } from "@modelcontextprotocol/server";',
  'const server = new McpServer({ name: "fixture", version: "1" });',
  'server.registerTool("caps", {}, function reportClientCapabilities() {',
  "// oxlint-disable-next-line typescript/no-deprecated -- QX-007: observe legacy initialized capabilities.",
  "const capabilities = server.server.getClientCapabilities();",
  "assert(capabilities !== undefined);",
  'return { content: [{ type: "text", text: JSON.stringify(capabilities) }] };',
  "});",
  "",
].join("\n");
const capabilityFunctionSource = [
  'import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";',
  'const mcp = new McpServer({ name: "fixture", version: "1" });',
  "const server = mcp.server;",
  "function reportClientCapabilities(): CallToolResult {",
  "// oxlint-disable-next-line typescript/no-deprecated -- QX-007: observe legacy initialized capabilities.",
  "const capabilities = server.getClientCapabilities();",
  'return { content: [{ type: "text", text: JSON.stringify(capabilities) }] };',
  "}",
  'mcp.registerTool("caps", {}, reportClientCapabilities);',
  "",
].join("\n");

const directCallbackDirective =
  "// oxlint-disable-next-line eslint/max-params -- QX-025: Pi supplies context fifth.";
const directCallbackSignature =
  "async function execute(toolCallId, params, signal, _onUpdate, ctx) ";
const directCallbackSource = [
  'import type { ToolDefinition } from "@earendil-works/pi-coding-agent";',
  'import type { TUnsafe } from "typebox";',
  'type Execute = ToolDefinition<TUnsafe<Record<string, unknown>>, Record<string, unknown>>["execute"];',
  "export function createExecutor(): Execute {",
  "return (",
  directCallbackDirective,
  `${directCallbackSignature}{`,
  "return { content: [], details: { toolCallId, params, signal, _onUpdate, hasUI: ctx.hasUI } };",
  "}",
  ");",
  "}",
  "",
].join("\n");
const directCallbackSite = {
  ...site,
  id: "QX-025",
  rule: "eslint/max-params",
  scope: { type: "FunctionExpression", name: "execute" },
  path: [],
  nodeType: "FunctionExpression",
  part: "signature",
  operation: directCallbackSignature,
};

const helperFile = "mcp-keyring-helper.cjs";
const helperSource = readFileSync(new URL(`../../${helperFile}`, import.meta.url), "utf8");
const helperSite = loadExceptionSites().find((entry) => entry.file === helperFile);
assert(helperSite !== undefined);
const helperDirective = helperSource
  .split("\n")
  .find((line) => line.trimStart().startsWith("// oxlint-disable-next-line"));
assert(helperDirective !== undefined);

describe("standalone native keyring declaration exception", () => {
  it("qualifies the actual CommonJS load while rejecting neighboring and unused assertions", () => {
    const accepted = checkSource(helperFile, helperSource, [helperSite]);
    const nativeAccepted = nativeLint(accepted.cwd, helperFile);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(nativeAccepted.status, nativeAccepted.stdout + nativeAccepted.stderr).toBe(0);

    const neighbor = checkSource(
      helperFile,
      `${helperSource}/** @param {unknown} value */\nfunction unrelated(value) {\nreturn /** @type {Pick<typeof import("@napi-rs/keyring"), "Entry">} */ (value);\n}\n`,
      [helperSite],
    );
    expect(neighbor.status, neighbor.stderr).toBe(0);
    const nativeNeighbor = nativeLint(neighbor.cwd, helperFile);
    expect(nativeNeighbor.status).toBe(1);
    expect(nativeNeighbor.stdout + nativeNeighbor.stderr).toContain(
      `${helperFile}:${helperSource.split("\n").length + 2}:`,
    );
    expect(nativeNeighbor.stdout + nativeNeighbor.stderr).toContain(
      "[Error/typescript(no-unsafe-type-assertion)]",
    );

    const unused = checkSource(
      helperFile,
      helperSource.replace(helperSite.operation, 'require("@napi-rs/keyring")'),
      [helperSite],
    );
    expect(unused.status).toBe(1);
    expect(unused.stderr).toContain("Authorized operation changed");
    const nativeUnused = nativeLint(unused.cwd, helperFile);
    expect(nativeUnused.status).toBe(1);
    expect(nativeUnused.stdout + nativeUnused.stderr).toContain("Unused oxlint-disable directive");
    expect(nativeUnused.stdout + nativeUnused.stderr).toContain(
      `${helperFile}:${helperSource.split("\n").indexOf(helperDirective) + 1}:`,
    );
  });

  it.each([
    ["copied", "copied.cjs", helperSource, "lint directive is not authorized"],
    [
      "wrong-site",
      helperFile,
      helperSource.replace("function loadKeyringEntryClass()", "function unrelated()"),
      "Exception scope is missing",
    ],
    [
      "wrong-origin with the same directive count",
      helperFile,
      helperSource.replace(
        "requireFromHere(path.join(path.dirname(packageJsonPath), `keyring.${suffix}.node`))",
        'requireFromHere("node:fs")',
      ),
      "Authorized operation changed",
    ],
    [
      "duplicate",
      helperFile,
      `${helperSource}function duplicate() {\nreturn /** @type {Pick<typeof import("@napi-rs/keyring"), "Entry">} */ (\n${helperDirective}\n${helperSite.operation}\n).Entry;\n}\n`,
      "lint directive is not authorized",
    ],
    [
      "stale",
      helperFile,
      helperSource.replace(`${helperDirective}\n`, ""),
      "unused exception site QX-018",
    ],
  ])("rejects a %s helper directive", (_name, file, source, diagnostic) => {
    const result = checkSource(file, source, [helperSite]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:`);
    expect(result.stderr).toContain(diagnostic);
  });
});

const keyringCases = [
  {
    name: "lazy native keyring module",
    source:
      'import type * as keyring from "@napi-rs/keyring";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\ntype KeyringModule = Pick<typeof keyring, "Entry">;\nexport function loadKeyringEntryClass(): typeof keyring.Entry {\n// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-018: load the native Entry declaration.\nreturn (require("@napi-rs/keyring") as KeyringModule).Entry;\n}\n',
    id: "QX-018",
    rule: "typescript/no-unsafe-type-assertion",
    scopeName: "loadKeyringEntryClass",
    path: ["body", "body", 0],
    nodeType: "ReturnStatement",
    operation: 'return (require("@napi-rs/keyring") as KeyringModule).Entry;',
    replacement: 'return (require("node:fs") as KeyringModule).Entry;',
    neighborSuffix:
      "export function untrusted(value: unknown): KeyringModule {\nreturn value as KeyringModule;\n}\n",
    diagnostic: ["forward.ts:10:", "[Error/typescript(no-unsafe-type-assertion)]"],
  },
  {
    name: "resolved native keyring binding",
    source:
      'import type * as keyring from "@napi-rs/keyring";\nimport { createRequire } from "node:module";\nimport { dirname, join } from "node:path";\nconst require = createRequire(import.meta.url);\ntype KeyringModule = Pick<typeof keyring, "Entry">;\nexport function loadKeyringNativeBindingFallback(): KeyringModule {\nconst target = { packageName: "@napi-rs/keyring-darwin-arm64", bindingFile: "keyring.darwin-arm64.node" };\nconst packageJsonPath = require.resolve(`${target.packageName}/package.json`);\n// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-018: load the native Entry declaration.\nreturn require(join(dirname(packageJsonPath), target.bindingFile)) as KeyringModule;\n}\n',
    id: "QX-018",
    rule: "typescript/no-unsafe-type-assertion",
    scopeName: "loadKeyringNativeBindingFallback",
    path: ["body", "body", 2],
    nodeType: "ReturnStatement",
    operation:
      "return require(join(dirname(packageJsonPath), target.bindingFile)) as KeyringModule;",
    replacement:
      'return require(join(dirname(packageJsonPath), "unrelated.node")) as KeyringModule;',
    neighborSuffix:
      "export function untrusted(value: unknown): KeyringModule {\nreturn value as KeyringModule;\n}\n",
    diagnostic: ["forward.ts:13:", "[Error/typescript(no-unsafe-type-assertion)]"],
  },
  {
    name: "primary keyring loader cause",
    source:
      'function loadBinding(): never { throw new Error("binding"); }\nexport function loadKeyringEntryClass(): never {\ntry {\nthrow new Error("package");\n} catch (loaderError) {\ntry {\nloadBinding();\n} catch (fallbackError) {\n// oxlint-disable-next-line eslint/preserve-caught-error -- QX-013: retain the primary loader cause.\nthrow new Error(String(fallbackError), { cause: loaderError });\n}\n}\n}\n',
    id: "QX-013",
    rule: "eslint/preserve-caught-error",
    scopeName: "loadKeyringEntryClass",
    path: ["body", "body", 0, "handler", "body", "body", 0, "handler", "body", "body", 0],
    nodeType: "ThrowStatement",
    operation: "throw new Error(String(fallbackError), { cause: loaderError });",
    replacement: "throw new Error(String(fallbackError), { cause: fallbackError });",
    neighborSuffix:
      'export function dropsCaughtError(): never {\ntry { throw new Error("original"); } catch (error) {\nthrow new Error(String(error));\n}\n}\n',
    diagnostic: ["forward.ts:16:", "[Error/eslint(preserve-caught-error)]"],
  },
].map(
  ({
    id,
    rule,
    scopeName,
    path,
    nodeType,
    operation,
    name,
    source,
    replacement,
    neighborSuffix,
    diagnostic,
  }) => ({
    name,
    source,
    replacement,
    neighbor: source + neighborSuffix,
    diagnostic,
    operation,
    authorized: {
      ...site,
      id,
      rule,
      scope: { type: "FunctionDeclaration", name: scopeName },
      path,
      nodeType,
      operation,
    },
  }),
);

const zodModuleSource =
  'import type * as Zod from "zod";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport function createAuthRecordSchemas(): Zod.ZodString {\n// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-021: keep Zod outside cached startup.\nconst { z } = require("zod") as typeof Zod;\nreturn z.string();\n}\n';
const authEntrySource = [
  'import type { AuthEntry } from "./adapter/auth-record-types.ts";',
  "export function saveAuthEntry(entry: AuthEntry, serverUrl?: string): void {",
  "if (serverUrl !== undefined && serverUrl.length > 0) {",
  "// oxlint-disable-next-line eslint/no-param-reassign -- QX-020: preserve the supplied entry's URL update.",
  "entry.serverUrl = serverUrl;",
  "}",
  "}",
  "",
].join("\n");
const aggregateCases = [
  {
    name: "cleanupFailedCompletion",
    primary: "primary",
    message: "OAuth completion cleanup failed",
  },
  {
    name: "authenticateOnce",
    primary: "error",
    message: "OAuth cancellation cleanup failed",
  },
  { name: "reserveCallback", primary: "error", message: "OAuth startup cleanup failed" },
  { name: "startInteractive", primary: "error", message: "OAuth startup cleanup failed" },
].map(({ name, primary, message }) => {
  const operation = `throw new AggregateError([${primary}, cleanupError], "${message}");`;
  const source = [
    `export function ${name}(${primary}: Error, cleanup: Error): never {`,
    "try {",
    "throw cleanup;",
    "} catch (cleanupError) {",
    "// oxlint-disable-next-line eslint/preserve-caught-error -- QX-023: preserve ordered failures without adding cause.",
    operation,
    "}",
    "}",
    "",
  ].join("\n");
  return {
    name: `ordered aggregate in ${name}`,
    source,
    operation,
    replacement: `throw new AggregateError([cleanupError, ${primary}], "${message}");`,
    neighbor: `${source}export function dropsCaughtError(): never {\ntry { throw new Error("original"); } catch (error) {\nthrow new Error(String(error));\n}\n}\n`,
    diagnostic: ["forward.ts:11:", "[Error/eslint(preserve-caught-error)]"],
    authorized: {
      ...site,
      id: "QX-023",
      rule: "eslint/preserve-caught-error",
      scope: { type: "FunctionDeclaration", name },
      path: ["body", "body", 0, "handler", "body", "body", 0],
      nodeType: "ThrowStatement",
      operation,
    },
  };
});
const urlValidationSource =
  'export function resolveServerUrl(resolved: string): string {\ntry {\n// oxlint-disable-next-line eslint/no-new -- QX-026: preserve native URL errors without canonicalizing the returned bytes.\nnew URL(resolved);\n} catch (error) {\nthrow new Error("Invalid URL", { cause: error });\n}\nreturn resolved;\n}\n';

const residualCases = [
  {
    name: "standalone bridge request callback",
    id: "QX-030",
    rule: "unicorn/prefer-add-event-listener",
    operation: "bridge.onmessage = callback;",
    replacement: "bridge.onopenlink = callback;",
    neighborSuffix:
      'export function unrelated(): void {\nconst signal = new AbortController().signal;\nsignal.onabort = () => console.log("aborted");\n}\n',
    diagnosticOffset: 2,
    diagnosticRule: "[Error/unicorn(prefer-add-event-listener)]",
  },
  ...["oninitialized", "onsizechange"].flatMap((name) => [
    {
      name: `standalone bridge ${name} setter`,
      id: "QX-030",
      rule: "typescript/no-deprecated",
      operation: `bridge.${name} = callback;`,
      replacement: "bridge.onopenlink = callback;",
      neighborSuffix:
        'export const unrelated = new AppBridge(null, {name:"fixture",version:"1"}, {}).onsandboxready;\n',
      diagnosticOffset: 0,
      diagnosticRule: "[Error/typescript(no-deprecated)]",
    },
    {
      name: `standalone bridge ${name} getter`,
      id: "QX-030",
      rule: "typescript/no-deprecated",
      operation: `console.log(bridge.${name});`,
      replacement: "console.log(bridge.onopenlink);",
      neighborSuffix:
        'export const unrelated = new AppBridge(null, {name:"fixture",version:"1"}, {}).onsandboxready;\n',
      diagnosticOffset: 0,
      diagnosticRule: "[Error/typescript(no-deprecated)]",
    },
  ]),
].map(
  ({
    name,
    id,
    rule,
    operation,
    replacement,
    neighborSuffix,
    diagnosticOffset,
    diagnosticRule,
  }) => {
    const needsCallback = operation.startsWith("bridge.");
    const source = [
      'import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";',
      "export function probeBridge(): void {",
      'const bridge = new AppBridge(null, {name:"fixture",version:"1"}, {});',
      ...(needsCallback
        ? [
            `const callback = ${rule === "unicorn/prefer-add-event-listener" ? "async " : ""}() => ({});`,
          ]
        : []),
      `// oxlint-disable-next-line ${rule} -- ${id}: retain the original callback contract.`,
      operation,
      "}",
      "",
    ].join("\n");
    return {
      name,
      source,
      operation,
      replacement,
      neighbor: source + neighborSuffix,
      diagnostic: [`forward.ts:${source.split("\n").length + diagnosticOffset}:`, diagnosticRule],
      authorized: {
        ...site,
        id,
        rule,
        scope: { type: "FunctionDeclaration", name: "probeBridge" },
        path: ["body", "body", needsCallback ? 2 : 1],
        nodeType: "ExpressionStatement",
        operation,
      },
    };
  },
);
const echoSource = [
  'import type { CallToolRequest } from "@modelcontextprotocol/server";',
  "export function callTool(request: CallToolRequest): string {",
  "// oxlint-disable-next-line typescript/no-base-to-string -- QX-031: preserve native echo coercion.",
  'const echoText = String(request.params.arguments?.value ?? "");',
  "return echoText;",
  "}",
  "",
].join("\n");
const functionCases = [
  ...keyringCases,
  ...aggregateCases,
  {
    name: "native URL validation",
    source: urlValidationSource,
    operation: "new URL(resolved);",
    replacement: "new Date(resolved);",
    neighbor: `${urlValidationSource}export function unrelated(): void {\nnew Date();\n}\n`,
    diagnostic: ["forward.ts:11:", "[Error/eslint(no-new)]"],
    authorized: {
      ...site,
      id: "QX-026",
      rule: "eslint/no-new",
      scope: { type: "FunctionDeclaration", name: "resolveServerUrl" },
      path: ["body", "body", 0, "block", "body", 0],
      nodeType: "ExpressionStatement",
      operation: "new URL(resolved);",
    },
  },
  ...residualCases,
  {
    name: "raw echo coercion",
    source: echoSource,
    operation: 'const echoText = String(request.params.arguments?.value ?? "");',
    replacement: "const echoText = String({});",
    neighbor: echoSource + "export const unrelated = String({});\n",
    diagnostic: ["forward.ts:7:", "[Error/typescript(no-base-to-string)]"],
    authorized: {
      ...site,
      id: "QX-031",
      rule: "typescript/no-base-to-string",
      scope: { type: "FunctionDeclaration", name: "callTool" },
      path: ["body", "body", 0],
      nodeType: "VariableDeclaration",
      operation: 'const echoText = String(request.params.arguments?.value ?? "");',
    },
  },
  {
    name: "lazy declared Zod API",
    source: zodModuleSource,
    operation: 'const { z } = require("zod") as typeof Zod;',
    replacement: 'const { z } = require("node:fs") as typeof Zod;',
    neighbor: `${zodModuleSource}export function untrusted(value: unknown): typeof Zod {\nreturn value as typeof Zod;\n}\n`,
    diagnostic: ["forward.ts:10:", "[Error/typescript(no-unsafe-type-assertion)]"],
    authorized: {
      ...site,
      id: "QX-021",
      rule: "typescript/no-unsafe-type-assertion",
      scope: { type: "FunctionDeclaration", name: "createAuthRecordSchemas" },
      path: ["body", "body", 0],
      nodeType: "VariableDeclaration",
      operation: 'const { z } = require("zod") as typeof Zod;',
    },
  },
  {
    name: "supplied auth-entry URL update",
    source: authEntrySource,
    operation: "entry.serverUrl",
    replacement: "entry.oauthState",
    neighbor: `${authEntrySource}export function unrelated(entry: AuthEntry): void {\nentry.codeVerifier = "neighbor";\n}\n`,
    diagnostic: ["forward.ts:9:", "[Error/eslint(no-param-reassign)]"],
    authorized: {
      ...site,
      id: "QX-020",
      rule: "eslint/no-param-reassign",
      scope: { type: "FunctionDeclaration", name: "saveAuthEntry" },
      path: ["body", "body", 0, "consequent", "body", 0, "expression", "left"],
      nodeType: "MemberExpression",
      operation: "entry.serverUrl",
      guards: ["consequent: serverUrl !== undefined && serverUrl.length > 0"],
    },
  },
];

const positionalDirective =
  "// oxlint-disable-next-line eslint/max-params -- QX-022: retain the published five-position filtering API.";
const positionalOperation = `export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
): boolean {
  return (
    isToolIncluded(toolName, serverName, prefix, includeTools) &&
    !isToolExcluded(toolName, serverName, prefix, excludeTools)
  );
}`;
const positionalSource = [
  'import { isToolIncluded, isToolExcluded, type ToolPrefix } from "./adapter/types.ts";',
  positionalDirective,
  positionalOperation,
  "",
].join("\n");
const positionalSite = {
  ...site,
  id: "QX-022",
  rule: "eslint/max-params",
  scope: { type: "ExportNamedDeclaration", name: "isToolAllowed" },
  path: [],
  nodeType: "ExportNamedDeclaration",
  operation: positionalOperation,
};

const themeDirective =
  "// oxlint-disable-next-line typescript/no-unnecessary-condition -- QX-3003: JavaScript hosts can omit the theme.";
const themeOperation = 'if (ui.theme === undefined) {\nreturn "status";\n}';
const themeSource = [
  'import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";',
  "export function forward(ui: ExtensionUIContext): string {",
  themeDirective,
  themeOperation,
  'return ui.theme.fg("accent", "status");',
  "}",
  "",
].join("\n");
const executeDirective =
  "// oxlint-disable-next-line eslint/max-params -- QX-3004: preserve Pi's five native callback positions.";
const executeOperation = [
  "async function nativeExecute(toolCallId, params, signal, _onUpdate, ctx) {",
  'return { content: [{ type: "text", text: `${toolCallId}:${params.text}:${ctx.cwd}:${signal?.aborted === true}` }], details: {} };',
  "}",
].join("\n");
const executeSource = [
  'import type { HostToolExecute } from "./adapter/host-contract.ts";',
  "export const execute: HostToolExecute<{ text: string }> =",
  executeDirective,
  `${executeOperation};`,
  "",
].join("\n");
const hostCases = [
  {
    name: "missing native theme",
    source: themeSource,
    directive: themeDirective,
    operation: themeOperation,
    replacement: themeOperation.replace("=== undefined", "!== undefined"),
    authorized: {
      ...site,
      id: "QX-3003",
      rule: "typescript/no-unnecessary-condition",
      nodeType: "IfStatement",
      path: ["body", "body", 0],
      operation: themeOperation,
    },
    neighbor: `${themeSource}export function unrelated(ui: ExtensionUIContext): boolean {\nreturn ui.theme === undefined;\n}\n`,
    diagnostic: ["forward.ts:10:", "[Error/typescript(no-unnecessary-condition)]"],
  },
  {
    name: "native Pi execute callback",
    source: executeSource,
    directive: executeDirective,
    operation: executeOperation,
    replacement: executeOperation.replace("nativeExecute", "localExecute"),
    authorized: {
      ...site,
      id: "QX-3004",
      rule: "eslint/max-params",
      scope: { type: "FunctionExpression", name: "nativeExecute" },
      nodeType: "FunctionExpression",
      path: [],
      operation: executeOperation,
    },
    neighbor: `${executeSource}export function unrelated(a: number, b: number, c: number, d: number, e: number): number {\nreturn a + b + c + d + e;\n}\n`,
    diagnostic: ["forward.ts:7:", "[Error/eslint(max-params)]"],
  },
];
const descriptorDirective =
  "// oxlint-disable-next-line unicorn/no-thenable -- QX-7001: JSON Schema conditional keyword, not a Promise thenable.";
const descriptorOperation = 'then: { required: ["limit"] }';
const descriptorSource = [
  "export const descriptor = {",
  "inputSchema: {",
  'type: "object" as const,',
  "allOf: [",
  "{",
  'if: { required: ["state"] },',
  descriptorDirective,
  `${descriptorOperation},`,
  "},",
  "],",
  "},",
  "};",
  "",
].join("\n");
const descriptorCase = {
  name: "JSON Schema conditional keyword",
  source: descriptorSource,
  directive: descriptorDirective,
  operation: descriptorOperation,
  replacement: 'then: () => ({ required: ["limit"] })',
  authorized: {
    ...site,
    id: "QX-7001",
    rule: "unicorn/no-thenable",
    scope: { type: "VariableDeclarator", name: "descriptor" },
    path: [
      "init",
      "properties",
      0,
      "value",
      "properties",
      1,
      "value",
      "elements",
      0,
      "properties",
      1,
    ],
    nodeType: "Property",
    operation: descriptorOperation,
  },
  neighbor: `${descriptorSource}export const unrelated = { if: { required: ["limit"] }, then: { required: ["state"] } };\n`,
  diagnostic: ["forward.ts:13:", "[Error/unicorn(no-thenable)]"],
};

describe("operation-bound exceptions", () => {
  it("accepts the exact published predicate directive", () => {
    const accepted = checkSource("forward.ts", positionalSource, [positionalSite]);
    expect(accepted.status, accepted.stderr).toBe(0);
    const acceptedLint = nativeLint(accepted.cwd);
    expect(acceptedLint.status, acceptedLint.stdout + acceptedLint.stderr).toBe(0);
  });

  it("rejects the unsuppressed published predicate with the native parameter diagnostic", () => {
    const unguarded = checkSource(
      "forward.ts",
      positionalSource.replace(`${positionalDirective}\n`, ""),
    );
    const unguardedLint = nativeLint(unguarded.cwd);
    expect(unguardedLint.status).toBe(1);
    expect(unguardedLint.stdout + unguardedLint.stderr).toContain(
      "forward.ts:2:30: Function 'isToolAllowed' has too many parameters (5). Maximum allowed is 4.",
    );
    expect(unguardedLint.stdout + unguardedLint.stderr).toContain("[Error/eslint(max-params)]");
  });

  it("retains the native parameter check on the published predicate's neighbor", () => {
    const neighbor = checkSource(
      "forward.ts",
      `${positionalSource}export function neighbor(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n`,
      [positionalSite],
    );
    expect(neighbor.status, neighbor.stderr).toBe(0);
    const neighborLint = nativeLint(neighbor.cwd);
    expect(neighborLint.status).toBe(1);
    expect(neighborLint.stdout + neighborLint.stderr).toContain(
      "forward.ts:15:25: Function 'neighbor' has too many parameters (5). Maximum allowed is 4.",
    );
    expect(neighborLint.stdout + neighborLint.stderr).toContain("[Error/eslint(max-params)]");
  });

  it("rejects the published predicate's unused directive with the native diagnostic", () => {
    const unused = checkSource(
      "forward.ts",
      positionalSource
        .replace("  excludeTools?: unknown,\n", "")
        .replace(
          "!isToolExcluded(toolName, serverName, prefix, excludeTools)",
          "!isToolExcluded(toolName, serverName, prefix)",
        ),
    );
    const unusedLint = nativeLint(unused.cwd);
    expect(unusedLint.status).toBe(1);
    expect(unusedLint.stdout + unusedLint.stderr).toContain(
      "forward.ts:2:1: Unused oxlint-disable directive (no problems were reported). [Error]",
    );
  });

  it.each([
    ["copied file", "copied.ts", positionalSource],
    [
      "wrong function",
      "forward.ts",
      positionalSource.replace("function isToolAllowed", "function other"),
    ],
    [
      "same-count replacement",
      "forward.ts",
      positionalSource.replace("includeTools?: unknown", "includeTools?: string[]"),
    ],
    ["wrong rule", "forward.ts", positionalSource.replace("eslint/max-params", "eslint/max-depth")],
    ["wrong decision", "forward.ts", positionalSource.replace("QX-022:", "QX-099:")],
    [
      "duplicate function",
      "forward.ts",
      `${positionalSource}${positionalDirective}\n${positionalOperation.replace("function isToolAllowed", "function other")}\n`,
    ],
    ["unused inventory", "forward.ts", positionalSource.replace(`${positionalDirective}\n`, "")],
  ])("rejects the positional API's %s", (_name, file, source) => {
    const result = checkSource(file, source, [positionalSite]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /not authorized|scope is missing|operation changed|unused exception/u,
    );
  });

  it.each([
    ...functionCases,
    ...hostCases,
    descriptorCase,
    {
      name: "native tool execute callback",
      source: directCallbackSource,
      authorized: directCallbackSite,
      neighbor: `${directCallbackSource}export function unrelated(a: string, b: string, c: string, d: string, e: string): string {\nreturn a + b + c + d + e;\n}\n`,
      diagnostic: ["forward.ts:12:", "[Error/eslint(max-params)]"],
    },
    {
      name: "stored failure",
      source: forward,
      authorized: site,
      neighbor: `${forward}export function unrelated(error: unknown): never {\nthrow error;\n}\n`,
      diagnostic:
        "forward.ts:6:7: Expected an error object to be thrown. [Error/typescript(only-throw-error)]",
    },
    {
      name: "transport send assignment",
      source: transportSource,
      authorized: {
        ...site,
        id: "QX-001",
        rule: "eslint/no-param-reassign",
        path: ["body", "body", 0, "expression", "left"],
        nodeType: "MemberExpression",
        operation: "transport.send",
      },
      neighbor: transportSource.replace(
        "return transport;",
        "transport.close = (value) => value + 1;\nreturn transport;",
      ),
      diagnostic:
        "forward.ts:4:1: Assignment to property of function parameter 'transport'. [Error/eslint(no-param-reassign)]",
    },
    {
      name: "native client error callback",
      source: clientSource,
      authorized: clientSite,
      neighbor: `${clientSource}export function unrelated(): AbortSignal {\nconst signal = new AbortController().signal;\nsignal.onabort = () => console.log("aborted");\nreturn signal;\n}\n`,
      diagnostic:
        "forward.ts:11:8: Prefer `addEventListener()` over their `on`-function counterparts. [Error/unicorn(prefer-add-event-listener)]",
    },
    {
      name: "native transport message callback",
      source: messageSource,
      authorized: {
        ...clientSite,
        scope: { type: "FunctionExpression", name: "observesTransportMessage" },
        path: ["body", "body", 1, "expression", "left"],
        operation: "transport.onmessage",
      },
      neighbor: `${messageSource}export function unrelated(): AbortSignal {\nconst signal = new AbortController().signal;\nsignal.onabort = () => console.log("aborted");\nreturn signal;\n}\n`,
      diagnostic:
        "forward.ts:10:8: Prefer `addEventListener()` over their `on`-function counterparts. [Error/unicorn(prefer-add-event-listener)]",
    },
    ...captures.map((capture) => ({
      name: capture.name,
      source: capture.source,
      authorized: capture.authorized,
      neighbor: `${capture.source}export const unrelated = ${capture.neighbor};\n`,
      diagnostic: ["forward.ts:5:", "[Error/typescript(unbound-method)]"],
    })),
    {
      name: "invalid runtime option assertion",
      source: invalidSource,
      authorized: {
        ...site,
        id: "QX-011",
        rule: "typescript/no-unsafe-type-assertion",
        scope: { type: "FunctionExpression", name: "invalidProtocolOptions" },
        path: ["body", "body", 0, "argument", "expression"],
        nodeType: "TSAsExpression",
        operation: "value as ServerEntry",
      },
      neighbor: `${invalidSource}export function unrelated(value: unknown): ServerEntry {\nreturn value as ServerEntry;\n}\n`,
      diagnostic:
        "forward.ts:9:8: Unsafe type assertion: type 'ServerEntry' is more narrow than the original type. [Error/typescript(no-unsafe-type-assertion)]",
    },
    {
      name: "legacy initialized capabilities",
      source: capabilitySource,
      authorized: {
        ...site,
        id: "QX-007",
        rule: "typescript/no-deprecated",
        scope: { type: "FunctionExpression", name: "reportClientCapabilities" },
        path: ["body", "body", 0],
        nodeType: "VariableDeclaration",
        operation: "const capabilities = server.server.getClientCapabilities();",
      },
      neighbor: capabilitySource.replace(
        "assert(capabilities !== undefined);",
        "server.server.getClientVersion();\nassert(capabilities !== undefined);",
      ),
      diagnostic: [
        "forward.ts:7:15: `getClientVersion` is deprecated.",
        "[Error/typescript(no-deprecated)]",
      ],
    },
    {
      name: "mutating configuration hook",
      source: transformSource,
      authorized: {
        ...site,
        id: "QX-012",
        rule: "eslint/no-param-reassign",
        scope: { type: "FunctionExpression", name: "transformsSuppliedConfig" },
        path: ["body", "body", 1, "expression", "left"],
        nodeType: "MemberExpression",
        operation: "config.mcpServers.docs.env.ORIGINAL",
      },
      neighbor: transformSource.replace(
        "return config;",
        "config.settings = { scriptMode: false };\nreturn config;",
      ),
      diagnostic:
        "forward.ts:7:1: Assignment to property of function parameter 'config'. [Error/eslint(no-param-reassign)]",
    },
    {
      name: "legacy elicitation initialized capabilities",
      source: capabilityFunctionSource,
      authorized: {
        ...site,
        id: "QX-007",
        rule: "typescript/no-deprecated",
        scope: { type: "FunctionDeclaration", name: "reportClientCapabilities" },
        path: ["body", "body", 0],
        nodeType: "VariableDeclaration",
        operation: "const capabilities = server.getClientCapabilities();",
      },
      neighbor: capabilityFunctionSource.replace(
        "return { content:",
        "server.getClientVersion();\nreturn { content:",
      ),
      diagnostic: [
        "forward.ts:7:8: `getClientVersion` is deprecated.",
        "[Error/typescript(no-deprecated)]",
      ],
    },
  ])(
    "qualifies $name attachment and neighboring native protection",
    ({ source, authorized, neighbor, diagnostic }) => {
      const accepted = checkSource("forward.ts", source, [authorized]);
      const unguarded = checkSource("forward.ts", neighbor, [authorized]);
      const nativeAccepted = nativeLint(accepted.cwd);
      const nativeRejected = nativeLint(unguarded.cwd);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(unguarded.status, unguarded.stderr).toBe(0);
      expect(nativeAccepted.status, nativeAccepted.stdout + nativeAccepted.stderr).toBe(0);
      expect(nativeRejected.status).toBe(1);
      const messages = Array.isArray(diagnostic) ? diagnostic : [diagnostic];
      for (const message of messages) {
        expect(nativeRejected.stdout + nativeRejected.stderr).toContain(message);
      }
    },
  );

  it.each([
    ["another file", "copied.ts", forward],
    ["another function", "forward.ts", forward.replace("function forward", "function unrelated")],
    [
      "another operation with the same directive count",
      "forward.ts",
      forward.replace("throw error;", "throw 42;"),
    ],
    [
      "another rule",
      "forward.ts",
      forward.replace("typescript/only-throw-error", "eslint/no-console"),
    ],
    ["another decision", "forward.ts", forward.replace("QX-009:", "QX-099:")],
    [
      "a range disable",
      "forward.ts",
      forward.replace("oxlint-disable-next-line", "oxlint-disable"),
    ],
    [
      "a blank line before the operation",
      "forward.ts",
      forward.replace("throw error;", "\nthrow error;"),
    ],
    [
      "a duplicate operation",
      "forward.ts",
      forward.replace("throw error;", `throw error;\n${directive}\nthrow error;`),
    ],
  ])("rejects %s", (_name, file, source) => {
    const result = checkSource(file, source, [site]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not authorized|scope is missing|operation changed/u);
  });

  it.each(functionCases)("rejects copied, replaced and duplicate $name operations", (entry) => {
    const copied = checkSource("copied.ts", entry.source, [entry.authorized]);
    const replaced = checkSource(
      "forward.ts",
      entry.source.replace(entry.operation, entry.replacement),
      [entry.authorized],
    );
    const implementation = entry.source.slice(entry.source.indexOf("export function"));
    const duplicate = checkSource(
      "forward.ts",
      entry.source + implementation.replace(entry.authorized.scope.name, "duplicate"),
      [entry.authorized],
    );
    expect(copied.status).toBe(1);
    expect(copied.stderr).toContain("lint directive is not authorized for this operation");
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain("Authorized operation changed");
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("lint directive is not authorized for this operation");
  });

  it("rejects a stale site without a directive", () => {
    const result = checkSource("forward.ts", forward.replace(`${directive}\n`, ""), [site]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unused exception site QX-009");
  });

  it.each(aggregateCases)("rejects an unused $name directive natively", (entry) => {
    const source = entry.source.replace(entry.operation, "throw cleanupError;");
    const result = checkSource("forward.ts", source, [entry.authorized]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorized operation changed");
    const native = nativeLint(result.cwd);
    expect(native.status).toBe(1);
    expect(native.stdout + native.stderr).toContain(
      "forward.ts:5:1: Unused oxlint-disable directive (no problems were reported). [Error]",
    );
  });

  it("requires the URL directive to suppress a real finding at the authorized site", () => {
    const entry = functionCases.find((candidate) => candidate.authorized.id === "QX-026");
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error("Missing native URL exception control");
    }
    const withoutDirective = entry.source.replace(/\/\/ oxlint-disable-next-line[^\n]*\n/u, "");
    const unsuppressed = checkSource("forward.ts", withoutDirective, [entry.authorized]);
    const nativeUnsuppressed = nativeLint(unsuppressed.cwd);
    expect(unsuppressed.status).toBe(1);
    expect(unsuppressed.stderr).toContain("unused exception site QX-026");
    expect(nativeUnsuppressed.status).toBe(1);
    expect(nativeUnsuppressed.stdout + nativeUnsuppressed.stderr).toContain("forward.ts:3:1:");
    expect(nativeUnsuppressed.stdout + nativeUnsuppressed.stderr).toContain(
      "[Error/eslint(no-new)]",
    );

    const unused = checkSource(
      "forward.ts",
      entry.source.replace(entry.operation, "URL.parse(resolved);"),
      [entry.authorized],
    );
    const nativeUnused = nativeLint(unused.cwd);
    expect(unused.status).toBe(1);
    expect(unused.stderr).toContain("Authorized operation changed");
    expect(nativeUnused.status).toBe(1);
    expect(nativeUnused.stdout + nativeUnused.stderr).toContain("Unused");
  });

  it.each([
    ["copied file", "copied.ts", directCallbackSource, "not authorized"],
    [
      "same-count replaced signature",
      "forward.ts",
      directCallbackSource.replace("signal, _onUpdate, ctx", "signal, ctx, _onUpdate"),
      "Authorized operation changed",
    ],
    [
      "wrong function",
      "forward.ts",
      directCallbackSource.replace("function execute(", "function unrelated("),
      "scope is missing",
    ],
    [
      "moved directive with the same count",
      "forward.ts",
      directCallbackSource
        .replace(`${directCallbackDirective}\n`, "")
        .concat(
          `${directCallbackDirective}\nexport function unrelated(a: number, b: number, c: number, d: number, e: number): number { return a + b + c + d + e; }\n`,
        ),
      "not authorized",
    ],
    [
      "duplicate callback",
      "forward.ts",
      directCallbackSource +
        directCallbackSource
          .slice(directCallbackSource.indexOf("export function"))
          .replace("createExecutor", "anotherExecutor"),
      "scope is missing or ambiguous",
    ],
    [
      "missing directive",
      "forward.ts",
      directCallbackSource.replace(`${directCallbackDirective}\n`, ""),
      "unused exception site QX-025",
    ],
  ])("rejects native callback %s", (_label, file, source, diagnostic) => {
    const result = checkSource(file, source, [directCallbackSite]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it("reports a native unused callback directive when the callback no longer needs it", () => {
    const source = directCallbackSource
      .replace("toolCallId, params, signal, _onUpdate, ctx", "toolCallId, params")
      .replace("toolCallId, params, signal, _onUpdate, hasUI: ctx.hasUI", "toolCallId, params");
    const result = checkSource("forward.ts", source, [directCallbackSite]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorized operation changed");
    const native = nativeLint(result.cwd);
    expect(native.status).toBe(1);
    expect(native.stdout + native.stderr).toContain("forward.ts:6:");
    expect(native.stdout + native.stderr).toContain(
      "Unused oxlint-disable directive (no problems were reported). [Error]",
    );
  });

  it.each([...hostCases, descriptorCase])(
    "rejects copied, replaced, duplicate and stale $name directives",
    (entry) => {
      const copied = checkSource("copied.ts", entry.source, [entry.authorized]);
      const replaced = checkSource(
        "forward.ts",
        entry.source.replace(entry.operation, entry.replacement),
        [entry.authorized],
      );
      const duplicate = checkSource(
        "forward.ts",
        entry.source.replace(entry.operation, `${entry.directive}\n${entry.operation}`),
        [entry.authorized],
      );
      const stale = checkSource("forward.ts", entry.source.replace(`${entry.directive}\n`, ""), [
        entry.authorized,
      ]);
      expect(copied.status, copied.stderr).toBe(1);
      expect(copied.stderr).toContain("lint directive is not authorized");
      expect(replaced.status, replaced.stderr).toBe(1);
      expect(replaced.stderr).toMatch(/Authorized operation changed|scope is missing/u);
      expect(duplicate.status, duplicate.stderr).toBe(1);
      expect(duplicate.stderr).toContain("lint directive is not authorized");
      expect(stale.status, stale.stderr).toBe(1);
      expect(stale.stderr).toContain("unused exception site");
    },
  );

  it("requires the descriptor directive to suppress a real no-thenable finding at its site", () => {
    const unsuppressed = checkSource(
      "forward.ts",
      descriptorSource.replace(`${descriptorDirective}\n`, ""),
      [descriptorCase.authorized],
    );
    const nativeUnsuppressed = nativeLint(unsuppressed.cwd);
    expect(unsuppressed.status).toBe(1);
    expect(unsuppressed.stderr).toContain("unused exception site QX-7001");
    expect(nativeUnsuppressed.status).toBe(1);
    expect(nativeUnsuppressed.stdout + nativeUnsuppressed.stderr).toContain(
      "forward.ts:7:1: Do not add `then` to an object. [Error/unicorn(no-thenable)]",
    );

    const unused = checkSource(
      "forward.ts",
      descriptorSource.replace(descriptorOperation, 'else: { required: ["limit"] }'),
      [descriptorCase.authorized],
    );
    const nativeUnused = nativeLint(unused.cwd);
    expect(unused.status).toBe(1);
    expect(unused.stderr).toContain("Authorized operation changed");
    expect(nativeUnused.status).toBe(1);
    expect(nativeUnused.stdout + nativeUnused.stderr).toContain(
      "forward.ts:7:1: Unused oxlint-disable directive (no problems were reported). [Error]",
    );
  });

  it("rejects wrong-origin, replaced and duplicate named callback operations", () => {
    const wrongOrigin = clientSource
      .replace('import { Client } from "@modelcontextprotocol/client";\n', "")
      .replace("client: Client", "client: AbortSignal")
      .replace('new Client({ name: "fixture", version: "1" })', "new AbortController().signal")
      .replace(
        "client.onerror = (error) => errors.push(error);",
        'client.onabort = () => errors.push(new Error("aborted"));',
      );
    const copied = checkSource("copied.ts", clientSource, [clientSite]);
    const replaced = checkSource("forward.ts", wrongOrigin, [clientSite]);
    const duplicate = checkSource(
      "forward.ts",
      clientSource +
        clientSource
          .slice(clientSource.indexOf("export const"))
          .replace("export const observe", "export const another"),
      [clientSite],
    );
    expect(copied.status).toBe(1);
    expect(copied.stderr).toContain("lint directive is not authorized for this operation");
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain("Authorized operation changed");
    const nativeWrongOrigin = nativeLint(replaced.cwd);
    expect(nativeWrongOrigin.status, nativeWrongOrigin.stdout + nativeWrongOrigin.stderr).toBe(0);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("Exception scope is missing or ambiguous");
  });

  it("rejects a changed enclosing condition even when operation and path are unchanged", () => {
    const guarded = {
      ...site,
      path: ["body", "body", 0, "consequent", "body", 0],
      guards: ["consequent: true"],
    };
    const source = `export function forward(error: unknown): never {\nif (false) {\n${directive}\nthrow error;\n}\nthrow error;\n}\n`;
    const result = checkSource("forward.ts", source, [guarded]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorized operation changed");
  });

  it.each(captures)("rejects copied, replaced and duplicate $name captures", (capture) => {
    const copied = checkSource("copied.ts", capture.source, [capture.authorized]);
    const replaced = checkSource(
      "forward.ts",
      capture.source.replace(capture.operation, capture.neighbor),
      [capture.authorized],
    );
    const duplicate = checkSource(
      "forward.ts",
      `${capture.source}\nfunction duplicate() {\nconst ${capture.variable} =\n${captureDirective}\n${capture.operation};\n}\n`,
      [capture.authorized],
    );
    expect(copied.status).toBe(1);
    expect(copied.stderr).toContain("lint directive is not authorized for this operation");
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain("Authorized operation changed");
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("Exception scope is missing or ambiguous");
  });
});
