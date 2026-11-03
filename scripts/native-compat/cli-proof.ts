import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { hostCli, hostRoot } from "../compat-host.mjs";
import type { NativeFixture } from "./fixture.ts";

const identitySchema = z.object({ version: z.string(), root: z.string() });
const resultSchema = z.object({
  content: z.unknown(),
  isError: z.boolean(),
  nestedCalls: z.object({ calls: z.array(z.object({ name: z.string() })) }).optional(),
});
type CliResult = z.output<typeof resultSchema>;

function parseResults(stdout: string): CliResult[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      if (
        event === null ||
        typeof event !== "object" ||
        !("type" in event) ||
        event.type !== "message_end" ||
        !("message" in event)
      ) {
        return [];
      }
      const message = event.message;
      return message !== null &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "toolResult"
        ? [resultSchema.parse(message)]
        : [];
    });
}

function verifyResults(results: CliResult[]): void {
  assert.equal(results.length, 5);
  const [, coded, failed, redacted, blocked] = results;
  assert.ok(coded);
  assert.ok(failed);
  assert.ok(redacted);
  assert.ok(blocked);
  assert.match(JSON.stringify(coded.content), /coded-cli/);
  assert.doesNotMatch(JSON.stringify(coded.content), /SYNTHETIC-SECRET|Human coded/);
  assert.match(JSON.stringify(failed.content), /fail/);
  assert.match(JSON.stringify(redacted.content), /Redacted/);
  assert.equal(blocked.isError, true);
  assert.ok(coded.nestedCalls);
  assert.ok(coded.nestedCalls.calls.some((call) => call.name === "local_echo"));
}

export async function verifyCli(fixture: NativeFixture): Promise<void> {
  const identityPath = join(fixture.root, "cli-identity.json");
  const executing = promisify(execFileCallback)(
    process.execPath,
    [
      hostCli,
      "--mode",
      "json",
      "--no-session",
      "-ne",
      "-ns",
      "-np",
      "-nc",
      "--no-themes",
      "--approve",
      "-e",
      join(fixture.root, "probe/cli.ts"),
      "-e",
      "builtin:codemode",
      "--tools",
      "mcp_search,codemode,local_echo",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "-p",
      "Run local native contracts.",
    ],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        HOME: fixture.root,
        PI_PACKAGE_DIR: hostRoot,
        PI_CODING_AGENT_DIR: join(fixture.root, "cli-agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
        PI_NATIVE_URL: fixture.url,
        PI_NATIVE_IDENTITY: identityPath,
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  executing.child.stdin?.end();
  const { stdout } = await executing;
  const identity = identitySchema.parse(JSON.parse(readFileSync(identityPath, "utf8")));
  assert.equal(identity.version, VERSION);
  assert.equal(identity.root, hostRoot);
  verifyResults(parseResults(stdout));
}
