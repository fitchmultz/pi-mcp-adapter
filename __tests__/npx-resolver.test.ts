import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

describe("npx-resolver", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalNpmCache = process.env.NPM_CONFIG_CACHE;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("cross-spawn");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalNpmCache === undefined) {
      delete process.env.NPM_CONFIG_CACHE;
    } else {
      process.env.NPM_CONFIG_CACHE = originalNpmCache;
    }
  });

  it("writes mcp-npx-cache.json to the owned root under PI_CODING_AGENT_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "demo-pkg");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(result).not.toBeNull();
    expect(existsSync(join(agentDir, "fitch-mcp-adapter", "mcp-npx-cache.json"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "fitch-mcp-adapter", "mcp-npx-cache.json"))).toBe(
      false,
    );
  });

  it("uses async cross-spawn to read npm's cache directory without sync blocking", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NPM_CONFIG_CACHE;

    const binPath = writeCachedPackage(npmCache, "demo-pkg");
    const crossSpawn = vi.fn<() => ChildProcess>(() => fakeStdoutChild(`${npmCache}\n`));
    const sync = vi.fn<() => void>();
    Object.assign(crossSpawn, { sync });
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(sync).not.toHaveBeenCalled();
    expect(crossSpawn).toHaveBeenCalledWith("npm", ["config", "get", "cache"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    expect(result?.binPath).toBe(binPath);
  });

  it("uses cross-spawn to populate npm's npx cache on the slow path", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NPM_CONFIG_CACHE;

    const crossSpawn = vi.fn<(cmd: string, args: string[]) => ChildProcess>((_cmd, args) => {
      if (args[0] === "config") {
        return fakeStdoutChild(`${npmCache}\n`);
      }
      const proc = new ChildProcess();
      writeCachedPackage(npmCache, "demo-pkg");
      queueMicrotask(() => proc.emit("close", 0, null));
      return proc;
    });
    const sync = vi.fn<() => void>();
    Object.assign(crossSpawn, { sync });
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(sync).not.toHaveBeenCalled();
    expect(crossSpawn).toHaveBeenCalledWith(
      "npm",
      ["exec", "--yes", "--package", "demo-pkg", "--", "node", "-e", "1"],
      { stdio: "ignore" },
    );
    expect(result).not.toBeNull();
  });

  it("preserves npx separators for wrapper package arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "dotenv-cli");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", [
      "--yes",
      "dotenv-cli",
      "--",
      "npx",
      "--yes",
      "@upstash/context7-mcp",
    ]);

    expect(result?.extraArgs).toEqual(["--", "npx", "--yes", "@upstash/context7-mcp"]);
  });

  it("does not add separators to npx invocations that did not include one", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "dotenv-cli");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", [
      "--yes",
      "dotenv-cli",
      "github-mcp-server",
      "stdio",
    ]);

    expect(result?.extraArgs).toEqual(["github-mcp-server", "stdio"]);
  });

  it("honors exact scoped package versions when a newer cache directory contains the wrong version", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "@scope/pkg", "2.0.0", "correct");
    writeCachedPackage(npmCache, "@scope/pkg", "1.0.0", "old");
    const newer = new Date(Date.now() + 10_000);
    utimesSync(join(npmCache, "_npx", "old"), newer, newer);

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "@scope/pkg@2.0.0"]);

    expect(result?.binPath).toBe(correctBin);
  });

  it("honors exact unscoped package versions when a newer cache directory contains the wrong version", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
    writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
    const newer = new Date(Date.now() + 10_000);
    utimesSync(join(npmCache, "_npx", "old"), newer, newer);

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "plainpkg@2.0.0"]);

    expect(result?.binPath).toBe(correctBin);
  });

  it.each(["plainpkg@v2.0.0", "plainpkg@=2.0.0"])(
    "honors npm exact version spelling %s",
    async (packageSpec) => {
      const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
      const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
      const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.NPM_CONFIG_CACHE = npmCache;

      const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
      writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
      const newer = new Date(Date.now() + 10_000);
      utimesSync(join(npmCache, "_npx", "old"), newer, newer);

      const { resolveNpxBinary } = await import("../npx-resolver.ts");
      const result = await resolveNpxBinary("npx", ["-y", packageSpec]);

      expect(result?.binPath).toBe(correctBin);
    },
  );

  it.each([
    ["npx", ["-y", "plainpkg@^2.0.0"], "plainpkg"],
    ["npm", ["exec", "--package", "plainpkg@~2.0.0", "--", "plainpkg"], "plainpkg"],
    ["npx", ["-y", "@scope/pkg@2.x"], "@scope/pkg"],
    ["npx", ["-y", "plainpkg@latest"], "plainpkg"],
  ])(
    "leaves %s %j to npm even with an incompatible cached binary",
    async (command, args, packageName) => {
      const root = mkdtempSync(join(tmpdir(), "pi-mcp-npx-range-"));
      const agentDir = join(root, "agent");
      const npmCache = join(root, "npm");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.NPM_CONFIG_CACHE = npmCache;

      try {
        const wrongBin = writeCachedPackage(npmCache, packageName, "1.0.0");
        const crossSpawn = vi.fn<() => void>();
        Object.assign(crossSpawn, { sync: vi.fn<() => void>() });
        vi.doMock("cross-spawn", () => ({ default: crossSpawn }));
        const { resolveNpxBinary } = await import("../npx-resolver.ts");

        expect(await resolveNpxBinary(command, args)).toBeNull();

        // Old adapter versions may have persisted the incompatible resolution.
        mkdirSync(join(agentDir, "fitch-mcp-adapter"), { recursive: true });
        writeFileSync(
          join(agentDir, "fitch-mcp-adapter", "mcp-npx-cache.json"),
          JSON.stringify({
            version: 1,
            entries: {
              [JSON.stringify([command, ...args])]: {
                resolvedBin: wrongBin,
                resolvedAt: Date.now(),
                packageVersion: "1.0.0",
                isJs: true,
              },
            },
          }),
        );
        expect(await resolveNpxBinary(command, args)).toBeNull();
        expect(crossSpawn).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("ignores poisoned persistent cache entries for exact version requests", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
    const wrongBin = writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
    mkdirSync(join(agentDir, "fitch-mcp-adapter"), { recursive: true });
    writeFileSync(
      join(agentDir, "fitch-mcp-adapter", "mcp-npx-cache.json"),
      JSON.stringify({
        version: 1,
        entries: {
          [JSON.stringify(["npx", "-y", "plainpkg@2.0.0"])]: {
            resolvedBin: wrongBin,
            resolvedAt: Date.now(),
            packageVersion: "1.0.0",
            isJs: true,
          },
        },
      }),
      "utf-8",
    );

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "plainpkg@2.0.0"]);
    const cache: unknown = JSON.parse(
      readFileSync(join(agentDir, "fitch-mcp-adapter", "mcp-npx-cache.json"), "utf-8"),
    );

    expect(result?.binPath).toBe(correctBin);
    expect(cache).toMatchObject({
      entries: { [JSON.stringify(["npx", "-y", "plainpkg@2.0.0"])]: { packageVersion: "2.0.0" } },
    });
  });

  it("deduplicates concurrent npm config get cache lookups without calling crossSpawn.sync", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NPM_CONFIG_CACHE;

    const binA = writeCachedPackage(npmCache, "pkg-alpha", "1.0.0", "alpha");
    const binB = writeCachedPackage(npmCache, "pkg-beta", "1.0.0", "beta");
    let releaseConfig!: () => void;
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    const crossSpawn = vi.fn<() => ChildProcess>(() => {
      const proc = new ChildProcess();
      const stdout = new PassThrough();
      proc.stdout = stdout;
      configGate
        .then(() => {
          stdout.end(`${npmCache}\n`);
          proc.emit("close", 0, null);
        })
        .catch(() => {
          // Test gate never rejects.
        });
      return proc;
    });
    const sync = vi.fn<() => void>();
    Object.assign(crossSpawn, { sync });
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const first = resolveNpxBinary("npx", ["-y", "pkg-alpha"]);
    const second = resolveNpxBinary("npx", ["-y", "pkg-beta"]);
    releaseConfig();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(sync).not.toHaveBeenCalled();
    expect(crossSpawn).toHaveBeenCalledTimes(1);
    expect(resultA?.binPath).toBe(binA);
    expect(resultB?.binPath).toBe(binB);
  });

  it.each(["/usr/local/bin/npx", "/opt/homebrew/bin/npx"])(
    "resolves absolute npx executable path %s",
    async (npxPath) => {
      const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
      const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
      const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.NPM_CONFIG_CACHE = npmCache;

      const binPath = writeCachedPackage(npmCache, "abs-pkg");
      const { resolveNpxBinary } = await import("../npx-resolver.ts");
      const result = await resolveNpxBinary(npxPath, ["-y", "abs-pkg"]);

      expect(result?.binPath).toBe(binPath);
    },
  );

  it.each(["bunx", "/opt/homebrew/bin/bunx", "pnpx", "/usr/local/bin/pnpx"])(
    "leaves %s untouched without spawning npm",
    async (command) => {
      const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
      const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
      const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.NPM_CONFIG_CACHE = npmCache;

      writeCachedPackage(npmCache, "demo-pkg");
      const crossSpawn = vi.fn<() => void>();
      const sync = vi.fn<() => void>();
      Object.assign(crossSpawn, { sync });
      vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

      const { resolveNpxBinary } = await import("../npx-resolver.ts");
      expect(await resolveNpxBinary(command, ["-y", "demo-pkg"])).toBeNull();
      expect(crossSpawn).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    },
  );

  it("escalates hung forceNpxCache child processes from SIGTERM to SIGKILL", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const proc = new ChildProcess();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    vi.spyOn(proc, "kill").mockImplementation((sig) => {
      signals.push(sig);
      return true;
    });
    const crossSpawn = vi.fn<() => ChildProcess>(() => proc);
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { resolveNpxBinary } = await import("../npx-resolver.ts");
      const controller = new AbortController();
      const pending = resolveNpxBinary("npx", ["-y", "missing-pkg"], controller.signal);
      const settled = pending.catch((error: unknown) => error);
      await expect.poll(() => crossSpawn.mock.calls.length).toBe(1);

      controller.abort(new Error("cancel npx"));
      expect(await settled).toMatchObject({ message: "cancel npx" });
      expect(signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeStdoutChild(output: string): ChildProcess {
  const proc = new ChildProcess();
  const stdout = new PassThrough();
  proc.stdout = stdout;
  queueMicrotask(() => {
    stdout.end(output);
    proc.emit("close", 0, null);
  });
  return proc;
}

function writeCachedPackage(
  npmCache: string,
  packageName: string,
  version = "1.0.0",
  cacheId = "fixture",
): string {
  const packageDir = join(npmCache, "_npx", cacheId, "node_modules", packageName);
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version, bin: "bin/cli.js" }),
    "utf-8",
  );
  const binPath = join(packageDir, "bin", "cli.js");
  writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok')\n", "utf-8");
  return binPath;
}
