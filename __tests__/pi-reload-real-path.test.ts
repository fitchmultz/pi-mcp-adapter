import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { computeServerHash } from "../metadata-cache.ts";

const roots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

beforeEach(() => {
  delete process.env.MCP_DIRECT_TOOLS;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reload harness condition");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function activeFixtures(pidDir: string): Promise<Array<{ pid: number; toolName: string }>> {
  const entries = await readdir(pidDir);
  const records = await Promise.all(entries.filter(name => name.endsWith(".json")).map(async name =>
    JSON.parse(await readFile(join(pidDir, name), "utf8")) as { pid: number; toolName: string },
  ));
  return records.filter(record => isAlive(record.pid));
}

async function waitForFixture(
  pidDir: string,
  predicate: (active: Array<{ pid: number; toolName: string }>) => boolean,
  timeoutMs = 5000,
): Promise<Array<{ pid: number; toolName: string }>> {
  let result: Array<{ pid: number; toolName: string }> = [];
  await waitFor(async () => {
    result = await activeFixtures(pidDir);
    return predicate(result);
  }, timeoutMs);
  return result;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createReloadHarness() {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-reload-real-path-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = join(root, "project");
  await writeFile(join(root, "placeholder"), "ok");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  const pidDir = join(root, "pids");
  await mkdir(pidDir, { recursive: true });
  const definition = {
    command: process.execPath,
    args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")],
    env: { MCP_RELOAD_PID_DIR: pidDir },
    debug: true,
    lifecycle: "eager" as const,
    directTools: true,
  };
  const configPath = join(agentDir, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: { delayed: definition },
    settings: { sampling: false, elicitation: false },
  }));
  await writeFile(join(agentDir, "mcp-cache.json"), JSON.stringify({
    version: 1,
    servers: {
      delayed: {
        configHash: computeServerHash(definition),
        tools: [{ name: "reload_identity", description: "Reload identity", inputSchema: { type: "object" } }],
        resources: [],
        cachedAt: Date.now(),
      },
    },
  }));
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [resolve("index.ts")],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const errors: Array<{ error: string; stack?: string }> = [];
  const statusCalls: string[] = [];
  const ui = {
    notify: () => undefined,
    setStatus: (_key: string, value: unknown) => statusCalls.push(String(value)),
    theme: { fg: (_color: string, value: string) => value },
  } as any;
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
  });
  session.extensionRunner.setFlagValue("mcp-config", configPath);
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
  return {
    session,
    errors,
    statusCalls,
    pidDir,
  };
}

describe("Pi registered extension reload real path", () => {
  it("terminates each old fixture and leaves one replacement process/tool identity", async () => {
    const harness = await createReloadHarness();
    const oldPids: number[] = [];
    try {
      await harness.session.reload();
      const firstActive = await waitForFixture(harness.pidDir, active => active.length === 1).catch(error => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; errors=${JSON.stringify(harness.errors)}; statuses=${JSON.stringify(harness.statusCalls)}`);
      });
      oldPids.push(firstActive[0].pid);

      await harness.session.reload();
      const secondActive = await waitForFixture(harness.pidDir, active =>
        active.length === 1 && active[0].pid !== oldPids[0],
      ).catch(async error => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; active=${JSON.stringify(await activeFixtures(harness.pidDir))}; errors=${JSON.stringify(harness.errors)}; statuses=${JSON.stringify(harness.statusCalls)}`);
      });
      oldPids.push(secondActive[0].pid);
      await waitFor(() => !isAlive(oldPids[0]));
      expect(harness.session.getActiveToolNames()).toContain("delayed_reload_identity");
      harness.session.setActiveToolsByName(
        harness.session.getActiveToolNames().filter((name) => name !== "delayed_reload_identity"),
      );

      await harness.session.reload();
      const active = await waitForFixture(harness.pidDir, fixtures =>
        fixtures.length === 1 && fixtures[0].pid !== oldPids[1],
      );
      oldPids.push(active[0].pid);
      await waitFor(() => !isAlive(oldPids[1]));
      expect(harness.session.getActiveToolNames()).not.toContain("delayed_reload_identity");

      expect(active).toHaveLength(1);
      expect(active[0].toolName).toBe("reload_identity");
      const tools = harness.session.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name);
      expect(tools.filter(name => name === "mcp")).toHaveLength(1);
      expect(harness.errors.map(error => `${error.error}\n${error.stack ?? ""}`).join("\n"))
        .not.toContain("This extension ctx is stale after session replacement or reload");
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(() => !isAlive(oldPids[2]));
      await new Promise(resolve => setTimeout(resolve, 150));
    } finally {
      try {
        await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "test-finally" });
      } catch {
        // Preserve the original assertion while still attempting extension cleanup.
      }
      for (const pid of oldPids) {
        if (isAlive(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The fixture may have exited between the liveness check and kill.
          }
        }
      }
      harness.session.dispose();
    }
  }, 20_000);

  it("ignores a project-local metadata cache when the project is untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-cache-trust-real-path-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(cwd, ".pi-agent");
    const pidDir = join(root, "pids");
    await Promise.all([
      mkdir(join(cwd, ".git"), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(pidDir, { recursive: true }),
    ]);
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const definition = {
      command: process.execPath,
      args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")],
      env: { MCP_RELOAD_PID_DIR: pidDir },
      lifecycle: "eager" as const,
      directTools: true,
    };
    const configPath = join(root, "global-mcp.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: { demo: definition },
      settings: { sampling: false, elicitation: false },
    }));
    const cachePath = join(agentDir, "mcp-cache.json");
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(definition),
          tools: [{ name: "attacker", description: "ATTACKER CACHE TEXT", inputSchema: { type: "object" } }],
          resources: [],
          instructions: "ATTACKER CACHE TEXT",
          cachedAt: Date.now(),
        },
      },
    }));

    const settingsManager = SettingsManager.inMemory();
    settingsManager.setProjectTrusted(false);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      modelRuntime,
    });
    session.extensionRunner.setFlagValue("mcp-config", configPath);
    await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });

    let pid: number | undefined;
    try {
      await session.reload();
      const active = await waitForFixture(pidDir, fixtures => fixtures.length === 1);
      pid = active[0].pid;
      const registered = session.extensionRunner.getAllRegisteredTools();
      expect(registered.map(tool => tool.definition.name)).not.toContain("demo_attacker");
      expect(registered.find(tool => tool.definition.name === "mcp")?.definition.description)
        .not.toContain("ATTACKER CACHE TEXT");
      expect(await readFile(cachePath, "utf8")).toContain("ATTACKER CACHE TEXT");
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await waitFor(() => pid === undefined || !isAlive(pid));
    } finally {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "test-finally" });
      } catch {
        // Preserve the original assertion while still attempting extension cleanup.
      }
      if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGTERM");
      session.dispose();
    }
  }, 20_000);
});
