import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConfigWithDiagnostics } from "../config-diagnostics.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

describe("MCP per-entry config validation and single-pass discovery", () => {
  it("isolates invalid server entries, settings, and imports while preserving valid siblings", async () => {
    const home = makeTempDir("pi-mcp-diag-home-");
    const project = makeTempDir("pi-mcp-diag-proj-");
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

    const projectConfig = join(project, ".mcp.json");
    writeJsonFile(projectConfig, {
      imports: ["cursor", "unsupported-host"],
      settings: {
        toolPrefix: "short",
        requestTimeoutMs: 0,
        idleTimeout: -2,
        outputGuard: { maxBytes: -10, maxLines: 500 },
      },
      mcpServers: {
        alpha: { url: "https://alpha.example.test/mcp" },
        broken: { command: 42 },
        beta: { command: "node", args: ["server.js"] },
      },
    });

    vi.resetModules();
    const { loadMcpConfig } = await import("../config.ts");
    const loaded = loadMcpConfig(undefined, project);
    expect(Object.keys(loaded.mcpServers)).toEqual(["alpha", "beta"]);
    expect(loaded.imports).toEqual(["cursor"]);
    expect(loaded.settings).toEqual({
      toolPrefix: "short",
      outputGuard: { maxLines: 500 },
    });

    const errors = loaded.configErrors ?? [];
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          kind: "invalid_server",
          serverName: "broken",
          field: "command",
        }),
        expect.objectContaining({
          severity: "error",
          kind: "invalid_numeric_bound",
          field: "requestTimeoutMs",
        }),
        expect.objectContaining({
          severity: "error",
          kind: "invalid_numeric_bound",
          field: "idleTimeout",
        }),
        expect.objectContaining({
          severity: "error",
          kind: "invalid_numeric_bound",
          field: "outputGuard.maxBytes",
        }),
        expect.objectContaining({
          severity: "error",
          kind: "invalid_import",
          field: "imports",
        }),
      ]),
    );
  });

  it("rejects NaN, Infinity, non-positive timeouts, and negative limits while allowing 0 for non-negative limits", () => {
    const filePath = "/tmp/test-mcp.json";
    const bad = validateConfigWithDiagnostics(
      {
        settings: {
          requestTimeoutMs: Number.NaN,
          idleTimeout: -0.5,
          outputGuard: { maxBytes: Number.POSITIVE_INFINITY, maxLines: -1, detailsMaxBytes: 0 },
          trace: { maxBytes: -1, maxEvents: Number.NaN },
        },
        mcpServers: {
          s1: {
            url: "https://example.test/mcp",
            requestTimeoutMs: -100,
          },
          s2: {
            url: "https://example.test/mcp2",
            oauth: {
              privateKeyJwt: {
                privateKey: "pem",
                algorithm: "RS256",
                lifetimeSeconds: 0,
              },
            },
          },
          s3: {
            command: "node",
            idleTimeout: 0,
            requestTimeoutMs: 5000,
          },
        },
      },
      filePath,
    );

    expect(Object.keys(bad.config.mcpServers)).toEqual(["s3"]);
    expect(bad.config.settings?.outputGuard).toEqual({ detailsMaxBytes: 0 });
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "requestTimeoutMs" }),
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "idleTimeout" }),
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "outputGuard.maxBytes" }),
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "outputGuard.maxLines" }),
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "trace.maxBytes" }),
        expect.objectContaining({ kind: "invalid_numeric_bound", field: "trace.maxEvents" }),
        expect.objectContaining({
          kind: "invalid_numeric_bound",
          serverName: "s1",
          field: "requestTimeoutMs",
        }),
        expect.objectContaining({
          kind: "invalid_numeric_bound",
          serverName: "s2",
          field: "oauth.privateKeyJwt.lifetimeSeconds",
        }),
      ]),
    );
  });

  it("records unknown and typo key warnings with helpful placement hints", () => {
    const result = validateConfigWithDiagnostics(
      {
        directTool: true,
        timeout: 1000,
        settings: { disable: true, timeout: -5 },
        mcpServers: {
          srv: {
            url: "https://example.test/mcp",
            directTool: true,
            disable: true,
            timeout: 5000,
            oauth: { clientId: "id", extraAuthField: "x" },
          },
        },
      },
      "/tmp/typo.json",
    );

    expect(result.config.mcpServers.srv).toBeDefined();
    const topDirectTool = result.errors.find(
      (e) =>
        e.severity === "warning" &&
        e.kind === "unknown_key" &&
        e.field === "directTool" &&
        e.serverName === undefined,
    );
    expect(topDirectTool?.message).toContain("settings.directTools");
    const srvDirectTool = result.errors.find(
      (e) =>
        e.severity === "warning" &&
        e.kind === "unknown_key" &&
        e.field === "directTool" &&
        e.serverName === "srv",
    );
    expect(srvDirectTool?.message).toContain("directTools");
    const oauthExtra = result.errors.find(
      (e) =>
        e.severity === "warning" &&
        e.kind === "unknown_key" &&
        e.field === "oauth.extraAuthField" &&
        e.serverName === "srv",
    );
    expect(oauthExtra?.message).toContain('server "srv" oauth');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          kind: "unknown_key",
          field: "disable",
        }),
        expect.objectContaining({
          severity: "error",
          kind: "invalid_numeric_bound",
          field: "timeout",
        }),
      ]),
    );
  });

  it("reads each config file at most once per snapshot and reports blocked untrusted project servers", async () => {
    const home = makeTempDir("pi-mcp-cache-home-");
    const project = makeTempDir("pi-mcp-cache-proj-");
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

    const globalShared = join(home, ".config", "mcp", "mcp.json");
    const projectShared = join(project, ".mcp.json");
    const projectPi = join(project, ".pi", "fitch-mcp-adapter", "mcp.json");
    writeJsonFile(globalShared, {
      mcpServers: { sharedSrv: { url: "https://shared.example.test/mcp" } },
    });
    writeJsonFile(projectShared, {
      mcpServers: { projSrv: { command: "node", args: ["proj.js"] } },
    });
    writeJsonFile(projectPi, {
      mcpServers: { projSrv: { directTools: true } },
    });

    vi.resetModules();
    const configImports = await import("../config-imports.ts");
    const { inspectMcpConfigSnapshot } = await import("../config.ts");
    const spy = vi.spyOn(configImports, "readValidatedConfigWithDiagnostics");
    const snapshot = inspectMcpConfigSnapshot(undefined, project, { includeProject: true });
    const readsPerPath = new Map<string, number>();
    for (const [filePath] of spy.mock.calls) {
      readsPerPath.set(filePath, (readsPerPath.get(filePath) ?? 0) + 1);
    }

    expect(readsPerPath.get(globalShared)).toBe(1);
    expect(readsPerPath.get(projectShared)).toBe(1);
    expect(readsPerPath.get(projectPi)).toBe(1);
    expect(Object.keys(snapshot.config.mcpServers)).toEqual(["sharedSrv", "projSrv"]);

    const untrusted = inspectMcpConfigSnapshot(undefined, project, { includeProject: false });
    expect(Object.keys(untrusted.config.mcpServers)).toEqual(["sharedSrv"]);
    expect(untrusted.blockedServers).toEqual([
      expect.objectContaining({
        name: "projSrv",
        sourcePath: projectShared,
        reason: "Project is not trusted",
      }),
    ]);
    expect(untrusted.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: projectShared,
          status: "blocked",
          blockedReason: "Project is not trusted",
        }),
      ]),
    );
  });
});
