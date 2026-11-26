import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { McpExtensionState } from "./state.ts";
import { isBuiltinMcpActive, nativePiConfigOptions, type McpAdapterHost } from "./host-contract.ts";
import * as commands from "./commands.ts";
import { createOwnedUi, type McpRuntimeOwner } from "./runtime-owner.ts";
import { writeProjectServerDisabledOverride } from "./config.ts";
import { authEligibility } from "./mcp-auth-commands.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import { hasServerUrl, resolveServerUrl } from "./utils.ts";

const MCP_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "reconnect", label: "reconnect", description: "Reconnect servers" },
  { value: "tools", label: "tools", description: "List tools (optionally by server)" },
  { value: "prompts", label: "prompts", description: "List all MCP prompts" },
  { value: "setup", label: "setup", description: "Configure MCP servers" },
  { value: "logout", label: "logout", description: "Clear server credentials" },
  { value: "disable", label: "disable", description: "Disable a server" },
  { value: "enable", label: "enable", description: "Enable a server" },
  { value: "status", label: "status", description: "Show server status" },
  { value: "reload", label: "reload", description: "Reload MCP config and runtime" },
  { value: "doctor", label: "doctor", description: "Inspect config, auth, and diagnostics" },
];

const SERVER_COMPLETION_SUBCOMMANDS = new Set([
  "reconnect",
  "tools",
  "logout",
  "disable",
  "enable",
  "doctor",
]);

function formatMcpUsage(unknownSubcommand?: string): string {
  const prefix =
    unknownSubcommand !== undefined && unknownSubcommand.length > 0
      ? `Unknown /mcp subcommand "${unknownSubcommand}". `
      : "";
  return `${prefix}Usage: /mcp [status|reconnect [server]|tools [server]|prompts|setup|logout <server>|disable <server>|enable <server>|reload|doctor [server]]`;
}

type Command = {
  state: McpExtensionState;
  ctx: ExtensionContext;
  original: ExtensionCommandContext;
  owner: McpRuntimeOwner | null;
  rest: string;
  target: string | undefined;
};

function fuzzyCompletions(items: AutocompleteItem[], query: string): AutocompleteItem[] | null {
  const matches = fuzzyFilter(items, query, (item) => item.label);
  return matches.length > 0 ? matches : null;
}

function snapshotContext(ctx: ExtensionContext, owner: McpRuntimeOwner | null): ExtensionContext {
  const trusted = ctx.isProjectTrusted();
  // A stopped runtime has nothing left to fence: its UI calls must not become undefined, or a
  // failed session could not even report why it failed.
  const live = owner?.isActive() === true ? owner : null;
  return {
    ...ctx,
    ui: live !== null && ctx.hasUI ? createOwnedUi(ctx.ui, live) : ctx.ui,
    signal: live?.signal ?? ctx.signal,
    isProjectTrusted: () => trusted,
  };
}

function configuredHost(definition: ServerEntry): string | undefined {
  try {
    const url = resolveServerUrl(definition);
    if (url === undefined) {
      return undefined;
    }
    const { host } = new URL(url);
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

export class McpHostCommands {
  private readonly pi: ExtensionAPI;
  private readonly host: McpAdapterHost;
  constructor(pi: ExtensionAPI, host: McpAdapterHost) {
    this.pi = pi;
    this.host = host;
  }

  register(): void {
    this.pi.registerCommand("mcp", {
      description: "Show MCP server status",
      getArgumentCompletions: (prefix) => this.complete(prefix),
      handler: (args, ctx) => this.execute(args, ctx),
    });
    this.pi.registerCommand("mcp-auth", {
      description: "Authenticate with an MCP server (OAuth)",
      getArgumentCompletions: (prefix) => this.completeAuth(prefix),
      handler: (args, ctx) => this.authenticate(args, ctx),
    });
  }

  private complete(prefix: string): AutocompleteItem[] | null {
    const normalized = prefix.trimStart();
    const match = normalized.match(/^(\S+)\s+(.*)$/);
    if (!match) {
      return fuzzyCompletions(MCP_SUBCOMMANDS, normalized);
    }
    const [, subcommand, query] = match;
    const state = this.host.state;
    if (
      !state ||
      subcommand === undefined ||
      query === undefined ||
      !SERVER_COMPLETION_SUBCOMMANDS.has(subcommand)
    ) {
      return null;
    }
    const servers = Object.entries(state.config.mcpServers)
      .filter(([, definition]) => {
        if (subcommand === "reconnect" || subcommand === "tools") {
          return !isServerDisabled(definition);
        }
        if (subcommand === "logout") {
          return hasServerUrl(definition);
        }
        return true;
      })
      .map(([name]) => ({ value: `${subcommand} ${name}`, label: name }));
    return fuzzyCompletions(servers, query.trimStart());
  }

  private completeAuth(prefix: string): AutocompleteItem[] | null {
    const state = this.host.state;
    if (!state) {
      return null;
    }
    const servers: AutocompleteItem[] = [];
    for (const [name, definition] of Object.entries(state.config.mcpServers)) {
      if (authEligibility(definition) !== "eligible") {
        continue;
      }
      const host = configuredHost(definition);
      servers.push({
        value: name,
        label: name,
        ...(host === undefined ? {} : { description: host }),
      });
    }
    return fuzzyCompletions(servers, prefix.trimStart());
  }

  private async execute(args: string, original: ExtensionCommandContext): Promise<void> {
    const owner = this.host.owner;
    const ctx = snapshotContext(original, owner);
    await this.host.syncWorkingDirectory(ctx);
    const activeOwner = this.host.owner;
    const state = await this.host.ensureCommandState(activeOwner, ctx);
    if (!state) {
      return;
    }
    const trimmed = args.trim();
    const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    const subcommand = parts[0] ?? "";
    const command: Command = {
      state,
      ctx,
      original,
      owner: activeOwner,
      target: parts[1],
      rest: parts.slice(1).join(" "),
    };
    switch (subcommand) {
      case "":
        await this.status(command);
        break;
      case "status":
        await commands.showStatus(state, ctx);
        break;
      case "reconnect":
        owner?.throwIfInactive();
        await commands.reconnectServers(state, ctx, command.target);
        if (this.host.directToolsFrozen) {
          this.host.syncToolSurface();
        }
        break;
      case "tools":
        await commands.showTools(state, ctx, command.target);
        break;
      case "prompts":
        await commands.showPrompts(state, ctx);
        break;
      case "setup":
        await this.setup(command);
        break;
      case "logout":
        await this.logout(command);
        break;
      case "disable":
      case "enable":
        await this.setDisabled(command, subcommand === "disable");
        break;
      case "reload":
        await this.reload(command);
        break;
      case "doctor":
        await commands.showDoctor(
          state,
          ctx,
          {
            configOverridePath: this.host.configPath,
            discoveryOptions: nativePiConfigOptions(this.pi),
          },
          command.target,
        );
        break;
      default:
        this.notify(ctx, formatMcpUsage(subcommand), "warning");
        break;
    }
  }

  private async setup({ state, ctx, owner, original }: Command): Promise<void> {
    owner?.throwIfInactive();
    if (!ctx.hasUI) {
      return;
    }
    if (this.host.programmaticConfig) {
      this.notify(
        ctx,
        "MCP setup is unavailable when config is supplied by createMcpAdapter().",
        "info",
      );
      return;
    }
    const result = await commands.openMcpSetup({
      state,
      pi: this.pi,
      ctx,
      configOverridePath: this.host.configPath,
      mode: "setup",
    });
    if (result.configChanged) {
      owner?.throwIfInactive();
      await original.reload();
    }
  }

  private async logout({ state, ctx, owner, rest }: Command): Promise<void> {
    if (rest.length === 0) {
      this.notify(ctx, "Usage: /mcp logout <server>", "error");
      return;
    }
    owner?.throwIfInactive();
    await commands.logoutServer(rest, state, ctx);
  }

  private notify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    }
  }

  private disabledOverrideTarget():
    | string
    | { readonly path?: string | undefined; readonly includeNativePi?: boolean }
    | undefined {
    return isBuiltinMcpActive(this.pi)
      ? { path: this.host.configPath, includeNativePi: false }
      : this.host.configPath;
  }

  private async setDisabled(
    { state, ctx, owner, rest }: Command,
    disabled: boolean,
  ): Promise<void> {
    const subcommand = disabled ? "disable" : "enable";
    if (!ctx.isProjectTrusted()) {
      this.notify(
        ctx,
        "Project MCP changes are unavailable until this project is trusted.",
        "warning",
      );
      return;
    }
    if (this.host.programmaticConfig) {
      this.notify(
        ctx,
        `/mcp ${subcommand} is unavailable when config is supplied by createMcpAdapter().`,
        "info",
      );
      return;
    }
    if (rest.length === 0) {
      this.notify(ctx, `Usage: /mcp ${subcommand} <server>`, "error");
      return;
    }
    if (!state.config.mcpServers[rest]) {
      this.notify(ctx, `Server "${rest}" not found in effective config`, "error");
      return;
    }
    owner?.throwIfInactive();
    const result = writeProjectServerDisabledOverride(
      this.disabledOverrideTarget(),
      ctx.cwd,
      rest,
      disabled,
    );
    const live = await this.host.setServerDisabled(rest, disabled, ctx);
    owner?.throwIfInactive();
    this.notifyDisabledOutcome(ctx, { server: rest, disabled, persisted: result, live });
  }

  private notifyEnabledOutcome(
    ctx: ExtensionContext,
    server: string,
    persistedPath: string,
    live: { outcome?: string; toolCount?: number; errorMessage?: string },
  ): void {
    if (live.outcome === "connected") {
      const count = live.toolCount ?? 0;
      this.notify(
        ctx,
        `Enabled server "${server}" (${count} tool${count === 1 ? "" : "s"} registered)`,
        "info",
      );
      return;
    }
    if (live.outcome === "needs-auth") {
      this.notify(
        ctx,
        `Enabled server "${server}" (run /mcp-auth ${server} to sign in)`,
        "warning",
      );
      return;
    }
    if (live.outcome === "failed") {
      const reason = live.errorMessage ?? "unknown error";
      this.notify(ctx, `Enabled server "${server}", but connection failed: ${reason}`, "warning");
      return;
    }
    this.notify(ctx, `Enabled server "${server}" in ${persistedPath}`, "info");
  }

  private notifyDisabledOutcome(
    ctx: ExtensionContext,
    input: {
      server: string;
      disabled: boolean;
      persisted: { path: string; changed: boolean };
      live: { applied: boolean; outcome?: string; toolCount?: number; errorMessage?: string };
    },
  ): void {
    const { server, disabled, persisted, live } = input;
    if (!persisted.changed && !live.applied) {
      const stateWord = disabled ? "disabled" : "enabled";
      this.notify(ctx, `Server "${server}" is already ${stateWord}`, "info");
      return;
    }
    if (disabled) {
      const note = live.applied ? "disconnected and tools unloaded" : `saved to ${persisted.path}`;
      this.notify(ctx, `Disabled server "${server}" (${note})`, "info");
      return;
    }
    this.notifyEnabledOutcome(ctx, server, persisted.path, live);
  }

  private async reload({ ctx, owner, original }: Command): Promise<void> {
    owner?.throwIfInactive();
    if (typeof original.reload === "function") {
      await original.reload();
      return;
    }
    this.notify(ctx, "MCP reload is unavailable in this host context.", "warning");
  }

  private async status({ state, ctx, owner, original }: Command): Promise<void> {
    if (!ctx.hasUI) {
      await commands.showStatus(state, ctx);
      return;
    }
    owner?.throwIfInactive();
    if (this.host.programmaticConfig) {
      ctx.ui.notify(
        "MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.",
        "info",
      );
      await commands.showStatus(state, ctx);
      return;
    }
    const result = await commands.openMcpPanel({
      state,
      pi: this.pi,
      ctx,
      configOverridePath: this.host.configPath,
      onDirectToolsConfigChanged: (changes) => {
        this.host.applyDirectToolConfigChanges(changes);
        this.host.syncToolSurface();
      },
    });
    if (result.configChanged) {
      owner?.throwIfInactive();
      await original.reload();
    }
  }

  private async authenticate(args: string, original: ExtensionCommandContext): Promise<void> {
    const owner = this.host.owner;
    const ctx = snapshotContext(original, owner);
    const serverName = args.trim();
    if (serverName.length === 0 && !ctx.hasUI) {
      return;
    }
    await this.host.syncWorkingDirectory(ctx);
    const activeOwner = this.host.owner;
    const state = await this.host.ensureCommandState(activeOwner, ctx);
    if (!state) {
      return;
    }
    if (serverName.length === 0) {
      if (this.host.programmaticConfig) {
        ctx.ui.notify(
          "Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.",
          "info",
        );
        return;
      }
      const authPanelOptions = nativePiConfigOptions(this.pi);
      if (authPanelOptions) {
        await commands.openMcpAuthPanel(state, ctx, this.host.configPath, authPanelOptions);
      } else {
        await commands.openMcpAuthPanel(state, ctx, this.host.configPath);
      }
      return;
    }
    const result = await commands.authenticateServer({
      serverName,
      config: state.config,
      ctx,
      signal: ctx.signal,
      runtime: state.oauthRuntime,
    });
    if (result.ok) {
      activeOwner?.throwIfInactive();
      await commands.reconnectServer(state, ctx, serverName, true);
    }
  }
}
