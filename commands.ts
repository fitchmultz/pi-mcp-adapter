import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import {
  isServerDisabled,
  isNonInteractiveOAuth,
  type McpConfig,
  type McpPanelCallbacks,
  type McpPanelResult,
  type ImportKind,
} from "./types.ts";
import {
  ensureCompatibilityImports,
  getMcpDiscoverySummary,
  getProjectConfigPath,
  type KnownServerPreset,
  getServerProvenance,
  previewCompatibilityImports,
  previewSharedServerEntry,
  previewStarterProjectConfig,
  writeDirectToolsConfig,
  writeSharedServerEntry,
  writeStarterProjectConfig,
} from "./config.ts";
import { getFailureAgeSeconds, getFailureMessage } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { supportsOAuth } from "./mcp-oauth-runtime.ts";
import { inspectAuthForUrl } from "./mcp-auth.ts";
import {
  loadOnboardingState,
  markSetupCompleted as persistSetupCompleted,
  markSharedConfigHintShown,
} from "./onboarding-state.ts";
import { openPath, resolveServerUrl } from "./utils.ts";
import { createMcpPanel } from "./mcp-panel.ts";
import { createMcpSetupPanel } from "./mcp-setup-panel.ts";
import type { SetupPanelCallbacks } from "./mcp-setup-contract.ts";
import { showStatus } from "./mcp-inspection-commands.ts";
import { reconnectServer } from "./mcp-connection-commands.ts";
import { authenticateServer } from "./mcp-auth-commands.ts";
export { showStatus, showPrompts, showTools } from "./mcp-inspection-commands.ts";
export { reconnectServer, reconnectServers } from "./mcp-connection-commands.ts";
export { authenticateServer, logoutServer } from "./mcp-auth-commands.ts";

export interface PanelFlowResult {
  configChanged: boolean;
}

function buildSharedConfigNoticeLines(
  configOverridePath: string | undefined,
  cwd: string,
): string[] {
  const discovery = getMcpDiscoverySummary(configOverridePath, cwd);
  const onboardingState = loadOnboardingState();
  if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
    return [];
  }

  const sharedSources = discovery.sources.filter(
    (source) => source.kind === "shared" && source.serverCount > 0,
  );
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return [
    `Using standard MCP config from ${sourceList}.`,
    "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
  ];
}

function buildSetupCallbacks(input: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  configOverridePath: string | undefined;
  onConfigChanged: () => void;
}): SetupPanelCallbacks {
  const { pi, ctx, configOverridePath, onConfigChanged } = input;
  return {
    previewImports: (imports: ImportKind[]) =>
      previewCompatibilityImports(imports, configOverridePath),
    previewStarterProject: () => previewStarterProjectConfig(ctx.cwd),
    previewRepoPrompt: () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
      if (
        !repoPrompt.entry ||
        repoPrompt.targetPath === undefined ||
        repoPrompt.targetPath.length === 0 ||
        repoPrompt.serverName === undefined ||
        repoPrompt.serverName.length === 0
      ) {
        return null;
      }
      return previewSharedServerEntry(
        repoPrompt.targetPath,
        repoPrompt.serverName,
        repoPrompt.entry,
      );
    },
    previewKnownServer: (preset: KnownServerPreset) =>
      previewSharedServerEntry(getProjectConfigPath(ctx.cwd), preset.id, preset.entry),
    adoptImports: async (imports: ImportKind[]) => {
      const result = ensureCompatibilityImports(imports, configOverridePath);
      if (result.added.length > 0) {
        onConfigChanged();
      }
      return result;
    },
    scaffoldProjectConfig: async () => {
      const path = writeStarterProjectConfig(ctx.cwd);
      onConfigChanged();
      return { path };
    },
    addRepoPrompt: async () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
      if (
        !repoPrompt.entry ||
        repoPrompt.targetPath === undefined ||
        repoPrompt.targetPath.length === 0 ||
        repoPrompt.serverName === undefined ||
        repoPrompt.serverName.length === 0
      ) {
        throw new Error("RepoPrompt is not available to add from this setup screen.");
      }
      const path = writeSharedServerEntry(
        repoPrompt.targetPath,
        repoPrompt.serverName,
        repoPrompt.entry,
      );
      onConfigChanged();
      return { path, serverName: repoPrompt.serverName };
    },
    addKnownServer: async (preset: KnownServerPreset) => {
      const path = writeSharedServerEntry(getProjectConfigPath(ctx.cwd), preset.id, preset.entry);
      onConfigChanged();
      return { path, serverName: preset.name };
    },
    openPath: async (targetPath: string) => {
      await openPath(pi, targetPath);
    },
    markSetupCompleted: persistSetupCompleted,
  };
}

export async function openMcpSetup(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  mode: "empty" | "setup" = "setup",
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) {
    return { configChanged: false };
  }
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("Project MCP setup is unavailable until this project is trusted.", "warning");
    return { configChanged: false };
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("MCP setup is available in TUI mode only.", "info");
    return { configChanged: false };
  }
  if (state.programmaticConfig === true) {
    ctx.ui.notify(
      "MCP setup is unavailable when config is supplied by createMcpAdapter().",
      "info",
    );
    return { configChanged: false };
  }

  const discovery = getMcpDiscoverySummary(configOverridePath, ctx.cwd);
  const onboardingState = loadOnboardingState();
  let configChanged = false;

  const callbacks = buildSetupCallbacks({
    pi,
    ctx,
    configOverridePath,
    onConfigChanged: () => {
      configChanged = true;
    },
  });

  return ctx.ui.custom<PanelFlowResult>(
    (tui, _theme, keybindings, done) =>
      createMcpSetupPanel(discovery, callbacks, { mode, onboardingState, keybindings }, tui, () =>
        done({ configChanged }),
      ),
    { overlay: true, overlayOptions: { anchor: "center", width: 92 } },
  );
}

function inspectPanelCredentials(
  state: McpExtensionState,
  serverName: string,
  serverUrl: string,
  authStatusFailures: Map<string, string>,
): ReturnType<McpPanelCallbacks["getConnectionStatus"]> | undefined {
  const authStatus = inspectAuthForUrl(serverName, serverUrl, state.authStorageOptions);
  if (authStatus.status === "unavailable") {
    authStatusFailures.set(serverName, authStatus.message);
    return "failed";
  }
  if (authStatus.status === "absent" || !authStatus.entry.tokens) {
    return "needs-auth";
  }
  return;
}

function panelCredentialStatus(
  state: McpExtensionState,
  serverName: string,
  definition: McpConfig["mcpServers"][string] | undefined,
  authStatusFailures: Map<string, string>,
): ReturnType<McpPanelCallbacks["getConnectionStatus"]> | undefined {
  let serverUrl: string | undefined;
  try {
    serverUrl = definition ? resolveServerUrl(definition) : undefined;
  } catch {
    return "failed";
  }
  if (
    definition?.auth === "oauth" &&
    serverUrl !== undefined &&
    serverUrl.length > 0 &&
    definition.oauth !== false &&
    !isNonInteractiveOAuth(definition.oauth)
  ) {
    return inspectPanelCredentials(state, serverName, serverUrl, authStatusFailures);
  }

  return;
}

function buildMcpPanelCallbacks(
  state: McpExtensionState,
  config: McpConfig,
  ctx: ExtensionContext,
): McpPanelCallbacks {
  // Panel-only diagnostics keep status inspection from mutating connection
  // failure state while allowing the existing panel failure UI to show why the
  // credential store could not be inspected.
  const authStatusFailures = new Map<string, string>();

  return {
    reconnect: (serverName, afterAuth) => reconnectServer(state, ctx, serverName, afterAuth),
    canAuthenticate: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      return definition ? !isServerDisabled(definition) && supportsOAuth(definition) : false;
    },
    authenticate: (serverName: string) =>
      authenticateServer(serverName, config, ctx, state.owner.signal, state.oauthRuntime),
    getConnectionStatus: (serverName: string) => {
      authStatusFailures.delete(serverName);
      const definition = config.mcpServers[serverName];
      if (isServerDisabled(definition)) {
        return "disabled";
      }
      const connection = state.manager.getConnection(serverName);
      const credentialStatus = panelCredentialStatus(
        state,
        serverName,
        definition,
        authStatusFailures,
      );
      if (credentialStatus !== undefined) {
        return credentialStatus;
      }
      if (connection?.status === "needs-auth") {
        return "needs-auth";
      }
      if (connection?.status === "connected") {
        return "connected";
      }
      if (getFailureAgeSeconds(state, serverName) !== null) {
        return "failed";
      }
      return "idle";
    },
    getFailureMessage: (serverName: string) =>
      authStatusFailures.get(serverName) ?? getFailureMessage(state, serverName),
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache(state.metadataCacheEnabled);
      return freshCache?.servers[serverName] ?? null;
    },
  };
}

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  onDirectToolsConfigChanged?: (
    changes: Map<string, true | string[] | false>,
  ) => void | Promise<void>,
): Promise<PanelFlowResult> {
  if (!ctx.isProjectTrusted() || ctx.mode !== "tui") {
    if (ctx.hasUI) {
      await showStatus(state, ctx);
    }
    return { configChanged: false };
  }
  if (state.programmaticConfig === true) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.",
        "info",
      );
      await showStatus(state, ctx);
    }
    return { configChanged: false };
  }
  if (Object.keys(state.config.mcpServers).length === 0) {
    return openMcpSetup(state, pi, ctx, configOverridePath, "empty");
  }

  const config = state.config;
  const cache = loadMetadataCache(state.metadataCacheEnabled);
  const configPath = configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const noticeLines = buildSharedConfigNoticeLines(configPath, ctx.cwd);

  const callbacks = buildMcpPanelCallbacks(state, config, ctx);

  let configChanged = false;

  await ctx.ui.custom<McpPanelResult>(
    (tui, _theme, keybindings, done) => {
      return createMcpPanel(
        config,
        cache,
        provenanceMap,
        callbacks,
        tui,
        (result: McpPanelResult) => {
          (async () => {
            if (!result.cancelled && result.changes.size > 0) {
              writeDirectToolsConfig(result.changes, provenanceMap);
              await onDirectToolsConfigChanged?.(result.changes);
              ctx.ui.notify("Direct tools updated for this session.", "info");
            }
            done(result);
          })().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Direct tools updated, but live refresh failed: ${message}`, "error");
            configChanged = true;
            done(result);
          });
        },
        { noticeLines, keybindings },
      );
    },
    { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
  );

  if (noticeLines.length > 0) {
    markSharedConfigHintShown();
  }

  return { configChanged };
}

export async function openMcpAuthPanel(
  state: McpExtensionState,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) {
    return { configChanged: false };
  }
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("Use /mcp-auth <server> while this project is untrusted.", "info");
    return { configChanged: false };
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Use /mcp-auth <server> to authenticate outside TUI mode.", "info");
    return { configChanged: false };
  }
  if (state.programmaticConfig === true) {
    ctx.ui.notify(
      "Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.",
      "info",
    );
    return { configChanged: false };
  }

  const config = state.config;
  const oauthServers = Object.entries(config.mcpServers).filter(
    ([, definition]) => !isServerDisabled(definition) && supportsOAuth(definition),
  );
  if (oauthServers.length === 0) {
    ctx.ui.notify("No OAuth-capable MCP servers are configured.", "warning");
    return { configChanged: false };
  }

  const cache = loadMetadataCache(state.metadataCacheEnabled);
  const configPath = configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const callbacks = buildMcpPanelCallbacks(state, config, ctx);

  return ctx.ui.custom<PanelFlowResult>(
    (tui, _theme, keybindings, done) =>
      createMcpPanel(
        config,
        cache,
        provenanceMap,
        callbacks,
        tui,
        () => done({ configChanged: false }),
        {
          authOnly: true,
          keybindings,
          noticeLines: ["Select an OAuth MCP server and press Enter or ctrl+a to authenticate."],
        },
      ),
    { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
  );
}
