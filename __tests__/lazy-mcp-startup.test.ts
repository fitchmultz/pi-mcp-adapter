import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { computeServerHash } from "../metadata-cache.ts";
import type { McpConfig, McpStatusSnapshot, ServerCacheEntry } from "../types.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// The parent may import the SDK transitively while calculating cache hashes. Only
// the fresh native Pi child is measured: Vitest's module graph is not the runtime.
describe("cached lazy MCP startup through native Pi", () => {
  it("loads the source extension and cached surfaces without the SDK, then connects on the first stdio call", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-lazy-startup-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const adapterDir = join(agentDir, "fitch-mcp-adapter");
    const eventsPath = join(root, "server-events.jsonl");
    await Promise.all([mkdir(adapterDir, { recursive: true }), mkdir(projectDir)]);

    const config: McpConfig = {
      mcpServers: {},
      settings: { sampling: false, elicitation: false },
    };
    const servers: Record<string, ServerCacheEntry> = {};
    const serverNames = Array.from({ length: 15 }, (_, index) => `lazy${String(index).padStart(2, "0")}`);
    for (const name of serverNames) {
      const definition = {
        command: process.execPath,
        args: [resolve("__tests__/fixtures/lazy-startup-mcp-server.mjs")],
        env: { MCP_STARTUP_FIXTURE_EVENTS: eventsPath, MCP_STARTUP_FIXTURE_NAME: name },
        lifecycle: "lazy" as const,
        directTools: name === "lazy00" ? ["echo"] : false,
      };
      config.mcpServers[name] = definition;
      servers[name] = {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [
          {
            name: "echo",
            description: `Cached echo from ${name}`,
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          {
            name: "dashboard",
            description: `Cached UI tool from ${name}`,
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { resourceUri: `ui://${name}/dashboard`, visibility: ["model", "app"] } },
          },
        ],
        resources: [{ name: "guide", uri: `docs://${name}/guide`, description: `Cached guide from ${name}`, mimeType: "text/plain" }],
        prompts: [{ name: "brief", description: `Cached brief from ${name}`, arguments: [{ name: "topic", required: true }] }],
        instructions: `Cached instructions from ${name}`,
      };
    }
    const configPath = join(adapterDir, "mcp.json");
    await Promise.all([
      writeFile(configPath, JSON.stringify(config)),
      writeFile(join(adapterDir, "mcp-cache.json"), JSON.stringify({ version: 2, servers })),
    ]);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      PI_CODING_AGENT_DIR: agentDir,
      MCP_CHILD_CONFIG: configPath,
      MCP_CHILD_PROJECT_DIR: projectDir,
      MCP_CHILD_ADAPTER_PATH: resolve("index.ts"),
      MCP_STARTUP_FIXTURE_EVENTS: eventsPath,
    };
    delete env.MCP_DIRECT_TOOLS;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [resolve("__tests__/fixtures/lazy-mcp-startup-child.ts")],
      { cwd: process.cwd(), env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    expect(stderr).not.toContain("MCP initialization failed");
    const line = stdout.split("\n").find(value => value.startsWith("LAZY_MCP_STARTUP="));
    expect(line, stdout).toBeDefined();
    const report = JSON.parse(line!.slice("LAZY_MCP_STARTUP=".length)) as {
      sourceLoaded: boolean;
      activeTools: string[];
      errors: unknown[];
      tools: Array<{ name: string; description: string; parameters: unknown }>;
      commands: Array<{ name: string; description: string }>;
      startupStatus: McpStatusSnapshot;
      startupSdkModules: string[];
      afterCallSdkModules: string[];
      startupZodModules: string[];
      afterCallZodModules: string[];
      eventsBeforeCall: unknown[];
      eventsAfterCall: Array<{ event: string; server: string; text?: string }>;
      call: { isError?: boolean; content: unknown[]; details: { error?: string } };
    };
    expect(report.sourceLoaded).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["mcp", "mcp_search", "mcp_script", "lazy00_echo"]));
    expect(report.tools.filter(tool => /^lazy\d+_/.test(tool.name)).map(tool => tool.name).sort())
      .toEqual(serverNames.flatMap(name => [`${name}_dashboard`, `${name}_echo`]));
    expect(report.tools).toContainEqual(expect.objectContaining({
      name: "lazy00_echo",
      description: expect.stringContaining("Cached echo from lazy00"),
      parameters: expect.objectContaining({ required: ["text"], properties: { text: { type: "string" } } }),
    }));
    expect(report.activeTools).toEqual(["lazy00_echo", "mcp_search"]);
    expect(report.commands.filter(command => command.name.startsWith("mcp__"))).toEqual(serverNames.map(name => ({
      name: `mcp__${name}__brief`, description: `MCP: Cached brief from ${name}`,
    })));
    expect(report.startupStatus).toEqual({
      version: 1, totalTools: 30, totalResources: 15, connectedCount: 0, disabledCount: 0,
      servers: serverNames.map(name => ({ name, status: "cached", catalogKnown: true, toolCount: 2, resourceCount: 1, disabled: false })),
    });
    expect(report.eventsBeforeCall).toEqual([]);
    expect(report.call.isError, JSON.stringify(report.call)).not.toBe(true);
    expect(report.call.details.error, JSON.stringify(report.call)).toBeUndefined();
    expect(report.call.content).toContainEqual({ type: "text", text: "lazy00: first use" });
    expect(report.eventsAfterCall).toEqual([
      { event: "spawn", server: "lazy00" },
      { event: "call", server: "lazy00", text: "first use" },
    ]);
    expect(report.afterCallSdkModules.some(url => /@modelcontextprotocol\/client\//.test(url))).toBe(true);
    expect(report.afterCallSdkModules.some(url => /@modelcontextprotocol\/core\//.test(url))).toBe(true);
    expect(report.afterCallZodModules).not.toEqual([]);
    // Keep these last so the baseline also exercises the real first-call boundary.
    expect(report.startupSdkModules).toEqual([]);
    expect(report.startupZodModules).toEqual([]);
  }, 70_000);
});
