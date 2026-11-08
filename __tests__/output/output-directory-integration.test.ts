import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpAdapter } from "../../index.ts";
import type { McpAdapterOptions } from "../../types.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";

const spillDetails = z.object({
  outputGuard: z.object({ fullOutputPath: z.string() }),
});

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
  const options: McpAdapterOptions = {
    config: {
      mcpServers: {
        output: {
          command: process.execPath,
          args: [fileURLToPath(new URL("../fixtures/output-server.mjs", import.meta.url))],
          lifecycle: "eager",
          directTools: true,
        },
      },
      settings: { sampling: false, elicitation: false },
    },
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
  const host = await createTestExtensionContext("builtin", createMcpAdapter(options));
  const errors: string[] = [];
  const removeErrorListener = host.runner.onError((error) => {
    errors.push(`${error.event}: ${error.error}`);
  });
  try {
    await host.runner.emit({ type: "session_start", reason: "startup" });
    assert.deepEqual(errors, []);
    return {
      call: (name: string, args: Record<string, unknown>) => {
        const tool = host.runner.getToolDefinition(name);
        assert.ok(tool !== undefined);
        const signal = new AbortController().signal;
        return tool.execute(
          "test",
          args,
          signal,
          undefined,
          host.runner.createToolContext("test", signal),
        );
      },
      stop: async () => {
        try {
          await host.runner.emit({ type: "session_shutdown", reason: "quit" });
          assert.deepEqual(errors, []);
        } finally {
          removeErrorListener();
          await host.dispose();
        }
      },
    };
  } catch (error) {
    removeErrorListener();
    await host.dispose();
    throw error;
  }
}

describe("factory output directory", () => {
  it("keeps concurrently used adapters in separate directories", async () => {
    const directories = [join(root, "first"), join(root, "second")];
    const adapters = await Promise.all(directories.map(startAdapter));
    try {
      await Promise.all(
        adapters.map(async (adapter, index) => {
          const text = "unique".repeat(20_000);
          const result = await adapter.call("output_echo", { text });
          const path = spillDetails.parse(result.details).outputGuard.fullOutputPath;
          expect(dirname(dirname(path))).toBe(directories[index]);
          expect(await readFile(path, "utf8")).toBe(
            `${text}\n${JSON.stringify({ echo: text }, null, 2)}`,
          );
        }),
      );
    } finally {
      await Promise.all(adapters.map((adapter) => adapter.stop()));
    }
  });

  it.each([true, false])(
    "routes every spill through the factory option (configured=%s)",
    async (configured) => {
      const outputDirectory = configured
        ? join(root, "workspace", "internal output", "mcp")
        : undefined;
      const expectedParent = outputDirectory ?? tmpdir();
      const adapter = await startAdapter(outputDirectory);
      const paths: string[] = [];
      async function check(path: string, expected: string) {
        expect(typeof path).toBe("string");
        expect(dirname(dirname(path))).toBe(expectedParent);
        expect(await readFile(path, "utf8")).toBe(expected);
        expect(
          process.platform === "win32" || ((await stat(path)).mode & 0o777) === 0o600,
          "POSIX output must be private",
        ).toBe(true);
        paths.push(path);
      }
      try {
        for (const mode of ["direct", "proxy"]) {
          const text = `${mode}: π\n`.repeat(10_000);
          const result = await adapter.call(
            mode === "direct" ? "output_echo" : "mcp",
            mode === "direct" ? { text } : { tool: "output_echo", args: { text } },
          );
          const details = spillDetails
            .extend({ mcpResult: z.object({ fullResultPath: z.string() }) })
            .parse(result.details);
          await check(
            details.outputGuard.fullOutputPath,
            `${text}\n${JSON.stringify({ echo: text }, null, 2)}`,
          );
          await check(
            details.mcpResult.fullResultPath,
            JSON.stringify({
              content: [{ type: "text", text }],
              structuredContent: { echo: text },
            }),
          );
        }
        const resource = await adapter.call("mcp", { tool: "output_read_large" });
        const resourceDetails = spillDetails
          .extend({ resultRef: z.string() })
          .parse(resource.details);
        await check(resourceDetails.outputGuard.fullOutputPath, "resource\n".repeat(10_000));
        const resourceRaw = z
          .object({ contents: z.array(z.object({ text: z.string() })) })
          .parse(JSON.parse(await readFile(resourceDetails.resultRef, "utf8")));
        expect(resourceRaw.contents[0]?.text).toBe("resource\n".repeat(10_000));
        paths.push(resourceDetails.resultRef);
        const files = (await readdir(expectedParent, { recursive: true }))
          .filter((name) => name.endsWith(".txt"))
          .map((name) => join(expectedParent, name));
        expect(files.sort()).toEqual([...paths].sort());
      } finally {
        await adapter.stop();
      }
    },
    15_000,
  );
});
