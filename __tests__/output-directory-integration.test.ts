import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";
import type { McpAdapterOptions } from "../types.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-output-test-"));
  await mkdir(join(root, "tmp"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("TMPDIR", join(root, "tmp"));
  vi.stubEnv("MCP_DIRECT_TOOLS", "output/echo");
  vi.stubEnv("MCP_OUTPUT_GUARD", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function startAdapter(outputDirectory?: string) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  let activeTools: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    registerCommand: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    on: (name: string, handler: Function) => { handlers.set(name, handler); },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: root, hasUI: false, mode: "print", isProjectTrusted: () => true } as ExtensionContext;
  const options: McpAdapterOptions = {
    config: {
      mcpServers: { output: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/output-server.mjs", import.meta.url))],
        lifecycle: "eager",
        directTools: true,
      } },
      settings: { sampling: false, elicitation: false },
    },
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
  createMcpAdapter(options)(pi);
  await handlers.get("session_start")!({}, ctx);
  return {
    call: (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("test", args, undefined, undefined, ctx),
    stop: () => handlers.get("session_shutdown")!(),
  };
}

describe("factory output directory", () => {
  it("keeps concurrently used adapters in separate directories", async () => {
    const directories = [join(root, "first"), join(root, "second")];
    const adapters = await Promise.all(directories.map(startAdapter));
    try {
      await Promise.all(adapters.map(async (adapter, index) => {
        const result = await adapter.call("mcp_script", { code: 'emit("unique".repeat(20_000))' });
        const path = (result.details as any).outputGuard.fullOutputPath;
        expect(dirname(dirname(path))).toBe(directories[index]);
        expect(await readFile(path, "utf8")).toBe("unique".repeat(20_000));
      }));
    } finally {
      await Promise.all(adapters.map(adapter => adapter.stop()));
    }
  });

  it.each([true, false])("routes every spill through the factory option (configured=%s)", async configured => {
    const outputDirectory = configured ? join(root, "workspace", "internal output", "mcp") : undefined;
    const expectedParent = outputDirectory ?? tmpdir();
    const adapter = await startAdapter(outputDirectory);
    const paths: string[] = [];
    async function check(path: string, expected: string) {
      expect(typeof path).toBe("string");
      expect(dirname(dirname(path))).toBe(expectedParent);
      expect(await readFile(path, "utf8")).toBe(expected);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      paths.push(path);
    }
    try {
      for (const mode of ["direct", "proxy"]) {
        const text = `${mode}: π\n`.repeat(10_000);
        const result = await adapter.call(mode === "direct" ? "output_echo" : "mcp", mode === "direct" ? { text } : { tool: "output_echo", args: { text } });
        const details = result.details as any;
        await check(details.outputGuard.fullOutputPath, text);
        await check(details.mcpResult.fullResultPath, JSON.stringify({ content: [{ type: "text", text }], structuredContent: { echo: text } }));
      }
      const resource = await adapter.call("mcp", { tool: "output_read_large" });
      await check((resource.details as any).outputGuard.fullOutputPath, "resource\n".repeat(10_000));
      const text = "script-inner: π\n".repeat(10_000);
      const final = `script-final:${text}`;
      const script = await adapter.call("mcp_script", { code: `const r = await tools.output_echo({ text: ${JSON.stringify(text)} }); if (!r.ok || r.data.structuredContent.echo !== ${JSON.stringify(text)}) throw new Error("raw result changed"); emit("script-final:" + r.data.content[0].text);` });
      expect((script.details as any).error).toBeUndefined();
      await check((script.details as any).outputGuard.fullOutputPath, final);
      const files = (await readdir(expectedParent, { recursive: true })).filter(name => name.endsWith(".txt")).map(name => join(expectedParent, name));
      expect(files).toHaveLength(8);
      expect(new Set(files).size).toBe(8);
      const innerFiles = files.filter(path => !paths.includes(path));
      expect((await Promise.all(innerFiles.map(path => readFile(path, "utf8")))).sort()).toEqual([
        text,
        JSON.stringify({ content: [{ type: "text", text }], structuredContent: { echo: text } }),
      ].sort());
    } finally {
      await adapter.stop();
    }
  }, 15_000);
});
