import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { McpExtensionState } from "./state.ts";
import type { McpAdapterHost } from "./host-contract.ts";
import * as commands from "./commands.ts";
import { createOwnedUi, type McpRuntimeOwner } from "./runtime-owner.ts";
import { writeProjectServerDisabledOverride } from "./config.ts";
import { supportsOAuth } from "./mcp-oauth-runtime.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import { hasServerUrl, resolveServerUrl } from "./utils.ts";

const MCP_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "reconnect", label: "reconnect", description: "Reconnect servers" },
  { value: "tools", label: "tools", description: "List all tools" },
  { value: "prompts", label: "prompts", description: "List all MCP prompts" },
  { value: "setup", label: "setup", description: "Configure MCP servers" },
  { value: "logout", label: "logout", description: "Clear server credentials" },
  { value: "disable", label: "disable", description: "Disable a server" },
  { value: "enable", label: "enable", description: "Enable a server" },
  { value: "status", label: "status", description: "Show server status" },
];

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

function authStatusLabel(state: McpExtensionState, name: string): string {
  const status = state.manager.getConnection(name)?.status;
  if (status === "needs-auth") {
    return "needs auth";
  }
  if (status === "connected") {
    return "connected";
  }
  return "OAuth";
}

function describeAuthServer(
  state: McpExtensionState,
  name: string,
  definition: ServerEntry,
): string {
  const label = authStatusLabel(state, name);
  const host = configuredHost(definition);
  if (host !== undefined) {
    return `${label} — ${host}`;
  }
  return label === "OAuth" ? "OAuth" : `OAuth (${label})`;
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
      !["reconnect", "logout", "disable", "enable"].includes(subcommand)
    ) {
      return null;
    }
    const servers = Object.entries(state.config.mcpServers)
      .filter(([, definition]) => {
        if (subcommand === "reconnect") {
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
      if (isServerDisabled(definition) || !supportsOAuth(definition)) {
        continue;
      }
      servers.push({
        value: name,
        label: name,
        description: describeAuthServer(state, name, definition),
      });
    }
    return fuzzyCompletions(servers, prefix.trimStart());
  }

  private async execute(args: string, original: ExtensionCommandContext): Promise<void> {
    const owner = this.host.owner;
    const ctx = snapshotContext(original, owner);
    const state = await this.host.ensureCommandState(owner, ctx);
    if (!state) {
      return;
    }
    const parts = args.trim().split(/\s+/);
    const command: Command = {
      state,
      ctx,
      original,
      owner,
      target: parts[1],
      rest: parts.slice(1).join(" "),
    };
    switch (parts[0] ?? "") {
      case "reconnect":
        owner?.throwIfInactive();
        await commands.reconnectServers(state, ctx, command.target);
        if (this.host.directToolsFrozen) {
          this.host.syncToolSurface();
        }
        break;
      case "tools":
        await commands.showTools(state, ctx);
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
        this.setDisabled(command, parts[0] === "disable");
        break;
      default:
        await this.status(command);
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

  private setDisabled({ state, ctx, owner, rest }: Command, disabled: boolean): void {
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
      this.host.configPath,
      ctx.cwd,
      rest,
      disabled,
    );
    const message = result.changed
      ? `${disabled ? "Disabled" : "Enabled"} server "${rest}" in ${result.path} — run /reload to apply`
      : `Server "${rest}" is already ${disabled ? "disabled" : "enabled"}`;
    this.notify(ctx, message, "info");
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
    const state = await this.host.ensureCommandState(owner, ctx);
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
      await commands.openMcpAuthPanel(state, ctx, this.host.configPath);
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
      owner?.throwIfInactive();
      await commands.reconnectServer(state, ctx, serverName, true);
    }
  }
}
