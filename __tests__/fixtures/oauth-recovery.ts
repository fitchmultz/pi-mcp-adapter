import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import { createTestState } from "../test-state.ts";
import { createTestExtensionContext } from "../test-extension-context.ts";
import { createDirectToolExecutor } from "../../direct-tools.ts";
import { runMcpScript } from "../../mcp-code.ts";
import {
  createOAuthRuntime,
  startAuth,
  completeAuthFromInput,
  shutdownOAuth,
  getOAuthRequest,
} from "../../mcp-auth-flow.ts";
import {
  clearAllCredentials,
  getAuthForUrl,
  getAuthBaseDir,
  updateTokens,
} from "../../mcp-auth.ts";
import { McpServerManager } from "../../server-manager.ts";
import { executeCall } from "../../proxy-modes.ts";
import { formatToolName, type McpSettings, type ServerEntry } from "../../types.ts";
import { OAuthRecoveryHttp, recoveryTools, type RecoveryEra } from "./oauth-recovery-http.ts";

export { content, scopes, type RecoveryEra } from "./oauth-recovery-http.ts";

export function resultText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  assert(first?.type === "text", "Expected a text result");
  return first.text;
}

export function denialCallback(authorizationUrl: string, issuer: string, description: string): URL {
  const authorization = new URL(authorizationUrl);
  const redirect = authorization.searchParams.get("redirect_uri");
  const state = authorization.searchParams.get("state");
  assert(redirect !== null && state !== null);
  const callback = new URL(redirect);
  callback.search = new URLSearchParams({
    state,
    iss: issuer,
    error: "access_denied",
    error_description: description,
  }).toString();
  return callback;
}

export async function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([promise]);
  return result;
}

export async function createOAuthRecoveryFixture(
  era: RecoveryEra,
  name: string,
): Promise<ReturnType<typeof bindRecoveryFixture>> {
  const wire = new OAuthRecoveryHttp(era);
  await wire.listen();
  const native = await createTestExtensionContext();
  return bindRecoveryFixture(wire, native, era, name);
}

function bindRecoveryFixture(
  wire: OAuthRecoveryHttp,
  native: Awaited<ReturnType<typeof createTestExtensionContext>>,
  era: RecoveryEra,
  name: string,
) {
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  manager.setOAuthRuntime(runtime);
  const definition: ServerEntry & { url: string } = {
    url: `${wire.origin}/mcp`,
    protocolVersion: era === "legacy" ? "legacy" : "auto",
    requestTimeoutMs: 3000,
  };
  const settings: McpSettings = {};
  const toolName = (tool: string) => formatToolName(tool, name, "server");
  const state = createTestState({
    manager,
    oauthRuntime: runtime,
    config: { mcpServers: { [name]: definition }, settings },
    toolMetadata: new Map([
      [
        name,
        recoveryTools.map((tool) => ({
          name: toolName(tool.name),
          originalName: tool.name,
          description: tool.name,
        })),
      ],
    ]),
  });
  const ui = {
    ...native.context.ui,
    setStatus: vi.fn<typeof native.context.ui.setStatus>(),
    notify: vi.fn<typeof native.context.ui.notify>(),
  };
  const authorize = async (url: string) => {
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    assert(location !== null);
    return location;
  };
  const start = () => startAuth(name, definition.url, definition, { runtime });
  const manual = async () => {
    const { authorizationUrl } = await start();
    expect(authorizationUrl).toBeTruthy();
    const callback = await authorize(authorizationUrl);
    expect(await completeAuthFromInput(name, callback, { runtime })).toBe("authenticated");
    return authorizationUrl;
  };
  return {
    name,
    toolName,
    origin: wire.origin,
    definition,
    runtime,
    manager,
    state,
    settings,
    ui,
    http: wire.http,
    requests: wire.requests,
    exchanges: wire.exchanges,
    authorizations: wire.authorizations,
    controls: wire.controls,
    start,
    manual,
    authorize,
    connect: () => manager.connect(name, definition),
    call: (tool = "write", signal?: AbortSignal) =>
      executeCall(state, toolName(tool), {}, name, undefined, signal),
    callHost: async (host: "proxy" | "direct" | "script"): Promise<unknown> => {
      if (host === "script") {
        const result = await runMcpScript({
          state,
          code: `emit(await tools.call(${JSON.stringify(toolName("write"))}, {}));`,
        });
        expect(result.details.error).toBeUndefined();
        const output: unknown = JSON.parse(resultText(result));
        return output;
      }
      const result =
        host === "proxy"
          ? await executeCall(state, toolName("write"), {}, name)
          : await createDirectToolExecutor(
              () => state,
              () => null,
              {
                serverName: name,
                originalName: "write",
                prefixedName: toolName("write"),
                description: "write",
              },
            )("call", {}, undefined, undefined, native.context);
      return result.details.error !== undefined
        ? { ok: false, error: { code: result.details.error } }
        : { ok: true, data: { content: result.content } };
    },
    request: () => getOAuthRequest(name, definition.url, getAuthBaseDir(), runtime),
    seed: (scope: string | undefined, refresh = false) =>
      updateTokens(
        name,
        {
          accessToken: scope?.includes("write") === true ? "wide-token" : "basic-token",
          ...(scope !== undefined ? { scope } : {}),
          ...(refresh ? { refreshToken: "refresh-basic" } : {}),
          issuer: wire.origin,
        },
        definition.url,
      ),
    stored: () => getAuthForUrl(name, definition.url),
    async dispose(this: void): Promise<void> {
      wire.controls.releaseEffect();
      await manager.closeAll();
      await shutdownOAuth(runtime);
      clearAllCredentials(name);
      await native.dispose();
      await wire.close();
    },
  };
}
