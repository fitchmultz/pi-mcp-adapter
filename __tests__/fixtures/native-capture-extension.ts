import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { createMcpAdapter } from "../../index.ts";

function sessionBytes(manager: ExtensionContext["sessionManager"] | undefined) {
  assert.ok(manager !== undefined, "The native session must start before capture");
  const file = manager.getSessionFile();
  assert.ok(file !== undefined, "The capture fixture requires a persistent native session");
  return readFileSync(file, "utf8");
}

function artifactBytes(directory: string) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".txt"))
    .map((name) => readFileSync(join(directory, name), "utf8"));
}

export function createNativeCaptureExtension({
  createAdapter,
  outputDirectory,
  workspaceFile,
  url,
}: {
  createAdapter: typeof createMcpAdapter;
  outputDirectory: string;
  workspaceFile: string;
  url: string;
}): ExtensionFactory {
  return (pi) => {
    let sessionManager: ExtensionContext["sessionManager"] | undefined;
    pi.on("session_start", (_event, ctx) => {
      sessionManager = ctx.sessionManager;
    });
    pi.registerTool({
      name: "fixture_writer",
      label: "Writer",
      description: "Finish a workspace write",
      parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        await fetch(new URL("/writer", url), { method: "POST", signal: signal ?? null });
        writeFileSync(workspaceFile, "writer finished");
        return { content: [{ type: "text", text: "writer finished" }], details: {} };
      },
    });
    createAdapter({
      outputDirectory,
      beforeExecute: async (toolCallId, ctx, operation) => {
        const response = await fetch(new URL("/checkpoint", url), {
          method: "POST",
          signal: ctx.signal ?? null,
          body: JSON.stringify({
            toolCallId,
            operation,
            bytes: sessionBytes(ctx.sessionManager),
            workspace: existsSync(workspaceFile) ? readFileSync(workspaceFile, "utf8") : null,
            artifacts: artifactBytes(outputDirectory),
          }),
        });
        if (!response.ok) {
          throw new Error("checkpoint unavailable");
        }
      },
      config: {
        mcpServers: {
          local: {
            url,
            auth: false,
            lifecycle: "eager",
            directTools: true,
            retryOnTransportFailure: true,
            requestTimeoutMs: 1000,
          },
          untrusted: {
            url,
            auth: false,
            lifecycle: "eager",
            directTools: true,
            requestTimeoutMs: 1000,
          },
        },
        settings: { sampling: false, elicitation: false, freezeDirectTools: true },
      },
      onToolCall: async ({ signal, ...event }) => {
        pi.appendEntry("fixture-mcp-call", event);
        const bytes = sessionBytes(sessionManager);
        const response = await fetch(new URL("/capture", url), {
          method: "POST",
          body: JSON.stringify({ event, bytes }),
          signal,
        });
        if (!response.ok) {
          throw new Error("capture unavailable: synthetic-secret-must-not-leak");
        }
      },
    })(pi);
  };
}
