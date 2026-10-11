# Fitch MCP Adapter

Connect [Pi](https://github.com/earendil-works/pi) to MCP servers for browsers, databases, and APIs. The adapter loads tool schemas as you need them, so a large server catalog does not fill your conversation context at startup.

![Pi asks the adapter to discover tools, the adapter calls local or remote MCP servers, and results return to Pi with large text saved for readback.](.github/readme/mcp-flow.png)

*Discover the tools for a task, call the selected server, and bring the result back to Pi.*

## Start here

Requires **Pi 1.0.0+** and **Node.js 24+**.

```bash
pi install npm:@fitchmultz/pi-mcp-adapter
pi
```

If Pi is already running, restart it after installation. Then enter `/mcp` to see your servers, or `/mcp setup` to add one. You can also [install from Git](https://github.com/fitchmultz/pi-mcp-adapter) with `pi install git:github.com/fitchmultz/pi-mcp-adapter`.

**Replacing an older adapter?** Keep only one adapter loaded. [Read the upgrade guide](docs/migration.md) before restarting, especially if you have state from a pre-v5 installation.

## Try a browser task

Create `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

Run `/reload` if you added the file during a session, then ask Pi:

> Use Chrome DevTools to take a screenshot of the current page.

Pi discovers the matching tools, loads their argument schemas, and calls the selected tool. Discovery itself does not execute a tool. Servers connect on first use by default; cached catalogs can be searched while disconnected.

Already have `.mcp.json` or `~/.config/mcp/mcp.json`? The adapter reads those shared files automatically. For Cursor, Claude Code, Codex, and other host-specific files, `/mcp setup` lets you choose imports and preview changes before saving. It never edits the external host files. [See config paths and precedence](docs/reference.md#quick-start).

## Everyday controls

| Command | Use it to… |
| --- | --- |
| `/mcp` | Inspect servers and pin frequently used tools |
| `/mcp setup` | Add servers, adopt imports, or inspect config files |
| `/mcp status` | See connection state and tool/resource counts |
| `/mcp reconnect <server>` | Reconnect and refresh a server’s catalog |
| `/mcp-auth <server>` | Sign in to an OAuth server in an interactive session |
| `/mcp disable <server>` | Disable a server for this project; run `/reload` afterward |
| `/mcp enable <server>` | Enable it again; run `/reload` afterward |

Pins make tools available at startup. Leave a large catalog unpinned and let Pi discover the tools relevant to each task. Global search reports undiscovered servers; selecting a server discovers its catalog. [Learn about discovery and pins](docs/reference.md#typed-discovery-and-pinned-tools).

## Beyond tool calls

- **Resources:** list a server’s documents or data and read them by URI.
- **Prompts:** use server-provided templates as `/mcp__<server>__<prompt>` slash commands.
- **Interactive Apps:** open server-provided charts and other UIs in a browser, or in a native macOS window with [Glimpse](https://github.com/hazat/glimpse). Apps can send messages back to Pi. [Try the interactive visualizer](examples/interactive-visualizer/README.md).
- **Multi-call scripts:** use `mcp_script` for JavaScript loops, filtering, and chains of MCP calls. [Read the scripting guide](docs/reference.md#mcp-scripting).

The agent uses `mcp_search` to discover typed tools. It can also load `mcp` for explicit gateway actions or `mcp_script` for composition:

```js
mcp_search({ query: "take screenshot", server: "chrome-devtools" })
mcp_search({ enable: ["gateway", "script"] })
```

Enabling gateway or script alone does not connect to a server or perform an action. [The reference](docs/reference.md#usage) has exact call shapes, paging, resources, and saved-result readback.

## Safety and platform notes

- **Trust your server configuration.** Project files and project-local imports are used only after Pi trusts the project. MCP servers can run local programs or access remote accounts.
- **Require confirmation for sensitive calls.** Set `approveTools` globally or per server. Matching calls require approval and fail closed in headless sessions. [Approval options](docs/reference.md#tool-approval).
- **OAuth needs secure storage.** Credentials live in the OS credential store. Headless Linux needs an unlocked Secret Service-compatible keyring; there is no plaintext fallback. [OAuth setup and remote sign-in](OAUTH.md).
- **Android/Termux:** unauthenticated, header-token, and stdio servers work; persistent OAuth is unsupported out of the box. Git/source builds need an Android-native `tsgo` compiler on `PATH`; published precompiled packages do not. [Build details](docs/development.md#androidtermux-source-builds).
- **Large output is saved locally.** Text above the default 50 KiB or 2,000-line limit gets a preview and a file for readback. Saved output and App histories may contain sensitive data and are not removed automatically. If App history storage fails, retrieve pending messages before reload or exit: unsaved events are then lost. [Output handling](docs/reference.md#output-guard) · [App history](docs/reference.md#mcp-ui-integration).
- **Sharing and sampling have limits.** Pi sessions start separate stdio processes unless you configure an external [rmcp-mux service](docs/reference.md#shared-mcp-processes-with-rmcp-mux). MCP sampling is text-only. Inline images remain subject to Pi’s image display settings.

## Guides

- [Configuration and API reference](docs/reference.md) — all settings, lifecycle modes, tool actions, SDK integration, transport behavior, and troubleshooting details.
- [Upgrade guide](docs/migration.md) — v5 API changes and explicit v4 state/credential migration.
- [OAuth guide](OAUTH.md) — browser, remote/headless, machine, and enterprise authentication.
- [Development and releases](docs/development.md) — local checks, Pi compatibility qualification, and maintainer release procedures.
- [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/fitchmultz/pi-mcp-adapter/issues)

## License and background

Fitch MCP Adapter is maintained by Mitch Fultz and licensed under [MIT](LICENSE). For background on tool-schema context costs, read Mario Zechner’s [“What if you don’t need MCP?”](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).

[Watch the adapter demo](https://github.com/user-attachments/assets/4b7c66ff-e27e-4639-b195-22c3db406a5a).
