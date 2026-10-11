# Fitch MCP Adapter

Use MCP servers from [Pi](https://github.com/earendil-works/pi) to work with browsers, databases, and APIs. Pi discovers the tools it needs as you go, so you don’t have to load a server’s whole catalog into the conversation.

![A task in Pi reaches the adapter, which discovers tools and calls local or remote MCP servers. Results return to Pi, with large text saved for readback.](.github/readme/mcp-flow.png)

Pi discovers tools before calling them. Large text results come back with a preview and a file you can read.

## Start here

You’ll need Pi 1.0.0 or later and Node.js 24 or later.

```bash
pi install npm:@fitchmultz/pi-mcp-adapter
pi
```

Restart Pi if it was running during installation. Enter `/mcp` to see your servers, or `/mcp setup` to add one.

For a Git install, use `pi install git:github.com/fitchmultz/pi-mcp-adapter`. If you’re upgrading an older installation, [read the upgrade guide](docs/migration.md) before restarting. Keep only one adapter loaded.

## Try it with Chrome DevTools

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

Run `/reload` if you added the file during a session. Then ask Pi:

> Use Chrome DevTools to take a screenshot of the current page.

You’ll see Pi search for a matching tool before calling it. Servers connect on first use by default. Once their catalogs are cached, Pi can search them without a connection.

If you already have `.mcp.json` or `~/.config/mcp/mcp.json`, the adapter reads it automatically. For configs from Cursor, Claude Code, Codex, and other hosts, use `/mcp setup` to choose imports. You can preview the changes before saving; the external host files stay untouched. [Config paths and precedence](docs/reference.md#quick-start) explains how overrides work.

## Day to day

| Command | What it does |
| --- | --- |
| `/mcp` | Show servers and pin tools you use often |
| `/mcp setup` | Add servers or import existing configs |
| `/mcp status` | Show connection state and tool/resource counts |
| `/mcp reconnect <server>` | Reconnect and refresh its catalog |
| `/mcp-auth <server>` | Sign in to an OAuth server in an interactive session |
| `/mcp disable <server>` | Disable it for this project; run `/reload` afterward |
| `/mcp enable <server>` | Enable it again; run `/reload` afterward |

Pin a tool if you want it ready at startup. For everything else, let Pi discover it when needed. A global search only covers known catalogs, so choose a server when you want to discover one that hasn’t been used yet. [More about discovery and pins](docs/reference.md#typed-discovery-and-pinned-tools).

## What else can servers do?

Servers can offer documents and data as [resources](docs/reference.md#mcp-resources). They can also provide [prompt templates](docs/reference.md#mcp-prompts), available as `/mcp__<server>__<prompt>` commands.

[MCP Apps](docs/reference.md#mcp-ui-integration) can open charts and other interactive UIs in your browser. On macOS, they can use a native window if [Glimpse](https://github.com/hazat/glimpse) is available. An App can send messages back to Pi. The [interactive visualizer example](examples/interactive-visualizer/README.md) is a small server you can try locally.

For work that takes several calls, `mcp_script` lets Pi use JavaScript to loop over results or pass one result into the next call. The [scripting guide](docs/reference.md#mcp-scripting) covers its API. You’ll see `mcp_search` discover tools and load `mcp` or `mcp_script` when needed; [gateway examples](docs/reference.md#usage) show the exact calls.

## Before you connect a server

Check its commands and account access before trusting a project’s MCP config. Project files and project-local imports are used only after Pi trusts the project. Use [`approveTools`](docs/reference.md#tool-approval) if a call should require confirmation. Matching calls can’t run in a headless session without approval.

OAuth credentials go into the OS credential store. On headless Linux, you’ll need an unlocked Secret Service-compatible keyring. There’s no plaintext fallback. The [OAuth guide](OAUTH.md) covers local and remote sign-in.

Android/Termux supports unauthenticated, header-token, and stdio servers, but persistent OAuth is unsupported out of the box. Git/source builds also need an Android-native `tsgo` compiler on `PATH`. The npm package is precompiled, so it doesn’t need a compiler at runtime. [Android build details](docs/development.md#androidtermux-source-builds).

Text results over the default 50 KiB or 2,000-line limit are saved to a local file, with a preview in Pi. Those files and App message histories can contain sensitive data and aren’t deleted automatically. [Output handling and readback](docs/reference.md#output-guard) explains where they go.

If saving App history fails, retrieve the pending messages before reloading or exiting Pi. Unsaved messages survive only in the current instance’s memory. [App history and recovery](docs/reference.md#mcp-ui-integration) has the details.

## More docs

- [Configuration and API reference](docs/reference.md): settings, lifecycle modes, SDK integration, transport behavior, and all tool actions.
- [Upgrade guide](docs/migration.md): API changes and pre-v5 state migration.
- [OAuth guide](OAUTH.md): browser, headless, machine, and enterprise authentication.
- [Development and releases](docs/development.md): local checks and maintainer procedures.
- [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/fitchmultz/pi-mcp-adapter/issues)

## License and background

Fitch MCP Adapter is maintained by Mitch Fultz and licensed under [MIT](LICENSE). Mario Zechner’s [“What if you don’t need MCP?”](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) discusses the tool-schema context costs this adapter addresses.

[Watch the adapter demo](https://github.com/user-attachments/assets/4b7c66ff-e27e-4639-b195-22c3db406a5a).
