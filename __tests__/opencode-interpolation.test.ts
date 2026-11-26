import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractOAuthConfig } from "../mcp-auth-flow.ts";
import {
  interpolateEnvRecord,
  interpolateEnvVars,
  resolveBearerToken,
  resolveCommandSecret,
  resolveCommandSecretsRecord,
  resolveConfigPath,
  resolveServerUrl,
} from "../utils.ts";

describe("OpenCode environment interpolation", () => {
  const original = {
    MCP_TEST_VALUE: process.env.MCP_TEST_VALUE,
    MCP_TEST_URL: process.env.MCP_TEST_URL,
    MCP_TEST_BEARER_TOKEN_ENV: process.env.MCP_TEST_BEARER_TOKEN_ENV,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("supports {env:VAR} in env, headers, cwd, and OAuth fields", () => {
    process.env.MCP_TEST_VALUE = "interpolated";
    process.env.MCP_TEST_URL = "https://example.test/mcp";

    expect(interpolateEnvVars("prefix-{env:MCP_TEST_VALUE}")).toBe("prefix-interpolated");
    expect(interpolateEnvRecord({ Authorization: "Bearer {env:MCP_TEST_VALUE}" })).toEqual({
      Authorization: "Bearer interpolated",
    });
    expect(resolveConfigPath("{env:MCP_TEST_VALUE}/server")).toBe("interpolated/server");
    expect(
      extractOAuthConfig({
        url: "https://example.test/mcp",
        oauth: {
          clientId: "{env:MCP_TEST_VALUE}-client",
          clientSecret: "{env:MCP_TEST_VALUE}-secret",
          scope: "scope-{env:MCP_TEST_VALUE}",
        },
      }),
    ).toEqual({
      clientId: "interpolated-client",
      clientSecret: "interpolated-secret",
      scope: "scope-interpolated",
    });
  });

  it("resolves command secrets without executing cache-facing expressions", async () => {
    process.env.MCP_TEST_VALUE = "interpolated";
    process.env.MCP_TEST_BEARER_TOKEN_ENV = "!literal-token";
    const expression = `!node -e "process.stdout.write('  resolved  ')"`;

    expect(await resolveCommandSecret(expression, "test secret")).toBe("resolved");
    expect(await resolveCommandSecret("!!literal-{env:MCP_TEST_VALUE}", "test secret")).toBe(
      "!literal-interpolated",
    );
    expect(interpolateEnvRecord({ Secret: expression })).toEqual({ Secret: expression });
    expect(resolveBearerToken({ bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV" })).toBe(
      "!literal-token",
    );

    await expect(
      resolveCommandSecret(
        `!node -e "process.stderr.write('private-stderr'); process.exit(7)"`,
        "test secret",
      ),
    ).rejects.toThrow(/^Failed to resolve test secret: command exited with code 7$/);
    await expect(resolveCommandSecret(`!node -e ""`, "test secret")).rejects.toThrow(
      /^Failed to resolve test secret: command returned empty output$/,
    );
    await expect(resolveCommandSecret("!COMMAND_SECRET_SENTINEL\0", "test secret")).rejects.toThrow(
      /^Failed to resolve test secret: command failed to start$/,
    );
  });

  it("fails closed before URL resolution when a brace variable is missing", () => {
    delete process.env.MCP_TEST_URL;
    expect(() => resolveServerUrl({ url: "https://{env:MCP_TEST_URL}/mcp" })).toThrow(
      "Missing environment variable in MCP server URL: MCP_TEST_URL",
    );
  });

  it("resolves !command secrets concurrently without blocking the event loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-secret-async-"));
    const readyA = join(dir, "a.ready");
    const readyB = join(dir, "b.ready");
    const tickFile = join(dir, "parent.ticked");
    const rendezvousScript = (own: string, peer: string, output: string): string => {
      const code = [
        `const fs = require("node:fs");`,
        `fs.writeFileSync(${JSON.stringify(own)}, "1");`,
        `const deadline = Date.now() + 5000;`,
        `const check = () => {`,
        `  if (fs.existsSync(${JSON.stringify(peer)}) && fs.existsSync(${JSON.stringify(tickFile)})) {`,
        `    process.stdout.write(${JSON.stringify(output)});`,
        `    return;`,
        `  }`,
        `  if (Date.now() > deadline) { process.exit(1); }`,
        `  setTimeout(check, 10);`,
        `};`,
        `check();`,
      ].join(" ");
      return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
    };

    try {
      const timer = setTimeout(() => {
        writeFileSync(tickFile, "1");
      }, 25);
      try {
        const resolved = await resolveCommandSecretsRecord(
          {
            FIRST: rendezvousScript(readyA, readyB, "secret-a"),
            SECOND: rendezvousScript(readyB, readyA, "secret-b"),
          },
          (key) => `header ${key}`,
        );
        expect(resolved).toEqual({ FIRST: "secret-a", SECOND: "secret-b" });
        expect(existsSync(tickFile)).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight !command secret and terminates its child process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-secret-abort-"));
    const pidFile = join(dir, "child.pid");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
    const controller = new AbortController();

    try {
      const pending = resolveCommandSecret(command, "abort test", controller.signal);
      await expect.poll(() => existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);

      controller.abort(new Error("secret cancelled"));
      await expect(pending).rejects.toThrow("secret cancelled");
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out a hung !command secret after 10 seconds and terminates its child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-secret-timeout-"));
    const pidFile = join(dir, "child.pid");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = resolveCommandSecret(command, "timeout test");
      const settled = pending.catch((error: unknown) => error);
      await expect.poll(() => existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: "Failed to resolve timeout test: command timed out after 10 seconds",
      });
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
