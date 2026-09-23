import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, PromptMetadata } from "./types.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { Type } from "typebox";
import { showStatus, showTools, showPrompts, reconnectServer, reconnectServers, authenticateServer, logoutServer, openMcpAuthPanel, openMcpPanel, openMcpSetup } from "./commands.ts";
import { cloneMcpConfig, isPathInsideProject, loadMcpConfig, writeProjectServerDisabledOverride } from "./config.ts";
import { buildProxyDescription, directToolSelection, getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { flushMetadataCache, initializeMcp, lazyConnect, updateStatusBar } from "./init.ts";
import { getMetadataCachePath, isServerCacheValid, loadMetadataCache, reconstructToolMetadata, type MetadataCache } from "./metadata-cache.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import { logger } from "./logger.ts";
import { executeAuthComplete, executeAuthStart, executeCall, executeConnect, executeDescribe, executeInstructions, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.ts";
import { formatTerminalError } from "./utils.ts";
import { createOAuthRuntime, shutdownOAuth } from "./mcp-auth-flow.ts";
import { renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { createMcpRuntimeOwner, createOwnedUi, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { DEFAULT_MCP_SCRIPT_TIMEOUT_MS, runMcpScript } from "./mcp-code.ts";
import { MAX_PAGE_SIZE, paginate, rankToolMatches } from "./search-ranking.ts";
import { createToolLoader, supportsNativeAsync, type SearchAPI } from "./tool-loader.ts";
import { gatewayParameters, prepareGatewayArguments, type GatewayArguments } from "./gateway-arguments.ts";
import { executeResourceList, executeResourceRead } from "./resource-tools.ts";
import { guardMcpOutput, guardedMcpDetails, readMcpResult, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { abortable } from "./abort.ts";
import { onSessionCheckpoint, prepareMcpCheckpoint } from "./checkpoint.ts";

export type { McpAdapterOptions, McpOperationContext, McpToolCallEvent, McpToolCallIdentity } from "./types.ts";
export {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  type McpServerRuntimeStatus,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
} from "./types.ts";

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_WAIT_TIMED_OUT: unique symbol = Symbol("init-wait-timed-out");


async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof INIT_WAIT_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof INIT_WAIT_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(INIT_WAIT_TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function installMcpAdapter(pi: ExtensionAPI, options: McpAdapterOptions) {
  const beforeExecute = options.beforeExecute;
  const sessionConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
  const programmaticConfig = sessionConfig !== undefined;
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let currentOwner: McpRuntimeOwner | null = null;
  let currentOAuthRuntime: McpOAuthRuntime | null = null;
  let lifecycleGeneration = 0;
  let currentConfigPath: string | undefined;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) {
      publishMcpStatusShutdown(pi.events);
      return;
    }

    const failures: unknown[] = [];
    try { publishMcpStatusShutdown(currentState.statusEvents); } catch (error) { failures.push(error); }
    try { currentState.uiServer?.close(reason); } catch (error) { failures.push(error); }
    currentState.uiServer = null;
    try { flushMetadataCache(currentState); } catch (error) { failures.push(error); }
    try {
      if (currentState.owner) await currentState.owner.stop(reason);
      else await currentState.lifecycle.gracefulShutdown();
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "MCP state persistence/cleanup failed");
  }

  const earlyConfig = programmaticConfig
    ? cloneMcpConfig(sessionConfig)
    : { mcpServers: {} };
  const earlyCache: MetadataCache | null = null;
  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const envDirectToolOverride = envRaw?.split(",").map(s => s.trim()).filter(Boolean);
  const toolLoader = createToolLoader(pi, () => state, () => initPromise, beforeExecute);
  const deactivatedTools = new Set<string>();
  let runtimeCwd: string | undefined;
  let nativeAsyncSupported = false;
  let proxyToolRegistered = false;
  let proxyToolDescription: string | null = null;
  let directToolsFrozen = false;

  function deactivateTools(toolNames: string[]): void {
    if (toolNames.length === 0) return;
    const remove = new Set(toolNames);
    const activeTools = pi.getActiveTools();
    for (const toolName of toolNames) {
      if (activeTools.includes(toolName)) deactivatedTools.add(toolName);
    }
    const nextActiveTools = activeTools.filter((name) => !remove.has(name));
    if (nextActiveTools.length !== activeTools.length) {
      pi.setActiveTools(nextActiveTools);
    }
  }

  function applyDirectToolConfigChanges(changes: Map<string, true | string[] | false>): void {
    if (!state) return;
    for (const [serverName, value] of changes) {
      const definition = state.config.mcpServers[serverName];
      if (!definition) continue;
      state.config.mcpServers[serverName] = { ...definition, directTools: value };
    }
  }

  function syncToolSurface(ctx?: ExtensionContext): void {
    const config = state?.config ?? earlyConfig;
    const cache = loadMetadataCache(state?.metadataCacheEnabled ?? false);
    toolLoader.sync(config, cache, envRaw === "__none__" ? null : envDirectToolOverride, nativeAsyncSupported, specs => {
      syncProxyTool(config, cache, specs);
      syncScriptTool(config);
    });
  }

  const registeredPromptCommands = new Set<string>();

  function registerPromptCommands(specs: Iterable<PromptMetadata>): void {
    for (const spec of specs) {
      if (registeredPromptCommands.has(spec.commandName)) {
        logger.debug(`MCP: prompt "${spec.originalName}" on ${spec.serverName} skipped; /${spec.commandName} is already registered`);
        continue;
      }
      registeredPromptCommands.add(spec.commandName);
      pi.registerCommand(spec.commandName, createPromptCommand(pi, () => state, spec));
    }
  }

  function syncPromptCommands(): void {
    registerPromptCommands([...(state?.promptMetadata?.values() ?? [])].flat());
  }

  if (!options.transformConfig) registerPromptCommands(resolveCachedPrompts(earlyConfig, false));

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  function startInitialization(
    ctx: ExtensionContext,
    owner: McpRuntimeOwner,
    oauthRuntime: McpOAuthRuntime,
    runtimeConfig: McpConfig,
    generation: number,
  ): Promise<void> {
    const promise = initializeMcp(pi, ctx, owner, {
      ...(programmaticConfig ? { config: runtimeConfig } : { resolvedConfig: runtimeConfig }),
      ...(options.outputDirectory !== undefined ? { outputDirectory: options.outputDirectory } : {}),
      oauthRuntime,
      statusEvents: pi.events,
      ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    });
    initPromise = promise;

    return promise.then(async (nextState) => {
      if (!owner.isActive() || generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error(`MCP: failed to clean stale initialization state: ${formatTerminalError(error)}`);
        }
        return;
      }

      state = nextState;
      nextState.onToolMetadataUpdated = (_serverName, _reason) => {
        if (state !== nextState || !owner.isActive()) return;
        syncPromptCommands();
        if (directToolsFrozen) {
          logger.debug(`MCP: metadata update for ${_serverName} (${_reason}) skipped — directTools frozen`);
          return;
        }
        syncToolSurface(ctx);
      };
      for (const server of toolLoader.selectedServers()) {
        if (!nextState.toolMetadata.has(server) && nextState.config.mcpServers[server]) await lazyConnect(nextState, server, owner.signal);
      }
      owner.throwIfInactive();
      syncPromptCommands();
      syncToolSurface(ctx);
      updateStatusBar(nextState);
      initPromise = null;
      if (nextState.config.settings?.freezeDirectTools === true) {
        directToolsFrozen = true;
        logger.info("MCP: direct tools frozen after initial sync — reconnects won't rebuild the system prompt; use mcp({ action: \"connect\", server: \"server\" }) to rediscover");
      }
    }).catch(async err => {
      if (!owner.isActive() || generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error(`MCP initialization failed: ${formatTerminalError(err)}`);
      initPromise = null;
      if (state) return;

      try {
        await Promise.all([
          owner.stop("MCP initialization failed"),
          shutdownOAuth(oauthRuntime),
        ]);
      } catch (error) {
        console.error(`MCP: failed to clean rejected initialization: ${formatTerminalError(error)}`);
      }
    });
  }

  async function startSession(ctx: ExtensionContext) {
    runtimeCwd = ctx.cwd;
    nativeAsyncSupported = supportsNativeAsync(ctx);
    directToolsFrozen = false;
    const generation = ++lifecycleGeneration;
    const previousState = state;
    const previousOwner = currentOwner;
    const previousOAuthRuntime = currentOAuthRuntime;
    const owner = createMcpRuntimeOwner();
    const oauthRuntime = createOAuthRuntime(owner.signal);
    currentOwner = owner;
    currentOAuthRuntime = oauthRuntime;
    state = null;
    initPromise = null;

    // Abort synchronously before awaiting cleanup so old callbacks and startup
    // work cannot resume into a stale ExtensionContext.
    const stopPrevious = previousOwner?.stop("MCP extension session restarted") ?? Promise.resolve();
    try {
      await Promise.all([
        stopPrevious,
        shutdownState(previousState, "session_restart"),
        previousOAuthRuntime ? shutdownOAuth(previousOAuthRuntime) : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(`MCP: failed to shut down previous session state: ${formatTerminalError(error)}`);
    }

    if (generation !== lifecycleGeneration || !owner.isActive()) return;

    let runtimeConfig: McpConfig;
    if (programmaticConfig) {
      currentConfigPath = undefined;
      runtimeConfig = cloneMcpConfig(sessionConfig);
    } else {
      const registeredConfigPath = pi.getFlag("mcp-config");
      currentConfigPath = options.configPath
        ?? (typeof registeredConfigPath === "string" ? registeredConfigPath : undefined);
      runtimeConfig = loadMcpConfig(
        currentConfigPath,
        ctx.cwd,
        { includeProject: ctx.isProjectTrusted() },
      );
    }
    if (options.transformConfig) {
      runtimeConfig = cloneMcpConfig(options.transformConfig(cloneMcpConfig(runtimeConfig), ctx));
    }
    const metadataCacheEnabled = ctx.isProjectTrusted()
      || !isPathInsideProject(getMetadataCachePath(), ctx.cwd);
    toolLoader.restore(ctx);
    registerPromptCommands(resolveCachedPrompts(runtimeConfig, metadataCacheEnabled));
    const runtimeCache = loadMetadataCache(metadataCacheEnabled);
    toolLoader.sync(runtimeConfig, runtimeCache, envRaw === "__none__" ? null : envDirectToolOverride, nativeAsyncSupported, specs => {
      syncProxyTool(runtimeConfig, runtimeCache, specs);
      syncScriptTool(runtimeConfig);
    });

    const initialization = startInitialization(ctx, owner, oauthRuntime, runtimeConfig, generation);
    if (envRaw !== undefined && envRaw !== "__none__") {
      const missingEnvDirectTools = getMissingConfiguredDirectToolServers(
        runtimeConfig,
        runtimeCache,
        envDirectToolOverride,
      );
      if (missingEnvDirectTools.length > 0) {
        await initialization;
      }
    }
  }

  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("session_tree", (_event, ctx) => {
    toolLoader.restore(ctx);
    syncToolSurface(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    nativeAsyncSupported = supportsNativeAsync(ctx);
    if (state) syncToolSurface(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.cwd !== runtimeCwd) await startSession(ctx);
  });

  onSessionCheckpoint(pi, async event => {
    if (initPromise) return { sleepReady: false, reason: "MCP initialization is active" };
    if (!state || !currentOwner?.isActive()) return { sleepReady: false, reason: "MCP runtime is not initialized" };
    return prepareMcpCheckpoint(state, event);
  });

  pi.on("session_shutdown", async () => {
    // Cached tool selections exist before background server initialization finishes.
    toolLoader.persist();
    ++lifecycleGeneration;
    const currentState = state;
    const owner = currentOwner;
    const oauthRuntime = currentOAuthRuntime;
    currentOwner = null;
    currentOAuthRuntime = null;
    state = null;
    initPromise = null;

    // Abort before awaiting cleanup so delayed initialization cannot touch stale
    // Pi context after session shutdown.
    const stopOwner = owner?.stop("MCP extension session shutdown") ?? Promise.resolve();
    const results = await Promise.allSettled([
      stopOwner,
      shutdownState(currentState, "session_shutdown"),
      oauthRuntime ? shutdownOAuth(oauthRuntime) : Promise.resolve(),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    // Ordinary extension error handling owns reporting. Strict clean-exit hosts must see failure.
    if (failures.length) throw new AggregateError(failures, "MCP session shutdown persistence/cleanup failed");
  });

  // Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  function createCommandContext(ctx: ExtensionContext): {
    owner: McpRuntimeOwner | null;
    context: ExtensionContext;
  } {
    const owner = currentOwner;
    const hasUI = ctx.hasUI;
    const projectTrusted = ctx.isProjectTrusted();
    return {
      owner,
      context: {
        hasUI,
        ui: hasUI ? (owner ? createOwnedUi(ctx.ui, owner) : ctx.ui) : undefined,
        cwd: ctx.cwd,
        mode: ctx.mode,
        signal: owner?.signal ?? ctx.signal,
        isProjectTrusted: () => projectTrusted,
      } as unknown as ExtensionContext,
    };
  }

  async function ensureCommandState(owner: McpRuntimeOwner | null, ctx: ExtensionContext): Promise<McpExtensionState | null> {
    if (!state && initPromise) {
      try {
        const initialized = await initPromise;
        owner?.throwIfInactive();
        state = initialized;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify(`MCP initialization failed: ${message}`, "error");
        return null;
      }
    }
    if (!state) ctx.ui?.notify("MCP not initialized", "error");
    return state;
  }

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const argumentMatch = normalized.match(/^(\S+)\s+(.*)$/);
      if (!argumentMatch) {
        const subcommands = [
          { value: "reconnect", label: "reconnect — Reconnect servers" },
          { value: "tools", label: "tools — List all tools" },
          { value: "prompts", label: "prompts — List all MCP prompts" },
          { value: "setup", label: "setup — Configure MCP servers" },
          { value: "logout", label: "logout — Clear server credentials" },
          { value: "disable", label: "disable — Disable a server" },
          { value: "enable", label: "enable — Enable a server" },
          { value: "status", label: "status — Show server status" },
        ].filter(({ value }) => value.startsWith(normalized));
        return subcommands.length > 0 ? subcommands : null;
      }

      const [, subcommand, argumentPrefix] = argumentMatch;
      if (
        (subcommand !== "reconnect" && subcommand !== "logout" && subcommand !== "disable" && subcommand !== "enable")
        || argumentPrefix === undefined
        || !state
      ) return null;

      const servers = Object.keys(state.config.mcpServers)
        .filter((serverName) => serverName.startsWith(argumentPrefix.trimStart()))
        .map((serverName) => ({ value: `${subcommand} ${serverName}`, label: serverName }));
      return servers.length > 0 ? servers : null;
    },
    handler: async (args, ctx) => {
      const { owner: commandOwner, context: commandCtx } = createCommandContext(ctx);
      const commandProjectTrusted = commandCtx.isProjectTrusted();
      const commandState = await ensureCommandState(commandOwner, commandCtx);
      if (!commandState) return;

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          commandOwner?.throwIfInactive();
          await reconnectServers(commandState, commandCtx, targetServer);
          if (directToolsFrozen) syncToolSurface(commandCtx);
          break;
        case "tools":
          await showTools(commandState, commandCtx);
          break;
        case "prompts":
          await showPrompts(commandState, commandCtx);
          break;
        case "setup": {
          commandOwner?.throwIfInactive();
          if (programmaticConfig) {
            commandCtx.ui?.notify("MCP setup is unavailable when config is supplied by createMcpAdapter().", "info");
            break;
          }
          const result = await openMcpSetup(commandState, pi, commandCtx, currentConfigPath, "setup");
          if (result?.configChanged) {
            commandOwner?.throwIfInactive();
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          commandOwner?.throwIfInactive();
          await logoutServer(serverName, commandState, commandCtx);
          break;
        }
        case "disable":
        case "enable": {
          const serverName = rest;
          if (!commandProjectTrusted) {
            commandCtx.ui?.notify("Project MCP changes are unavailable until this project is trusted.", "warning");
            break;
          }
          if (programmaticConfig) {
            commandCtx.ui?.notify(`/mcp ${subcommand} is unavailable when config is supplied by createMcpAdapter().`, "info");
            break;
          }
          if (!serverName) {
            commandCtx.ui?.notify(`Usage: /mcp ${subcommand} <server>`, "error");
            break;
          }
          if (!commandState.config.mcpServers[serverName]) {
            commandCtx.ui?.notify(`Server "${serverName}" not found in effective config`, "error");
            break;
          }
          commandOwner?.throwIfInactive();
          const result = writeProjectServerDisabledOverride(currentConfigPath, commandCtx.cwd, serverName, subcommand === "disable");
          if (result.changed) {
            commandCtx.ui?.notify(`${subcommand === "disable" ? "Disabled" : "Enabled"} server "${serverName}" in ${result.path} — run /reload to apply`, "info");
          } else {
            commandCtx.ui?.notify(`Server "${serverName}" is already ${subcommand === "disable" ? "disabled" : "enabled"}`, "info");
          }
          break;
        }
        case "status":
        case "":
        default:
          if (commandCtx.hasUI) {
            commandOwner?.throwIfInactive();
            if (programmaticConfig) {
              commandCtx.ui?.notify("MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.", "info");
              await showStatus(commandState, commandCtx);
              break;
            }
            const result = await openMcpPanel(commandState, pi, commandCtx, currentConfigPath, (changes) => {
              applyDirectToolConfigChanges(changes);
              syncToolSurface(commandCtx);
            });
            if (result?.configChanged) {
              commandOwner?.throwIfInactive();
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(commandState, commandCtx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const { owner: commandOwner, context: commandCtx } = createCommandContext(ctx);
      const serverName = args?.trim();
      if (!serverName && !commandCtx.hasUI) {
        return;
      }

      const commandState = await ensureCommandState(commandOwner, commandCtx);
      if (!commandState) return;

      if (!serverName) {
        if (programmaticConfig) {
          commandCtx.ui?.notify("Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.", "info");
          return;
        }
        await openMcpAuthPanel(commandState, commandCtx, currentConfigPath);
        return;
      }

      const result = await authenticateServer(serverName, commandState.config, commandCtx, commandCtx.signal, commandState.oauthRuntime);
      if (result.ok) {
        commandOwner?.throwIfInactive();
        await reconnectServer(commandState, commandCtx, serverName, true);
      }
    },
  });

  async function getToolState(signal?: AbortSignal) {
    const owner = currentOwner;
    if (!state && initPromise) {
      try {
        const initialized = await awaitWithTimeout(abortable(initPromise, signal), INIT_WAIT_TIMEOUT_MS);
        if (initialized === INIT_WAIT_TIMED_OUT) return {
          content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
          details: { error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
        };
        owner?.throwIfInactive();
        state = initialized;
      } catch (error) {
        if (signal?.aborted || (owner && isAbortError(error, owner.signal))) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }], details: { error: "init_failed", message } };
      }
    }
    owner?.throwIfInactive();
    return state ?? { content: [{ type: "text" as const, text: "MCP not initialized" }], details: { error: "not_initialized" } };
  }

  async function searchAndLoad(params: { query: string; server?: string; limit?: number; offset?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    const ready = await getToolState(signal);
    if ("content" in ready) return { ...ready, tools: [] };
    if (params.server && !ready.toolMetadata.has(params.server)) {
      const discovery = await executeConnect(ready, params.server, signal);
      if (discovery.details.error) return { ...discovery, tools: [] };
    }
    syncToolSurface(ctx);
    const matches = params.query.trim() ? rankToolMatches(ready, params.query, params.server)
      : params.server ? (ready.toolMetadata.get(params.server) ?? []).filter(tool => !tool.resourceUri).map(tool => ({ server: params.server!, tool })).sort((a, b) => a.tool.name.localeCompare(b.tool.name)) : [];
    const page = paginate(matches, params.offset ?? 0, params.limit ?? 5);
    const tools = toolLoader.activate(page.items);
    const result = executeSearch(ready, params.query, params.server, tools.length < page.items.length, params.limit ?? 5, params.offset, "mcp_search");
    const guarded = await guardMcpOutput([
      ...result.content,
      { type: "text", text: tools.length ? `Loaded for the next request: ${JSON.stringify(tools)}` : "No direct tools loaded. Use mcp action call or tools.call in mcp_script with the returned exact names." },
    ], resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory));
    return { content: guarded.content, details: { ...result.details, ...guardedMcpDetails(guarded), loaded: tools }, tools };
  }

  const searchDefinition = {
    name: "mcp_search", label: "MCP Search",
    description: "Discover MCP tools by name, description, and parameter guidance, and load matching tools with their complete schemas for the next request. Start with a specific task query. Specify server to discover an uncached server; an empty query with server browses it. Results report incomplete catalog coverage. Resources use mcp action resources/read-resource.",
    parameters: Type.Object({
      query: Type.String(),
      server: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: "Tools to load (default 5)." })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    renderResult: renderMcpToolResult,
    async execute(toolCallId: string, params: { query: string; server?: string; limit?: number; offset?: number }, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext) {
      if (beforeExecute) {
        if (currentOwner) await currentOwner.runCallback("beforeExecute", () => beforeExecute(toolCallId, ctx));
        else await beforeExecute(toolCallId, ctx);
      }
      return searchAndLoad(params, signal, ctx);
    },
  };
  if (toolLoader.native) (pi as SearchAPI).registerToolSearch!(searchDefinition);
  else pi.registerTool(searchDefinition);

  let scriptToolRegistered = false;

  function registerScriptTool(): void {
    if (scriptToolRegistered) return;
    pi.registerTool({
      ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
      name: "mcp_script",
      label: "MCP Script",
      description: "Compose MCP calls with trusted JavaScript: await tools.search({query, server?}), tools.describe({path}), tools.call(path,args). Describe returns complete JSON schemas. Calls return {ok,data} with raw MCP results, or {ok:false,error,data?}. Resources: tools.resources({server}), tools.readResource({server,uri}). Saved results: tools.readResult({ref,path?,fields?,offset?,limit?}); never repeats a remote call. Use emit(value) to return selected data or content blocks. No Node, filesystem, or network globals. Prefer a direct tool for one call; use scripts for loops, filtering and chains.",
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      parameters: Type.Object({
        code: Type.String({ description: "Trusted JavaScript MCP script. Use tools.<prefixedToolName>(args) and emit(value)." }),
        timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: options.defaultScriptTimeoutMs === null
          ? "Execution timeout in milliseconds (no default deadline)"
          : `Execution timeout in milliseconds (default: ${options.defaultScriptTimeoutMs ?? DEFAULT_MCP_SCRIPT_TIMEOUT_MS})` })),
      }),
      renderResult: renderMcpToolResult,
      async execute(toolCallId: string, params: { code: string; timeoutMs?: number }, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext) {
        const ready = await getToolState(signal);
        if ("content" in ready) return ready;
        return runMcpScript(ready, params.code, params.timeoutMs ?? options.defaultScriptTimeoutMs, getPiTools, signal, toolCallId,
          beforeExecute ? (callSignal, operation) => beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation) : undefined);
      },
    });
    scriptToolRegistered = true;
  }

  function syncScriptTool(config: McpConfig): void {
    if (config.settings?.scriptMode === false) {
      if (scriptToolRegistered) deactivateTools(["mcp_script"]);
      return;
    }

    registerScriptTool();
    if (deactivatedTools.delete("mcp_script")) {
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes("mcp_script")) pi.setActiveTools([...activeTools, "mcp_script"]);
    }
  }

  function registerProxyTool(description: string): void {
    pi.registerTool({
      ...(beforeExecute ? { executionMode: "sequential" as const } : {}),
      name: "mcp", label: "MCP", description,
      promptSnippet: "MCP server operations, resources, saved result readback, and fallback tool calls",
      renderCall: renderMcpProxyToolCall,
      parameters: gatewayParameters,
      prepareArguments: prepareGatewayArguments,
      renderResult: renderMcpToolResult,
      async execute(toolCallId: string, rawParams: GatewayArguments, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext) {
        const params = prepareGatewayArguments(rawParams);
        if (beforeExecute && params.action !== "call" && params.action !== "read-resource") {
          if (currentOwner) await currentOwner.runCallback("beforeExecute", () => beforeExecute(toolCallId, ctx));
          else await beforeExecute(toolCallId, ctx);
        }
        const ready = await getToolState(signal);
        if ("content" in ready) return ready;
        const present = async (result: Awaited<ReturnType<typeof executeCall>>) => {
          const guarded = await guardMcpOutput(result.content, resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory));
          return { content: guarded.content, details: { ...result.details, ...guardedMcpDetails(guarded) } };
        };
        const beforeDispatch = beforeExecute
          ? (callSignal: AbortSignal | undefined, operation: import("./types.ts").McpOperationContext) => beforeExecute(toolCallId, { ...ctx, signal: callSignal }, operation)
          : undefined;
        if (params.server && ["list", "search", "describe", "instructions"].includes(params.action) && !ready.toolMetadata.has(params.server)) {
          const discovery = await executeConnect(ready, params.server, signal);
          if (discovery.details.error) return discovery;
          syncToolSurface(ctx);
        }
        switch (params.action) {
          case "ui-messages": return executeUiMessages(ready);
          case "auth-start": return executeAuthStart(ready, params.server!, signal);
          case "auth-complete": {
            const input = params.args?.redirectUrl ?? params.args?.code ?? params.args?.input;
            if (input !== undefined && (typeof input !== "string" || input.trim().length === 0)) throw new Error("auth-complete requires a non-empty redirectUrl, code, or input");
            return executeAuthComplete(ready, params.server!, input, signal);
          }
          case "call": return executeCall(ready, params.tool!, params.args, params.server, getPiTools, signal, { toolCallId }, beforeDispatch);
          case "connect": {
            const result = await executeConnect(ready, params.server!, signal, params.limit, params.offset);
            syncToolSurface(ctx);
            return present(result);
          }
          case "describe": return present(executeDescribe(ready, params.tool!, params.server));
          case "instructions": return present(executeInstructions(ready, params.server!));
          case "search": return present(executeSearch(ready, params.query!, params.server, params.includeSchemas, params.limit, params.offset));
          case "list": return present(executeList(ready, params.server!, params.limit, params.offset));
          case "resources": return present(await executeResourceList(ready, params.server!, params.limit, params.offset, signal));
          case "read-resource": return executeResourceRead(ready, params.server!, params.uri!, signal, { toolCallId }, beforeDispatch);
          case "read-result": return readMcpResult({ ref: params.ref!, ...(params.path !== undefined ? { path: params.path } : {}), ...(params.fields ? { fields: params.fields } : {}), ...(params.offset !== undefined ? { offset: params.offset } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) }, resolveMcpOutputGuardOptions(ready.config.settings, ready.outputDirectory));
          case "status": return present(executeStatus(ready));
        }
      },
    });
    proxyToolRegistered = true;
    proxyToolDescription = description;
  }

  function syncProxyTool(config: McpConfig, cache: MetadataCache | null, directSpecs: DirectToolSpec[]): void {
    const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
      config,
      cache,
      envRaw === undefined || envRaw === "__none__" ? undefined : envDirectToolOverride,
    );
    const hasPinnedResources = envRaw !== "__none__" && Object.entries(config.mcpServers).some(([server, definition]) => {
      if (definition.disabled === true) return false;
      const selection = directToolSelection(config, server, envDirectToolOverride);
      if (!selection) return false;
      const entry = cache?.servers[server];
      const metadata = state?.toolMetadata.get(server) ?? (entry && isServerCacheValid(entry, definition)
        ? reconstructToolMetadata(server, entry, config.settings?.toolPrefix ?? "server", definition) : []);
      return metadata.some(tool => tool.resourceUri && (selection === true || selection.includes(tool.originalName)));
    });
    const shouldRegisterProxyTool =
      config.settings?.disableProxyTool !== true
      || hasPinnedResources
      || directSpecs.length === 0
      || missingConfiguredDirectToolServers.length > 0;

    if (shouldRegisterProxyTool) {
      const description = buildProxyDescription(config);
      if (!proxyToolRegistered || proxyToolDescription !== description) {
        registerProxyTool(description);
      }
      if (deactivatedTools.delete("mcp")) {
        const activeTools = pi.getActiveTools();
        if (!activeTools.includes("mcp")) {
          pi.setActiveTools([...activeTools, "mcp"]);
        }
      }
      return;
    }

    if (proxyToolRegistered) deactivateTools(["mcp"]);
  }

  // A transform needs the session context before any configured tool surface is registered.
  if (!options.transformConfig) {
    syncProxyTool(earlyConfig, earlyCache, []);
    syncScriptTool(earlyConfig);
  }
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
  const { defaultScriptTimeoutMs } = options;
  if (defaultScriptTimeoutMs !== undefined && defaultScriptTimeoutMs !== null
    && (!Number.isInteger(defaultScriptTimeoutMs) || defaultScriptTimeoutMs < 1 || defaultScriptTimeoutMs > 2_147_483_647)) {
    throw new RangeError("defaultScriptTimeoutMs must be an integer from 1 to 2147483647, or null");
  }
  const factoryConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
  return function mcpAdapter(pi: ExtensionAPI) {
    installMcpAdapter(pi, {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(defaultScriptTimeoutMs !== undefined ? { defaultScriptTimeoutMs } : {}),
      ...(options.outputDirectory !== undefined ? { outputDirectory: options.outputDirectory } : {}),
      ...(factoryConfig !== undefined ? { config: cloneMcpConfig(factoryConfig) } : {}),
      ...(options.beforeExecute ? { beforeExecute: options.beforeExecute } : {}),
      ...(options.transformConfig ? { transformConfig: options.transformConfig } : {}),
      ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    });
  };
}

export default createMcpAdapter();
