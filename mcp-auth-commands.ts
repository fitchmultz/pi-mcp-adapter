import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig, type McpAuthResult, type ServerEntry } from "./types.ts";
import { supportsOAuth, type McpOAuthRuntime } from "./mcp-oauth-runtime.ts";
import { getAuthStorageOptions } from "./mcp-auth.ts";
import { updateStatusBar } from "./init.ts";
import { resolveServerUrl, sanitizeTerminalText } from "./utils.ts";
import { isAbortError } from "./runtime-owner.ts";
function authPreconditionFailure(
  serverName: string,
  definition: ServerEntry,
  ui: ExtensionContext["ui"],
): McpAuthResult | undefined {
  if (isServerDisabled(definition)) {
    const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName}, then /reload.`;
    ui.notify(message, "warning");
    return { ok: false, message };
  }

  if (!supportsOAuth(definition)) {
    const message = `Server "${serverName}" does not use OAuth authentication. Set "auth": "oauth" or omit auth for auto-detection.`;
    ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
        `Set "auth": "oauth" or omit auth for auto-detection.`,
      "error",
    );
    return { ok: false, message };
  }

  return;
}

async function runAuthentication(input: {
  serverName: string;
  serverUrl: string;
  definition: ServerEntry;
  config: McpConfig;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  runtime: McpOAuthRuntime | undefined;
}): Promise<McpAuthResult> {
  const { serverName, serverUrl, definition, config, ctx, signal, runtime } = input;
  const ui = ctx.ui;
  const cwd = ctx.cwd;
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);
  const { authenticate } = await import("./mcp-auth-flow.ts");
  const status = await authenticate(serverName, serverUrl, definition, {
    ...((authStorageOptions.baseDir ?? "").length > 0 ? { authStorageOptions } : {}),
    onAuthorizationUrl: (authorizationUrl) => {
      ui.notify(
        `Open this URL to authenticate ${serverName}:\n\n${authorizationUrl}\n\n` +
          "After approving, return to Pi; the local callback will complete automatically.",
        "info",
      );
    },
    ...(signal ? { signal } : {}),
    ...(runtime ? { runtime } : {}),
  });
  if (signal?.aborted === true) {
    signal.throwIfAborted();
  }

  if (status === "authenticated") {
    const message = `OAuth authentication successful for "${serverName}".`;
    ui.notify(message, "info");
    return { ok: true, message };
  }

  const message = `OAuth authentication failed for "${serverName}".`;
  ui.notify(message, "error");
  return { ok: false, message };
}

async function authenticationAttempt(
  input: Omit<Parameters<typeof runAuthentication>[0], "serverUrl">,
): Promise<McpAuthResult> {
  const { serverName, definition, config, ctx, signal: authSignal, runtime } = input;
  const ui = ctx.ui;
  try {
    const serverUrl = resolveServerUrl(definition);
    if (serverUrl === undefined || serverUrl.length === 0) {
      const message = `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`;
      ui.notify(message, "error");
      return { ok: false, message };
    }

    ui.setStatus("mcp-auth", `Authenticating ${serverName}...`);
    return await runAuthentication({
      serverName,
      serverUrl,
      definition,
      config,
      ctx,
      signal: authSignal,
      runtime,
    });
  } catch (error) {
    if (authSignal?.aborted === true) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error");
    return { ok: false, message };
  } finally {
    if (authSignal?.aborted !== true) {
      ui.setStatus("mcp-auth", undefined);
    }
  }
}

export async function authenticateServer(input: {
  serverName: string;
  config: McpConfig;
  ctx: ExtensionContext;
  signal?: AbortSignal | undefined;
  runtime?: McpOAuthRuntime | undefined;
}): Promise<McpAuthResult> {
  const { serverName, config, ctx, signal, runtime } = input;
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const authSignal = signal ?? ctx.signal;
  if (!ui) {
    return { ok: false, message: "OAuth authentication requires an interactive session." };
  }

  const definition = config.mcpServers[serverName];
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    ui.notify(message, "error");
    return { ok: false, message };
  }
  const failure = authPreconditionFailure(serverName, definition, ui);
  if (failure) {
    return failure;
  }

  return authenticationAttempt({
    serverName,
    definition,
    config,
    ctx,
    signal: authSignal,
    runtime,
  });
}

async function removeCredentials(
  serverName: string,
  state: McpExtensionState,
  ui: ExtensionContext["ui"] | undefined,
): Promise<{ ok: boolean; message: string } | undefined> {
  const signal = state.owner.signal;
  try {
    const { removeAuth } = await import("./mcp-auth-flow.ts");
    await removeAuth(serverName, {
      authStorageOptions: state.authStorageOptions,
      signal,
      runtime: state.oauthRuntime,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (ui) {
      ui.notify(
        `Failed to clear OAuth credentials for "${serverName}": ${sanitizeTerminalText(message)}`,
        "error",
      );
    }
    return { ok: false, message };
  }

  return;
}

export async function logoutServer(
  serverName: string,
  state: McpExtensionState,
  ctx: ExtensionContext,
): Promise<{ ok: boolean; message: string }> {
  const definition = state.config.mcpServers[serverName];
  const ui = ctx.hasUI ? ctx.ui : undefined;
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    if (ui) {
      ui.notify(message, "error");
    }
    return { ok: false, message };
  }

  const signal = state.owner.signal;
  const failure = await removeCredentials(serverName, state, ui);
  if (failure) {
    return failure;
  }

  state.owner.throwIfInactive();
  try {
    await state.manager.close(serverName);
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (ui) {
      ui.notify(
        `OAuth credentials were cleared for "${serverName}", but its connection could not be closed: ${sanitizeTerminalText(message)}`,
        "error",
      );
    }
    return { ok: false, message };
  }

  state.owner.throwIfInactive();
  updateStatusBar(state);

  const message = `OAuth credentials cleared for "${serverName}". Run /mcp-auth ${serverName} to authenticate again.`;
  if (ui) {
    ui.notify(message, "info");
  }
  return { ok: true, message };
}
