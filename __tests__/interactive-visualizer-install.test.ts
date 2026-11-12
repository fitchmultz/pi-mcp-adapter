import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withStorageLock } from "../storage-lock.ts";

const example = fileURLToPath(new URL("../examples/interactive-visualizer/", import.meta.url));
const disappearingConfig = fileURLToPath(
  new URL("./fixtures/interactive-visualizer-disappearing-config.mjs", import.meta.url),
);
const server = join(example, "dist", "server.js");
const serverName = "interactive-visualizer";
const installedEntry = { command: process.execPath, args: [server], lifecycle: "lazy" };
const initial = {
  settings: { unrelated: true },
  extra: [1, { preserved: "✓" }],
  mcpServers: { other: { command: "retained", args: ["space arg"] }, opaque: [null, 3] },
};
const directories: string[] = [];

function fixture(configuredAgentDir?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-example-install-")));
  directories.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.PI_CODING_AGENT_DIR;
  if (configuredAgentDir !== undefined) {
    env.PI_CODING_AGENT_DIR = configuredAgentDir.replace("$ROOT", root);
  }
  return {
    root,
    cwd,
    run(script: "install" | "uninstall", disappearAt?: string) {
      const preload = disappearAt === undefined ? [] : ["--import", disappearingConfig];
      return spawnSync(
        process.execPath,
        [...preload, join(example, "scripts", `${script}-local.mjs`)],
        {
          cwd,
          env: { ...env, PI_MCP_EXAMPLE_DISAPPEAR_PATH: disappearAt },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    },
  };
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readConfig(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("standalone interactive visualizer installation", () => {
  it("shares the adapter's config lock before reading or writing an install", () => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    writeConfig(path, initial);
    const original = readFileSync(path);
    withStorageLock(`${path}.lock.sqlite`, () => {
      const install = f.run("install");
      expect(install.status).not.toBe(0);
      expect(install.stderr).toContain("database is locked");
      const uninstall = f.run("uninstall");
      expect(uninstall.status).not.toBe(0);
      expect(uninstall.stderr).toContain("database is locked");
      expect(readFileSync(path)).toEqual(original);
    });
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual({
      ...initial,
      mcpServers: { ...initial.mcpServers, [serverName]: installedEntry },
    });
  });

  it.each([
    { mode: "default", configured: undefined, agent: "home/.pi/agent" },
    { mode: "absolute", configured: "  $ROOT/custom-agent  ", agent: "custom-agent" },
    { mode: "relative", configured: "custom-agent", agent: "project/custom-agent" },
    { mode: "tilde", configured: "~", agent: "home" },
    { mode: "tilde child", configured: "~/custom-agent", agent: "home/custom-agent" },
  ])("preserves unrelated config and idempotency with $mode paths", ({ configured, agent }) => {
    const f = fixture(configured);
    const path = resolve(f.root, agent, "fitch-mcp-adapter", "mcp.json");
    expect(f.run("uninstall")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `No MCP config found at ${path}\n`,
    });
    expect(existsSync(path)).toBe(false);

    writeConfig(path, initial);
    chmodSync(path, 0o600);
    const original = readFileSync(path, "utf8");
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual({
      ...initial,
      mcpServers: { ...initial.mcpServers, [serverName]: installedEntry },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const installed = readFileSync(path);
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(path)).toEqual(installed);

    expect(f.run("uninstall")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual(initial);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const removed = readFileSync(path);
    expect(f.run("uninstall")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `${serverName} is not installed in ${path}\n`,
    });
    expect(readFileSync(path)).toEqual(removed);

    rmSync(path);
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual({ mcpServers: { [serverName]: installedEntry } });
  });

  it("keeps own __proto__ keys, unknown settings and other server definitions byte for byte", () => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    const start = [
      "{",
      '  "__proto__": {',
      '    "mcpServers": {',
      '      "fromProto": {',
      '        "command": "proto"',
      "      }",
      "    }",
      "  },",
      '  "settings": {',
      '    "__proto__": {',
      '      "toolPrefix": "short"',
      "    },",
      '    "nested": {',
      '      "__proto__": [',
      "        null,",
      "        true",
      "      ]",
      "    }",
      "  },",
      '  "mcpServers": {',
      '    "__proto__": {',
      '      "command": "proto-server"',
      "    },",
      '    "other": {',
      '      "command": "retained",',
      '      "__proto__": {',
      '        "env": {',
      '          "A": "1"',
      "        }",
      "      }",
      "    }",
    ];
    const end = ["  },", '  "after": "✓"', "}", ""];
    const original = [...start, ...end].join("\n");
    const installed = [
      ...start.slice(0, -1),
      "    },",
      `    "${serverName}": {`,
      `      "command": ${JSON.stringify(process.execPath)},`,
      '      "args": [',
      `        ${JSON.stringify(server)}`,
      "      ],",
      '      "lifecycle": "lazy"',
      "    }",
      ...end,
    ].join("\n");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);

    expect(f.run("install")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `Installed ${serverName} at ${path}\n`,
    });
    expect(readFileSync(path, "utf8")).toBe(installed);
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(path, "utf8")).toBe(installed);
    expect(f.run("uninstall")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `Removed ${serverName} from ${path}\n`,
    });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(f.run("uninstall")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `${serverName} is not installed in ${path}\n`,
    });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each([
    { command: process.execPath, args: ["/another/server.js"] },
    { command: "another-node", args: [server] },
    { command: process.execPath, args: ["--flag", server] },
  ])("leaves a foreign entry untouched: $command $args", (entry) => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    writeConfig(path, { ...initial, mcpServers: { ...initial.mcpServers, [serverName]: entry } });
    const before = readFileSync(path);
    expect(f.run("install")).toMatchObject({
      status: 1,
      stderr: `Refusing to overwrite existing ${serverName} entry in ${path} because it does not match this local example install.\n`,
    });
    expect(readFileSync(path)).toEqual(before);
    expect(f.run("uninstall")).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `Left ${serverName} unchanged because the existing entry does not match this local example install.\n`,
    });
    expect(readFileSync(path)).toEqual(before);
  });

  it("matches only the command and first argument when installing or removing its own entry", () => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    const config = {
      ...initial,
      mcpServers: {
        ...initial.mcpServers,
        [serverName]: { ...installedEntry, args: [server, "extra-arg"], extra: true },
      },
    };
    writeConfig(path, config);
    expect(f.run("install")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual({
      ...initial,
      mcpServers: { ...initial.mcpServers, [serverName]: installedEntry },
    });
    writeConfig(path, config);
    expect(f.run("uninstall")).toMatchObject({ status: 0, stderr: "" });
    expect(readConfig(path)).toEqual(initial);
  });

  it("handles a write-time ENOENT only at the original uninstall boundary", () => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    const config = { mcpServers: { [serverName]: installedEntry } };
    writeConfig(path, config);
    expect(f.run("uninstall", path)).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `No MCP config found at ${path}\n`,
    });
    expect(existsSync(dirname(path))).toBe(false);

    writeConfig(path, config);
    const install = f.run("install", path);
    expect(install.status).toBe(1);
    expect(install.stderr).toContain("ENOENT");
    expect(existsSync(dirname(path))).toBe(false);
  });

  it.each([
    { document: "{invalid-json", error: "SyntaxError" },
    { document: "null", error: "ZodError" },
    { document: "[]", error: "ZodError" },
    { document: '{"mcpServers":[]}', error: "ZodError" },
  ])("rejects a malformed document without writing: $document", ({ document, error }) => {
    const f = fixture("agent");
    const path = join(f.cwd, "agent", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, document);
    const install = f.run("install");
    expect(install.status).toBe(1);
    expect(install.stderr).toContain(error);
    expect(readFileSync(path, "utf8")).toBe(document);
    const uninstall = f.run("uninstall");
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain(error);
    expect(readFileSync(path, "utf8")).toBe(document);
  });
});
