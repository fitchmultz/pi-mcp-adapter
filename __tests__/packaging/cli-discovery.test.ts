import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("CLI config and git-root OpenCode discovery", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers native Pi configs and ancestor git-root opencode.json from subdirectories", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-cli-discovery-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const outerDir = join(root, "outer");
    const repoRoot = join(outerDir, "repo");
    const nestedCwd = join(repoRoot, "packages", "web");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });

    execFileSync("git", ["init", "-q"], { cwd: repoRoot });

    writeJson(join(agentDir, "mcp.json"), { mcpServers: { globalNative: { command: "echo" } } });
    writeJson(join(repoRoot, ".pi", "mcp.json"), {
      mcpServers: { projNative: { command: "echo" } },
    });
    writeJson(join(repoRoot, "opencode.json"), {
      mcp: { repoOpenCode: { type: "local", command: ["echo", "hi"] } },
    });
    // Above the .git boundary: should NOT be walked into!
    writeJson(join(outerDir, "opencode.json"), {
      mcp: { outerOpenCode: { type: "local", command: ["echo", "outer"] } },
    });

    const result = spawnSync(process.execPath, [resolve("cli.js"), "init", "--dry-run"], {
      cwd: nestedCwd,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    });

    const realRepoRoot = realpathSync(repoRoot);
    const realOuterDir = realpathSync(outerDir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`User-global native Pi MCP: ${join(agentDir, "mcp.json")}`);
    expect(result.stdout).toContain(
      `Project native Pi MCP: ${join(realRepoRoot, ".pi", "mcp.json")}`,
    );
    expect(result.stdout).toContain(`opencode: ${join(realRepoRoot, "opencode.json")}`);
    expect(result.stdout).not.toContain(join(realOuterDir, "opencode.json"));
  });
});
