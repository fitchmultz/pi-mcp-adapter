import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { McpAdapterHost } from "./host-contract.ts";
import { createOwnedUi, type McpRuntimeOwner } from "./runtime-owner.ts";
import { writeProjectServerDisabledOverride } from "./config.ts";

type Command = {
  state: McpExtensionState;
  ctx: ExtensionContext;
  original: ExtensionCommandContext;
  owner: McpRuntimeOwner | null;
  rest: string;
  target: string | undefined;
};

function snapshotContext(ctx: ExtensionContext, owner: McpRuntimeOwner | null): ExtensionContext {
  const trusted = ctx.isProjectTrusted();
  return {
    ...ctx,
    ui: owner && ctx.hasUI ? createOwnedUi(ctx.ui, owner) : ctx.ui,
    signal: owner?.signal ?? ctx.signal,
    isProjectTrusted: () => trusted,
  };
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
      handler: (args, ctx) => this.authenticate(args, ctx),
    });
  }

  private complete(prefix: string) {
    const normalized = prefix.trimStart();
    const match = normalized.match(/^(\S+)\s+(.*)$/);
    if (!match) {
      const commands = [
        { value: "reconnect", label: "reconnect — Reconnect servers" },
        { value: "tools", label: "tools — List all tools" },
        { value: "prompts", label: "prompts — List all MCP prompts" },
        { value: "setup", label: "setup — Configure MCP servers" },
        { value: "logout", label: "logout — Clear server credentials" },
        { value: "disable", label: "disable — Disable a server" },
        { value: "enable", label: "enable — Enable a server" },
        { value: "status", label: "status — Show server status" },
      ].filter(({ value }) => value.startsWith(normalized));
      return commands.length > 0 ? commands : null;
    }
    const [, subcommand, argumentPrefix] = match;
    if (
      !this.host.state ||
      argumentPrefix === undefined ||
      !["reconnect", "logout", "disable", "enable"].includes(subcommand ?? "")
    ) {
      return null;
    }
    const servers = Object.keys(this.host.state.config.mcpServers)
      .filter((name) => name.startsWith(argumentPrefix.trimStart()))
      .map((name) => ({ value: `${subcommand ?? ""} ${name}`, label: name }));
    return servers.length > 0 ? servers : null;
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
    const commands = await import("./commands.ts");
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
    if (this.host.programmaticConfig) {
      ctx.ui.notify(
        "MCP setup is unavailable when config is supplied by createMcpAdapter().",
        "info",
      );
      return;
    }
    const { openMcpSetup } = await import("./commands.ts");
    const result = await openMcpSetup({
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
      if (ctx.hasUI) {
        ctx.ui.notify("Usage: /mcp logout <server>", "error");
      }
      return;
    }
    owner?.throwIfInactive();
    const { logoutServer } = await import("./commands.ts");
    await logoutServer(rest, state, ctx);
  }

  private setDisabled({ state, ctx, owner, rest }: Command, disabled: boolean): void {
    const subcommand = disabled ? "disable" : "enable";
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify(
        "Project MCP changes are unavailable until this project is trusted.",
        "warning",
      );
      return;
    }
    if (this.host.programmaticConfig) {
      ctx.ui.notify(
        `/mcp ${subcommand} is unavailable when config is supplied by createMcpAdapter().`,
        "info",
      );
      return;
    }
    if (rest.length === 0) {
      ctx.ui.notify(`Usage: /mcp ${subcommand} <server>`, "error");
      return;
    }
    if (!state.config.mcpServers[rest]) {
      ctx.ui.notify(`Server "${rest}" not found in effective config`, "error");
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
    ctx.ui.notify(message, "info");
  }

  private async status({ state, ctx, owner, original }: Command): Promise<void> {
    const { showStatus, openMcpPanel } = await import("./commands.ts");
    if (!ctx.hasUI) {
      await showStatus(state, ctx);
      return;
    }
    owner?.throwIfInactive();
    if (this.host.programmaticConfig) {
      ctx.ui.notify(
        "MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.",
        "info",
      );
      await showStatus(state, ctx);
      return;
    }
    const result = await openMcpPanel({
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
    const { authenticateServer, openMcpAuthPanel, reconnectServer } = await import("./commands.ts");
    if (serverName.length === 0) {
      if (this.host.programmaticConfig) {
        ctx.ui.notify(
          "Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.",
          "info",
        );
        return;
      }
      await openMcpAuthPanel(state, ctx, this.host.configPath);
      return;
    }
    const result = await authenticateServer({
      serverName,
      config: state.config,
      ctx,
      signal: ctx.signal,
      runtime: state.oauthRuntime,
    });
    if (result.ok) {
      owner?.throwIfInactive();
      await reconnectServer(state, ctx, serverName, true);
    }
  }
}
