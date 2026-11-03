import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";

type CliMain = (
  argv: string[],
  log: (line: string) => void,
  error: (line: string) => void,
) => Promise<number>;

async function loadMain(): Promise<CliMain> {
  return (await import("../../cli.js")).main;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("cli init helper", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    // Cases that exercise an explicit agentDir set it after choosing their HOME.
    delete process.env.PI_CODING_AGENT_DIR;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    process.chdir(originalCwd);
  });

  it("adds detected host imports to the Pi config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".claude", "mcp.json"), {
      mcpServers: {
        claudeServer: { command: "claude" },
      },
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["init"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);

    const piConfigPath = join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json");
    expect(existsSync(piConfigPath)).toBe(true);
    const config = z
      .object({ imports: z.array(z.string()) })
      .parse(JSON.parse(readFileSync(piConfigPath, "utf-8")));
    expect(config.imports).toContain("claude-code");
    expect(logs.join("\n")).toContain("Updated");
  });

  it("detects TOML-only Codex config during dry-run", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-codex-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-codex-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const codexConfigPath = join(home, ".codex", "config.toml");
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(
      codexConfigPath,
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n',
      "utf-8",
    );

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["init", "--dry-run"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain(`codex: ${codexConfigPath}`);
    expect(logs.join("\n")).toContain("Detected host configs to import into Pi: codex");
    expect(existsSync(join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json"))).toBe(false);
  });

  it("loads existing Pi config as JSONC and lists .agents standard paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-project-"));
    process.env.HOME = home;
    process.chdir(project);

    mkdirSync(join(home, ".pi", "agent", "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json"),
      `{
      // Existing config stays editable by humans.
      "imports": ["vscode",],
      "mcpServers": {
        "existing": { "command": "existing" },
      },
    }`,
      "utf-8",
    );

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["init", "--dry-run"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const output = logs.join("\n");
    expect(output).toContain(`User-global .agents MCP: ${join(home, ".agents", "mcp.json")}`);
    expect(output).toContain(
      `User-global .agents nested MCP: ${join(home, ".agents", "mcp", "mcp.json")}`,
    );
    expect(output).toContain("No Pi config changes needed.");
  });

  it("explicitly enables host fallback discovery without changing external files", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-discovery-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-discovery-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const hostPath = join(home, ".cursor", "mcp.json");
    writeJson(hostPath, { mcpServers: { cursorServer: { command: "cursor" } } });

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["init", "--discover-host-configs"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const piConfigPath = join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json");
    const config = z
      .object({ settings: z.unknown() })
      .parse(JSON.parse(readFileSync(piConfigPath, "utf-8")));
    expect(config.settings).toEqual({
      hostConfigDiscovery: "on",
    });
    expect(readFileSync(hostPath, "utf-8")).toContain("cursorServer");
    expect(logs.join("\n")).toContain("Opting in to host-specific fallback discovery");
  });

  it.each([
    {
      preserved: "property order",
      document: `${JSON.stringify(
        {
          imports: ["vscode"],
          settings: { toolPrefix: "short", hostConfigDiscovery: "off" },
          custom: 1,
          mcpServers: { existing: { command: "existing" } },
        },
        null,
        2,
      )}\n`,
      expected: [
        "{",
        '  "imports": [',
        '    "vscode",',
        '    "cursor"',
        "  ],",
        '  "settings": {',
        '    "toolPrefix": "short",',
        '    "hostConfigDiscovery": "on"',
        "  },",
        '  "custom": 1,',
        '  "mcpServers": {',
        '    "existing": {',
        '      "command": "existing"',
        "    }",
        "  }",
        "}",
        "",
      ],
    },
    {
      preserved: "own __proto__ keys, nested settings and unrelated servers",
      document:
        '{"__proto__":{"mcpServers":{"fromProto":{"command":"proto"}}},"imports":["vscode"],' +
        '"settings":{"__proto__":{"hostConfigDiscovery":"on"},"nested":{"__proto__":{"keep":true}}},' +
        '"mcpServers":{"__proto__":{"command":"proto-server"},' +
        '"other":{"command":"retained","args":["space arg"],"__proto__":{"env":{"A":"1"}}},' +
        '"opaque":[null,3]}}',
      expected: [
        "{",
        '  "__proto__": {',
        '    "mcpServers": {',
        '      "fromProto": {',
        '        "command": "proto"',
        "      }",
        "    }",
        "  },",
        '  "imports": [',
        '    "vscode",',
        '    "cursor"',
        "  ],",
        '  "settings": {',
        '    "__proto__": {',
        '      "hostConfigDiscovery": "on"',
        "    },",
        '    "nested": {',
        '      "__proto__": {',
        '        "keep": true',
        "      }",
        "    },",
        '    "hostConfigDiscovery": "on"',
        "  },",
        '  "mcpServers": {',
        '    "__proto__": {',
        '      "command": "proto-server"',
        "    },",
        '    "other": {',
        '      "command": "retained",',
        '      "args": [',
        '        "space arg"',
        "      ],",
        '      "__proto__": {',
        '        "env": {',
        '          "A": "1"',
        "        }",
        "      }",
        "    },",
        '    "opaque": [',
        "      null,",
        "      3",
        "    ]",
        "  }",
        "}",
        "",
      ],
    },
  ])(
    "keeps the existing Pi config $preserved when it adds imports and discovery",
    async ({ document, expected }) => {
      const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-order-home-"));
      const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-order-project-"));
      process.env.HOME = home;
      process.chdir(project);
      writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: {} });
      const piConfigPath = join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json");
      mkdirSync(dirname(piConfigPath), { recursive: true });
      writeFileSync(piConfigPath, document, "utf-8");

      const logs: string[] = [];
      const errors: string[] = [];
      const main = await loadMain();
      const exitCode = await main(
        ["init", "--discover-host-configs"],
        (line) => logs.push(line),
        (line) => errors.push(line),
      );

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(logs).toContain(`Updated ${piConfigPath}`);
      expect(readFileSync(piConfigPath, "utf-8")).toBe(expected.join("\n"));
    },
  );

  it.each([
    {
      input: "an array document",
      document: "[]",
      argv: ["init", "--discover-host-configs"],
      path: [],
    },
    {
      input: "a string settings container",
      document: '{"settings":"on"}',
      argv: ["init", "--discover-host-configs"],
      path: ["settings"],
    },
    {
      input: "an array settings container when only imports change",
      document: '{"settings":["on"]}',
      argv: ["init"],
      path: ["settings"],
    },
  ])("rejects $input before writing the Pi config", async ({ document, argv, path }) => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-malformed-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-malformed-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: {} });
    const piConfigPath = join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json");
    mkdirSync(dirname(piConfigPath), { recursive: true });
    writeFileSync(piConfigPath, document, "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    await expect(
      main(
        argv,
        (line) => logs.push(line),
        (line) => errors.push(line),
      ),
    ).rejects.toMatchObject({ name: "ZodError", issues: [{ code: "invalid_type", path }] });

    expect(readFileSync(piConfigPath, "utf-8")).toBe(document);
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("writes detected host imports to PI_CODING_AGENT_DIR when set", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-agent-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(project);

    writeJson(join(home, ".claude", "mcp.json"), {
      mcpServers: {
        claudeServer: { command: "claude" },
      },
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["init"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);

    const piConfigPath = join(agentDir, "fitch-mcp-adapter", "mcp.json");
    expect(existsSync(piConfigPath)).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp.json"))).toBe(false);
    const config = z
      .object({ imports: z.array(z.string()) })
      .parse(JSON.parse(readFileSync(piConfigPath, "utf-8")));
    expect(config.imports).toContain("claude-code");
    expect(logs.join("\n")).toContain(piConfigPath);
  });

  it("runs when invoked through a symlinked bin path", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-bin-"));
    const symlinkPath = join(binDir, "fitch-mcp-adapter");
    symlinkSync(resolve("cli.js"), symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath, "init", "--dry-run"], {
      cwd: mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-")),
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      },
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Config discovery:");
    expect(result.stdout).toContain("No Pi config changes needed.");
  });

  it("explains that install now goes through `pi install`", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const main = await loadMain();
    const exitCode = await main(
      ["install"],
      (line) => logs.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Use `pi install npm:@fitchmultz/pi-mcp-adapter` instead");
    expect(logs).toEqual([]);
  });
});

describe("native contract launcher", () => {
  it("prints native contract help through a symlinked script directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-native-bin-"));
    try {
      const scripts = join(root, "scripts");
      symlinkSync(resolve("scripts"), scripts, "junction");
      const result = spawnSync(
        process.execPath,
        [join(scripts, "compat-native-tools.mjs"), "--help"],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: node scripts/compat-native-tools.mjs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
