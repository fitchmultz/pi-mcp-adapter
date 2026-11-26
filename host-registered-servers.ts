import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredMcpServer,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  cloneMcpConfig,
  isPathInsideProject,
  loadMcpConfig,
  loadMcpConfigWithBase,
} from "./config.ts";
import {
  hasConfiguredTransport,
  mergeConfigs,
  pruneOrphanOverrideEntries,
} from "./config-merge.ts";
import { translateRegisteredMcpServers } from "./config-native-pi.ts";
import { isBuiltinMcpActive } from "./host-contract.ts";
import { canPreserveFrozenTools, type FrozenToolsSnapshot } from "./host-session.ts";
import { logger } from "./logger.ts";
import { asObjectRecord } from "./mcp-output-values.ts";
import { getMetadataCachePath, isServerCacheValid, loadMetadataCache } from "./metadata-cache.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import type { McpExtensionState } from "./state.ts";
import {
  createMcpDirectToolCallRenderer,
  renderMcpProxyToolCall,
  renderMcpToolResult,
} from "./tool-result-renderer.ts";
import {
  formatToolName,
  getServerPrefix,
  isServerDisabled,
  resolveToolPrefix,
  type McpAdapterOptions,
  type McpConfig,
  type PromptMetadata,
} from "./types.ts";

const NATIVE_MCP_TOOL_PATTERN = /^mcp__(.+?)__(.+)$/;

export function readRegisteredMcpServers(
  pi: Partial<Pick<ExtensionAPI, "getMcpServers">>,
): readonly RegisteredMcpServer[] {
  return typeof pi.getMcpServers === "function" ? pi.getMcpServers() : [];
}

/**
 * Merge extension-registered servers underneath file configs. Any file server defining a
 * transport wholesale-replaces an extension server of the same name; override-only entries
 * (for example `disabled` or `directTools`) layer cleanly on top.
 */
export function mergeRegisteredWithFileConfig(
  fileConfig: McpConfig,
  registered: readonly RegisteredMcpServer[],
  cwd: string,
): McpConfig {
  if (registered.length === 0) {
    return pruneOrphanOverrideEntries(fileConfig);
  }
  const translated = translateRegisteredMcpServers(registered, cwd);
  const fileTransportServers = new Set<string>();
  for (const [name, entry] of Object.entries(fileConfig.mcpServers)) {
    if (hasConfiguredTransport(entry)) {
      fileTransportServers.add(name);
    }
  }
  return pruneOrphanOverrideEntries(
    mergeConfigs(translated, fileConfig, { replaceServers: fileTransportServers }),
  );
}

export function resolveHostConfig(input: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly options: McpAdapterOptions;
  readonly sessionConfig: McpConfig | undefined;
}): { readonly config: McpConfig; readonly configPath: string | undefined } {
  const { pi, ctx, options, sessionConfig } = input;
  let config: McpConfig;
  let configPath: string | undefined;
  if (sessionConfig !== undefined) {
    config = cloneMcpConfig(sessionConfig);
  } else {
    const flag = pi.getFlag("mcp-config");
    configPath = options.configPath ?? (typeof flag === "string" ? flag : undefined);
    const builtinActive = isBuiltinMcpActive(pi);
    const loadOptions = {
      includeProject: ctx.isProjectTrusted(),
      ...(builtinActive ? { includeNativePi: false } : {}),
    };
    if (builtinActive) {
      config = loadMcpConfig(configPath, ctx.cwd, loadOptions);
    } else {
      const registered = readRegisteredMcpServers(pi);
      const baseConfig =
        registered.length > 0 ? translateRegisteredMcpServers(registered, ctx.cwd) : undefined;
      config = loadMcpConfigWithBase(configPath, ctx.cwd, loadOptions, baseConfig);
    }
  }
  return {
    config: options.transformConfig
      ? cloneMcpConfig(options.transformConfig(cloneMcpConfig(config), ctx))
      : config,
    configPath,
  };
}

export interface StagedHostReconcile {
  readonly previousConfig: McpConfig;
  readonly nextConfig: McpConfig;
  readonly nextConfigPath: string | undefined;
  readonly cwd: string;
  readonly cacheEnabled: boolean;
  readonly directToolsFrozen: boolean;
}

export function stageHostReconcile(input: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly options: McpAdapterOptions;
  readonly sessionConfig: McpConfig | undefined;
  readonly runtimeCwd: string | undefined;
  readonly cwdChanged: boolean;
  readonly directToolsFrozen: boolean;
  readonly previous: FrozenToolsSnapshot;
}): StagedHostReconcile {
  const cwd = input.cwdChanged ? input.ctx.cwd : (input.runtimeCwd ?? input.ctx.cwd);
  const effectiveCtx = cwd === input.ctx.cwd ? input.ctx : { ...input.ctx, cwd };
  const resolved = resolveHostConfig({
    pi: input.pi,
    ctx: effectiveCtx,
    options: input.options,
    sessionConfig: input.sessionConfig,
  });
  const cacheEnabled =
    effectiveCtx.isProjectTrusted() || !isPathInsideProject(getMetadataCachePath(), cwd);
  const directToolsFrozen = input.cwdChanged
    ? canPreserveFrozenTools(input.directToolsFrozen, input.previous, {
        config: resolved.config,
        configPath: resolved.configPath,
        cacheEnabled,
      })
    : input.directToolsFrozen;
  return {
    previousConfig: input.previous.config,
    nextConfig: resolved.config,
    nextConfigPath: resolved.configPath,
    cwd,
    cacheEnabled,
    directToolsFrozen,
  };
}

export function withDirectToolOverrides(
  config: McpConfig,
  changes: Map<string, true | string[] | false>,
): McpConfig {
  const mcpServers = { ...config.mcpServers };
  for (const [name, value] of changes) {
    const definition = mcpServers[name];
    if (definition) {
      mcpServers[name] = { ...definition, directTools: value };
    }
  }
  return { ...config, mcpServers };
}

function matchesConfiguredPrefix(toolName: string, config: McpConfig): boolean {
  const globalPrefix = config.settings?.toolPrefix;
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const prefix = getServerPrefix(serverName, resolveToolPrefix(definition, globalPrefix));
    if (prefix !== "" && toolName.startsWith(`${prefix}_`) && toolName.length > prefix.length + 1) {
      return true;
    }
  }
  return false;
}

function matchesUnprefixedCachedTool(
  toolName: string,
  config: McpConfig,
  cacheEnabled: boolean,
): boolean {
  const globalPrefix = config.settings?.toolPrefix;
  const unprefixedServers = Object.entries(config.mcpServers).filter(
    ([, definition]) => resolveToolPrefix(definition, globalPrefix) === "none",
  );
  if (unprefixedServers.length === 0) {
    return false;
  }
  const cache = loadMetadataCache(cacheEnabled);
  if (!cache) {
    return false;
  }
  return unprefixedServers.some(([serverName, definition]) => {
    const entry = cache.servers[serverName];
    if (!entry || !isServerCacheValid(entry, definition)) {
      return false;
    }
    return entry.tools.some((tool) => formatToolName(tool.name, serverName, "none") === toolName);
  });
}

export function resolveFallbackMcpToolRenderers(
  toolName: string,
  config: McpConfig,
  cacheEnabled: boolean,
): ToolRenderers | undefined {
  if (toolName === "mcp") {
    return {
      renderCall: (args, theme, context) =>
        renderMcpProxyToolCall(asObjectRecord(args) ?? {}, theme, context),
      renderResult: renderMcpToolResult,
    };
  }
  if (
    NATIVE_MCP_TOOL_PATTERN.test(toolName) ||
    matchesConfiguredPrefix(toolName, config) ||
    matchesUnprefixedCachedTool(toolName, config, cacheEnabled)
  ) {
    const renderDirectCall = createMcpDirectToolCallRenderer(toolName);
    return {
      renderCall: (args, theme, context) =>
        renderDirectCall(asObjectRecord(args) ?? {}, theme, context),
      renderResult: renderMcpToolResult,
    };
  }
  return undefined;
}

export function registerFallbackMcpToolRenderer(
  pi: Partial<Pick<ExtensionAPI, "registerToolRenderer">>,
  getConfig: () => McpConfig,
  getCacheEnabled: () => boolean,
): void {
  if (typeof pi.registerToolRenderer !== "function") {
    return;
  }
  pi.registerToolRenderer((toolName, next) => {
    const resolved = next();
    if (resolved !== undefined) {
      return resolved;
    }
    return resolveFallbackMcpToolRenderers(toolName, getConfig(), getCacheEnabled());
  });
}

function collectLiveServerPrompts(
  state: McpExtensionState,
  config: McpConfig,
): { readonly prompts: PromptMetadata[]; readonly seenServers: Set<string> } {
  const prompts: PromptMetadata[] = [];
  const seenServers = new Set<string>();
  for (const [serverName, entries] of state.promptMetadata) {
    if (isServerDisabled(config.mcpServers[serverName])) {
      continue;
    }
    seenServers.add(serverName);
    prompts.push(...entries);
  }
  return { prompts, seenServers };
}

/**
 * Tracks active MCP prompt slash commands across sessions and working-directory changes so stale
 * project commands stop resolving and updated commands re-register cleanly.
 */
export class HostPromptRegistry {
  private readonly pi: ExtensionAPI;
  private readonly getState: () => McpExtensionState | null;
  private readonly active = new Map<string, PromptMetadata>();
  private readonly registeredDescriptions = new Map<string, string>();

  constructor(pi: ExtensionAPI, getState: () => McpExtensionState | null) {
    this.pi = pi;
    this.getState = getState;
  }

  clear(): void {
    this.active.clear();
  }

  syncCached(config: McpConfig, cacheEnabled: boolean): void {
    this.syncSpecs(resolveCachedPrompts(config, cacheEnabled));
  }

  syncFromState(config: McpConfig, cacheEnabled: boolean): void {
    const state = this.getState();
    const cached = resolveCachedPrompts(config, cacheEnabled);
    if (!state) {
      this.syncSpecs(cached);
      return;
    }
    const { prompts, seenServers } = collectLiveServerPrompts(state, config);
    for (const entry of cached) {
      if (!seenServers.has(entry.serverName) && !state.promptMetadataLive.has(entry.serverName)) {
        prompts.push(entry);
      }
    }
    this.syncSpecs(prompts);
  }

  private syncSpecs(specs: Iterable<PromptMetadata>): void {
    const nextActive = new Map<string, PromptMetadata>();
    for (const spec of specs) {
      if (nextActive.has(spec.commandName)) {
        logger.debug(
          `MCP: prompt "${spec.originalName}" on ${spec.serverName} skipped; /${spec.commandName} is already active`,
        );
        continue;
      }
      nextActive.set(spec.commandName, spec);
    }
    for (const commandName of Array.from(this.active.keys())) {
      if (!nextActive.has(commandName)) {
        this.active.delete(commandName);
      }
    }
    for (const [commandName, spec] of nextActive) {
      this.active.set(commandName, spec);
      const command = createPromptCommand(this.pi, this.getState, spec, () =>
        this.active.get(commandName),
      );
      if (this.registeredDescriptions.get(commandName) !== command.description) {
        this.pi.registerCommand(commandName, command);
        this.registeredDescriptions.set(commandName, command.description);
      }
    }
  }
}
