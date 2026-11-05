import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hostCli, hostRoot } from "../compat-host.mjs";

const manifestSchema = z.object({ dependencies: z.record(z.string(), z.string()) });
const eventSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  success: z.boolean().optional(),
  method: z.string().optional(),
  message: z.string().optional(),
});

export function verifyCommands(packageRoot: string, root: string): void {
  const extension = join(root, "peerless-extension");
  mkdirSync(extension);
  copyFileSync(join(packageRoot, "package.json"), join(extension, "package.json"));
  cpSync(join(packageRoot, "dist"), join(extension, "dist"), { recursive: true });
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(extension, "package.json"), "utf8")),
  );
  // Only runtime dependencies are physically present, as in Pi-managed installs.
  for (const name of Object.keys(manifest.dependencies)) {
    const source = findPackageJSON(name, pathToFileURL(join(packageRoot, "dist/index.js")).href);
    assert.ok(source !== undefined, `runtime dependency ${name}`);
    const target = join(extension, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(dirname(source), target, "junction");
  }
  for (const { command, expected } of [
    { command: "/mcp", expected: "No MCP servers configured" },
    {
      command: "/mcp-auth",
      expected: "Use /mcp-auth <server> to authenticate outside TUI mode.",
    },
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        hostCli,
        "--offline",
        "--mode",
        "rpc",
        "--no-session",
        "-ne",
        "-ns",
        "-np",
        "-nc",
        "--no-themes",
        "--approve",
        "-e",
        extension,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          PI_PACKAGE_DIR: hostRoot,
          PI_CODING_AGENT_DIR: join(root, "peerless-agent"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
        },
        input: `${JSON.stringify({ id: "command", type: "prompt", message: command })}\n`,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(child.status, 0, `${String(child.error ?? "")}\n${child.stderr}`);
    const events = child.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => eventSchema.parse(JSON.parse(line)));
    assert.deepEqual(
      events.filter((event) => event.type === "extension_error"),
      [],
      `${command}: ${child.stdout}`,
    );
    assert.ok(
      events.some((event) => event.id === "command" && event.success === true),
      `${command} must complete`,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "extension_ui_request" &&
          event.method === "notify" &&
          event.message?.includes(expected) === true,
      ),
      `${command} must deliver its notification: ${child.stdout}`,
    );
    assert.ok(!events.some((event) => event.type === "agent_start"));
  }
  console.log("[compat-commands] /mcp and /mcp-auth passed without physical host peers");
}
