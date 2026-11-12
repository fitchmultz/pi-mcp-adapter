# MCP adapter reference

For installation and a first task, start with the [README](../README.md). This guide keeps the complete configuration, tool API, and integration details in one place.

- [First run](#what-happens-on-first-run) and [quick start](#quick-start)
- [Config files](#file-layout), [server options](#server-options), and [settings](#settings)
- [SDK configuration](#sdk-configuration), [call capture](#execution-checkpoints-and-call-capture), and [runtime status](#runtime-status-snapshots)
- [Transport behavior and retry safety](#transport-compatibility)
- [Approvals](#tool-approval), [output/readback](#output-guard), and [multi-call work](#multi-call-work)
- [Typed discovery and pins](#typed-discovery-and-pinned-tools), [resources](#mcp-resources), [prompts](#mcp-prompts), and [Apps](#mcp-ui-integration)
- [Gateway actions](#usage), [slash commands](#commands), and [limits](#limitations)

## Requirements

Use Pi 1.5.0 or later and Node.js 24 or later.

Cache, config and onboarding writes and persistent OAuth credential operations use Node's built-in [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) module for cross-process locking. This module is experimental in Node 24 and may emit an experimental warning on first use. These operations require it to be enabled, without `--no-experimental-sqlite`.

Credential readers share locks with other readers; writers exclude readers and other writers. Conflicting lock acquisition fails immediately. A busy cache logs a not-saved warning without aborting server startup or binary resolution. Pending metadata stays with the adapter state for the next normal save opportunity. Other cache I/O errors still propagate. Credential operations fail closed with a busy-storage message.

Config and onboarding writers hold a lock across the fresh read, update and write. A busy writer fails before changing the file; retry after the other writer finishes. Their persistent sidecar is `<file-path>.lock.sqlite`, including for CLI and standalone example config writes. Scaffolding a project config never replaces an existing `.mcp.json`.

Lock databases remain on disk. Do not remove or replace them while an adapter process may use them.

Lock databases require a filesystem with working [SQLite locks](https://www.sqlite.org/lockingv3.html). They use SQLite's default rollback-journal mode, where an exclusive transaction excludes readers. Do not change them to WAL mode, which permits readers during a write transaction. Network filesystems may not provide reliable locking.

## What happens on first run

The adapter reads standard MCP files automatically. No extra setup needed if you already have them.

| You already have...                                                                | What happens                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.mcp.json` or `~/.config/mcp/mcp.json`                                            | Pi uses it immediately. The first time you open `/mcp`, you'll see a short heads-up explaining which file Pi detected and that Pi only writes adapter-specific overrides to its own files. |
| Host-specific configs (Cursor, Claude Code, Codex, etc.) but no standard MCP files | Run `/mcp setup` to adopt those host configs into Pi. The setup flow shows exactly what it found, lets you pick which ones to import, and previews the exact file changes before writing.  |
| Nothing configured yet                                                             | Run `/mcp setup` to scaffold a minimal `.mcp.json`, add a curated known server, quick-add RepoPrompt, or inspect what the adapter discovered on your machine.                              |

If you prefer the terminal, run `fitch-mcp-adapter init` after install to scan for host-specific configs and add missing compatibility imports to `~/.pi/agent/fitch-mcp-adapter/mcp.json` (or `$PI_CODING_AGENT_DIR/fitch-mcp-adapter/mcp.json` when set).

## Quick Start

Preferred project config: `.mcp.json`

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp"]
    }
  }
}
```

Preferred user-global shared config: `~/.config/mcp/mcp.json`. Pi also reads the tool-agnostic global paths `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`.

Pi also reads Pi-owned override files for settings and host-specific compatibility:

- `<Pi agent dir>/fitch-mcp-adapter/mcp.json` — adapter global override (`~/.pi/agent/fitch-mcp-adapter/mcp.json` by default)
- `.pi/fitch-mcp-adapter/mcp.json` — adapter project override

Host-specific configs are detected and shown by `/mcp setup` and `fitch-mcp-adapter init`, but they are not loaded automatically. To explicitly opt in to host-config fallback discovery, set `settings.hostConfigDiscovery` to `"on"` or run `fitch-mcp-adapter init --discover-host-configs`. The default is `"off"`. Host configs are lower precedence than every shared and Pi-owned source, and `/mcp setup` continues to offer explicit import adoption. Discovery reports source paths, provenance, and same-name conflicts; it never writes to external host files or silently launches commands from them.

Precedence is:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<Pi agent dir>/fitch-mcp-adapter/mcp.json`
5. `.mcp.json`
6. `.pi/fitch-mcp-adapter/mcp.json`

If a higher-precedence config changes a stdio server's `command`, `args`, or `cwd`, it must explicitly supply any `env` values that the new process needs; the previous definition's `env` is not inherited. An OpenCode `environment` override also replaces the previous map rather than merging its keys.

Project layers and project-local host imports are read only after Pi marks the project trusted. Until then, the adapter uses global configuration only, does not start project-defined servers, and blocks project configuration panels and writes.

`/mcp disable <server>` and `/mcp enable <server>` persist only the `disabled` field in the project-local `.pi/fitch-mcp-adapter/mcp.json`, which is the highest-precedence Pi layer. Enabling removes the project flag when lower layers are enabled, or writes `false` when needed to override a disabled lower source. This applies even when the effective server came from a shared global/project file, an imported host config, or `configPath`; the source file is never rewritten and credentials are never copied. Run `/reload` after changing the flag so registered tool surfaces are refreshed. The manual equivalent is to add `{ "disabled": true }` to a server in any normal MCP config. Supplied in-memory `createMcpAdapter({ config })` configurations are isolated and do not read or write this project override; the commands are unavailable in that mode.

Servers are **lazy by default**. Cached tool descriptors register as deferred Pi tools without a live connection. Pi's native `tool_search` loads the tools relevant to a task:

```js
tool_search({ query: "take screenshot" });
```

The loaded tools become available with their full argument schemas on the next model request. The agent then calls the chosen typed tool normally. `codemode` scripts can call any registered catalog tool without loading it first. Pi registers `tool_search` inactive; like Pi's own MCP extension, the adapter activates it when it registers deferred tools. It does so once per session start or tree navigation, so a later deselection lasts, and a branch that recorded removing `tool_search` keeps it off. A host allowlist that omits `tool_search` keeps it off.

The `mcp` gateway is active whenever it is registered. Use it for resources, authentication, UI messages, saved-result readback, fallback calls, and for discovering a server whose catalog is not cached yet:

```js
mcp({ action: "connect", server: "chrome-devtools" });
mcp({ action: "search", query: "take screenshot", server: "chrome-devtools" });
mcp({ action: "describe", tool: "chrome_devtools_take_screenshot" });
mcp({ action: "call", tool: "chrome_devtools_take_screenshot", args: { format: "png" } });
```

Gateway search returns schemas without loading typed tools. All paths preserve the same authentication, approval, and call-capture behavior.

## Config

### File Layout

Use the shared MCP files when you want one setup to work across hosts, and Pi-owned files when you need Pi-specific overrides or settings.

| File                                        | Purpose                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `~/.config/mcp/mcp.json`                    | User-global shared MCP config                     |
| `~/.agents/mcp.json`                        | User-global tool-agnostic MCP config              |
| `~/.agents/mcp/mcp.json`                    | User-global tool-agnostic MCP config              |
| `.mcp.json`                                 | Project-local shared MCP config                   |
| `<Pi agent dir>/fitch-mcp-adapter/mcp.json` | Adapter global override and compatibility imports |
| `.pi/fitch-mcp-adapter/mcp.json`            | Adapter project override                          |

The Pi agent dir defaults to `~/.pi/agent` and honors `PI_CODING_AGENT_DIR`. The owned `fitch-mcp-adapter/` root also contains `mcp-cache.json`, `mcp-onboarding.json`, `mcp-npx-cache.json`, and the `mcp-oauth/` legacy import directory.

For imported or shared global servers, Pi saves only `directTools` selections in its own config, without copying connection details or credentials from the source file.

### SDK configuration

Use `createMcpAdapter` when an SDK or server integration already owns its MCP configuration:

```ts
import { createMcpAdapter } from "@fitchmultz/pi-mcp-adapter";

const extension = createMcpAdapter({
  config: {
    mcpServers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        lifecycle: "eager",
      },
    },
  },
});

// Register `extension` with the host SDK.
```

The package exports compiled ESM and declarations from `dist/`, so a standalone Node process can import it directly.

A supplied `config` is a complete, isolated snapshot. It is not merged with files, imports, global config, project config, or `--mcp-config`, and it is never mutated. Each adapter factory and session receives its own clone, so separate integrations can use different servers and settings safely. In this mode, server status, reconnect, explicit `/mcp-auth <server>`, proxy calls, and direct tools continue to work; setup and no-argument auth/status panels report the limitation instead of discovering or writing ambient config.

With `configPath` and no `config`, the adapter keeps normal file merge behavior, and that path takes precedence over argv and `--mcp-config`. The default export keeps the normal file-based behavior. OAuth credentials are stored in the operating system credential store and keyed by the configured server name; URL binding prevents credentials from being accepted for a different server URL. `settings.oauthDir` selects the parent of a `fitch-mcp-adapter/` legacy plaintext import directory; `FITCH_MCP_OAUTH_DIR` explicitly overrides the final import path. Neither changes the OS credential namespace. CSRF state and PKCE verifiers are flow-local, so concurrent authorization flows do not share transient secrets.

Set `createMcpAdapter({ outputDirectory: "/workspace/internal/mcp-output" })` to keep oversized tool/resource text and raw MCP JSON beneath a host-owned directory. The directory is created on the first spill; each file still uses a random subdirectory/name and mode `0600`. Relative paths resolve from the process working directory when written; prefer an absolute path for hosts that change directories. This runtime option works with either configuration mode and does not change live results, output limits, or cleanup. The host owns retention, access, and any redaction of saved copies; files may contain sensitive data. Omitting it keeps the system temp directory.

### Session configuration

Use `createMcpAdapter({ transformConfig: (config, ctx) => ... })` to add session-specific servers or settings in memory. The synchronous hook runs once per `session_start`, including reloads and new sessions, after normal config merging and project trust checks, before tool/metadata registration and initialization. It receives a fresh config clone and the current `ExtensionContext`; its result is cloned for session ownership. No config files are rewritten. Without an explicit `config`, normal status, setup, disable/enable, and auth panels remain available. With `config`, the hook transforms that isolated snapshot and its panel limitations still apply.

```ts
const extension = createMcpAdapter({
  transformConfig(config, ctx) {
    config.mcpServers.session = {
      command: "my-mcp-server",
      lifecycle: "lazy",
      env: { SESSION_ID: ctx.sessionManager.getSessionId() },
    };
    config.settings = { ...config.settings, autoAuth: false };
    return config;
  },
});
```

Hosts that share a server within a root session can supply their root-session ID in `env` instead. Load this factory instead of also loading the default adapter.

### Execution checkpoints and call capture

`createMcpAdapter({ beforeExecute: async (toolCallId, ctx, operation) => { ... } })` lets a host finish its workspace/native-session checkpoint before the next MCP action. For direct tools and actual `mcp` calls, it runs after target resolution, connection, approval and UI preparation but **before the individual service deadline** and `onToolCall` capture. The callback receives the native Pi call ID and that invocation's `ExtensionContext`, with its caller/owner cancellation signal in `ctx.signal`. Pass it to checkpoint I/O and throw if the checkpoint cannot complete. Rejection prevents that call: direct and gateway execution throws. Existing two-argument callbacks remain supported.

The optional `McpOperationContext` (exported from the package and `/types`) carries the same `server`, `tool`, resolved `args`, optional `annotations`/`resourceUri`, and call ID as the native before event, plus `annotationsTrusted`. Live connection annotations take precedence over frozen direct-tool hints, including when live hints are absent. `annotationsTrusted` reports only the existing server `retryOnTransportFailure: true` opt-in; it is not a new permission or configuration gate. No server configuration, headers, credentials, or SDK clients are exposed. Non-call proxy modes (including status, discovery, connect and auth actions) still invoke the callback without an operation; unresolved or denied tool calls do not dispatch.

A host can skip an expensive before-effect save for a native resource read (`operation.resourceUri`) or for `operation.annotationsTrusted && operation.annotations?.readOnlyHint === true`. Missing/false hints and `idempotentHint: true` alone are not read-only: an idempotent write still changes state. Keep unknown operations conservative and retain original intent/outcome capture. The adapter does not choose the host's save policy.

Supplying `beforeExecute` marks the adapter's tools `executionMode: "sequential"`, so Pi finishes earlier sibling tools before entering this boundary. Omitting it keeps normal scheduling. It does not join detached writers or implement checkpoint storage. The host still owns coherent capture and a final completion checkpoint. These callbacks do not change request timeout defaults.

`createMcpAdapter({ onToolCall: async (event) => { ... } })` supplies one optional, session-scoped callback for `mcp` and direct tool calls. Load this factory instead of also loading the default adapter. The callback is passed directly, so separate Pi/Jiti module instances do not need to share a singleton or event bus.

`McpToolCallEvent` (exported from `@fitchmultz/pi-mcp-adapter/types`) contains `server`, `tool`, the actual resolved `args`, optional SDK `annotations` and `resourceUri`, and a cancellation/deadline `signal`. `toolCallId` is the native Pi call ID. It is correlation only, not a provider idempotency key.

- `phase: "before"`: awaited after approval, before dispatch. Rejection prevents the call.
- `phase: "after"`: contains either the raw `result` (including MCP error results) or the thrown `error`. Awaited before delivering the outcome to Pi. It runs once after native recovery/retry settles, not once per HTTP subrequest. Output spill files are written **after** this callback; they are complete when the tool call resolves, not at the after event.
- Capture failure returns `call_capture_failed` with the original event, excluding `signal`, in `details.recovery`. A completed result stays there; the adapter never repeats it. Cancellation remains `aborted`.

The two callbacks serve different boundaries: `beforeExecute` saves completed workspace writes; `onToolCall` captures the resolved operation and its raw outcome. The host owns `pi.appendEntry()` and the awaited checkpoint of that same native JSONL. Exclude `signal`, serialize thrown errors explicitly, redact sensitive checkpoint bytes, and honor the signal and session/attempt fence. `pi.appendEntry()` alone only persists locally; `pi.events.emit()` is not an awaited barrier. Custom entries do not enter model context automatically: the host must provide truthful recovered results or readback instructions when resuming. The adapter stores no separate transcript or receipts, does not replay calls, and does not invent provider operation keys.

### Runtime shutdown and replacement

Pi owns session replacement and emits `session_shutdown`. The adapter aborts outgoing activity before awaiting cleanup, closes owned connections, health watchers, OAuth callbacks and UI servers, and reports persistence/cleanup failures. Open approval, sampling and elicitation dialogs are bound to the runtime's session signal, so shutdown dismisses them instead of waiting for an answer; the cancelled dialog replies `cancel`. Actual sampling/elicitation and native send/auth tails remain owned through settlement, even when a public request has already been cancelled. Unfinished callbacks prevent idle connection closure; final shutdown joins transport work. Pending `beforeExecute`/`onToolCall` promises prevent a clean-shutdown success claim. No detached work is declared finished merely because the agent settled.

The retired fork `session_checkpoint`/`acquireCheckpoint` APIs are no longer used. Host-supplied `beforeExecute` and raw `onToolCall` capture remain supported; the host still owns durable effect receipts and coherent workspace/session capture. No callback/process-memory recovery or automatic operation replay is promised.

### Runtime status snapshots

Extensions can subscribe to the adapter's versioned shared event-bus channel instead of parsing `/mcp` or `mcp({ action: "status" })` output:

```ts
import { MCP_STATUS_EVENT, type McpStatusSnapshot } from "@fitchmultz/pi-mcp-adapter";

pi.events.on(MCP_STATUS_EVENT, (snapshot) => {
  const status = snapshot as McpStatusSnapshot;
  // status.servers contains connected, cached, failed, needs-auth,
  // not-connected, or disabled entries.
});
```

`MCP_STATUS_EVENT` is `fitch-mcp-adapter/status/v1`. The snapshot is read-only machine-readable data with copied per-server entries. It includes `totalTools`, `totalResources`, `connectedCount`, and `disabledCount`; each server includes `name`, `status`, `toolCount`, and `disabled`, with `resourceCount` when known, `catalogKnown` indicating whether discovery has completed, and `failedAgoSeconds` only for an active failure. An unknown catalog is not a confirmed zero-tool server. Reading status never connects a lazy server, starts authentication, or exposes SDK clients, transports, credentials, or server definitions. An initial snapshot is emitted after initialization, updates are emitted for status and metadata changes, and an empty snapshot is emitted when the session shuts down.

In the configuration examples below, `30000` is illustrative only. If `requestTimeoutMs` is omitted or set to `<= 0`, the MCP SDK default timeout is used.

### Transport compatibility

The adapter uses official split MCP SDK 2.4.0. HTTP connections automatically negotiate protocol `2026-07-28` and fall back to older revisions using the SDK's native rules. The SDK generates protocol metadata, method/name headers, and schema-driven `Mcp-Param-*` headers. Modern HTTP supports streamed POST responses without opening a legacy standalone GET stream. Deprecated SSE is tried only when the Streamable HTTP handshake rejects the endpoint with HTTP 404, 405, 406, or 415—not after a timeout, network failure, or authentication failure.

Native catalog discovery follows changing pages even when their opaque cursor repeats. Catalogs exceeding 1,024 pages fail explicitly instead of publishing a partial list or walking indefinitely; this also bounds automatic catalog refreshes.

For known legacy servers, set `protocolVersion: "legacy"`. This is also the workaround for servers that answer `server/discover` with an HTTP 200 JSON-RPC error whose `id` is `null`: The native SDK cannot negotiate that response. The adapter reports the native failure rather than inventing authentication guidance or overriding the SDK's fallback classifier. Stdio and Unix sockets remain legacy by default. Explicit `"auto"` on native stdio uses the SDK's disposable probe process before starting the session process.

```json
{
  "mcpServers": {
    "modern": { "url": "https://mcp.example.com/mcp" },
    "older": { "url": "https://legacy.example.com/mcp", "protocolVersion": "legacy" },
    "read-only": { "url": "https://reports.example.com/mcp", "retryOnTransportFailure": true }
  }
}
```

`retryOnTransportFailure` is off by default. Enabling it trusts the configured server's explicit `readOnlyHint: true` or `idempotentHint: true` tool annotations for at most one new `callTool` request on the same modern HTTP client. Annotations are retained in live/cached metadata and describe output; the live catalog takes precedence over frozen direct-tool metadata. Eligible failures are a rejected tool POST fetch before response headers arrive, an HTTP 5xx tool response without a JSON-RPC error, or an SSE response body disconnecting before its JSON-RPC response arrives. The first attempt may already have run. Fresh SDK request IDs are not idempotency keys.

Unknown or non-idempotent tools remain callable but are never automatically redispatched after those failures. An unresolved transport failure, interrupted JSON response body, closed connection, or cancellation/deadline while a dispatched tool request awaits its response returns internal `ambiguous_outcome` details with server/tool/call identity and readback instructions. Use the original saved arguments and the provider's supported operation/resource identity to read the prior result, then continue the remaining work; do not blindly repeat a write. Missing annotations are not permission denial. Confirmed pre-dispatch legacy-session and authentication recovery remain available.

A broken SSE body fails only the affected request, even when retries are disabled. Completed responses and later stream notifications remain intact. Native SSE resumption stays SDK-owned: a server-provided event ID lets the SDK resume the existing stream before any adapter retry.

This transport-failure option does not retry OAuth failures, JSON-RPC errors, tool error results, invalid responses, closed connections, cancellation, or expired deadlines. Permission recovery uses the separate existing `autoAuth` gate, not this option. JSON response-body failures, clean SSE endings without a response, and streams that merely stop making progress are not replayed. The original tool deadline covers SDK subrequests and retries, and modern retry never stacks with legacy expired-session recovery. Native header-schema refresh and multi-round-trip input handling remain SDK-owned.

### Server Options

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp"],
      "lifecycle": "lazy",
      "idleTimeout": 10,
      "requestTimeoutMs": 30000
    }
  }
}
```

| Field                                | Description                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                            | Executable for stdio transport; mutually exclusive with `url` and `socket`                                                                                                                                                                                      |
| `args`                               | Command arguments                                                                                                                                                                                                                                               |
| `socket`                             | Explicit `rmcp-mux` Unix-domain socket path; supports `${VAR}`, `$env:VAR`, and `~` expansion and is mutually exclusive with `command` and `url`                                                                                                                |
| `env`                                | Environment variables; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the stdio server connects; use `!!` for a literal leading `!`.                                                                            |
| `cwd`                                | Working directory; supports `${VAR}`, `$env:VAR`, and `~` expansion                                                                                                                                                                                             |
| `protocolVersion`                    | `"auto"` or `"legacy"`. HTTP defaults to `"auto"`; stdio and Unix sockets default to `"legacy"`.                                                                                                                                                                |
| `retryOnTransportFailure`            | Trust explicit read-only/idempotent annotations for one modern transport retry (default: `false`); see [Transport compatibility](#transport-compatibility) before enabling.                                                                                     |
| `url`                                | HTTP endpoint (StreamableHTTP with SSE fallback); supports raw `${VAR}` and `$env:VAR` interpolation, and missing URL variables fail before any request is sent                                                                                                 |
| `headers`                            | HTTP headers; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the HTTP server connects or OAuth authenticates; use `!!` for a literal leading `!`.                                                               |
| `auth`                               | `"bearer"` or `"oauth"`                                                                                                                                                                                                                                         |
| `oauth.grantType`                    | `"authorization_code"` (default) or `"client_credentials"` for non-interactive machine auth                                                                                                                                                                     |
| `oauth.clientId`                     | Pre-registered OAuth client ID; takes priority over stored clients and automatic registration                                                                                                                                                                   |
| `oauth.clientSecret`                 | OAuth client secret for confidential clients; a value beginning with `!` runs a command when OAuth authenticates, while `!!` escapes a literal leading `!`                                                                                                      |
| `oauth.privateKeyJwt`                | Native private-key authentication: `privateKey` (PKCS#8 PEM, JWK object/JSON, environment or `!command` source), `algorithm`, optional `audience`, `lifetimeSeconds`, `claims`; requires a configured client ID or custom metadata document, not `clientSecret` |
| `oauth.crossAppAccess`               | Native enterprise OIDC exchange: `idpUrl`, IdP `clientId`, `idToken`, optional IdP `clientSecret`; all support lazy environment/`!command` sources. Omit `grantType`.                                                                                           |
| `oauth.scope`                        | Requested OAuth scopes                                                                                                                                                                                                                                          |
| `oauth.redirectUri`                  | Exact localhost redirect URI for browser OAuth, including port and path, for providers that pre-register callbacks                                                                                                                                              |
| `oauth.clientName`                   | Client display name advertised during dynamic registration                                                                                                                                                                                                      |
| `oauth.clientUri`                    | Client homepage URI advertised during dynamic registration                                                                                                                                                                                                      |
| `oauth.clientMetadataUrl`            | Custom HTTPS Client ID Metadata Document URL, or `false` to disable automatic CIMD for new registrations; supports environment interpolation                                                                                                                    |
| `oauth.skipIssuerMetadataValidation` | Skip only the authorization-server metadata issuer check for a known incompatible provider (default: `false`). Stored issuer and callback checks remain enforced.                                                                                               |
| `bearerToken` / `bearerTokenEnv`     | Token or env var name; `bearerToken` supports `${VAR}` and `$env:VAR` interpolation. A leading `!` in `bearerToken` runs a command when the HTTP server connects; use `!!` for a literal leading `!`.                                                           |
| `lifecycle`                          | `"lazy"` (default), `"eager"`, `"keep-alive"`, or `"lazy-keep-alive"`                                                                                                                                                                                           |
| `idleTimeout`                        | Minutes before idle disconnect (overrides global)                                                                                                                                                                                                               |
| `requestTimeoutMs`                   | Request timeout in milliseconds for live MCP calls (overrides global; if omitted or `<= 0`, the MCP SDK default timeout is used)                                                                                                                                |
| `exposeResources`                    | Make MCP resources available through resource listing/reading (default: true)                                                                                                                                                                                   |
| `directTools`                        | `true`, `string[]`, or `false` — pin real tools into the initial active tool set                                                                                                                                                                                |
| `toolPrefix`                         | Override global `settings.toolPrefix` for this server (`"server"`, `"short"`, `"none"`, or `"mcp"`)                                                                                                                                                             |
| `includeTools`                       | `string[]` of tool names or glob patterns to expose (matches original names like `get_screenshot`, legacy resource filter aliases like `read_figjam`, and prefixed names like `figma_get_screenshot`)                                                           |
| `excludeTools`                       | `string[]` of tool names or glob patterns to hide (applied after `includeTools`)                                                                                                                                                                                |
| `debug`                              | Show server stderr (default: false)                                                                                                                                                                                                                             |
| `trace`                              | Enable metadata-only JSONL protocol tracing for this server; payloads, prompts, tool arguments/results, authorization data, and URLs are never persisted                                                                                                        |
| `disabled`                           | Keep the server visible in config and status, but prevent connections, authentication, tools, and resource calls (only literal `true` disables it)                                                                                                              |

For pre-registered browser OAuth clients, set `oauth.redirectUri` to the exact callback registered with the provider, for example `"http://localhost:3118/callback"`. Dynamic clients normally omit it and use a lazy OS-assigned localhost callback port.

Secret values in `headers`, `bearerToken`, `oauth.clientSecret`, `oauth.privateKeyJwt.privateKey`, `oauth.crossAppAccess` fields, and stdio `env` may use a leading `!command` to obtain their value at connection or authentication time. The command runs with stdin and stderr suppressed, stdout is limited to 1 MiB and trimmed, and it must finish within 10 seconds with non-empty output; failures stop the connection or authentication flow. Commands are not run during OAuth discovery or while reading, merging, previewing, hashing, or rendering configuration. Use `!!` to escape a literal leading `!`; ordinary and escaped values retain environment interpolation.

### OAuth client registration

Eligible browser clients automatically use the [Fitch MCP Adapter client metadata document](https://fitchmultz.github.io/pi-mcp-adapter/client-metadata.json). The SDK keeps configured `clientId` and usable stored registrations first, then uses the document when the authorization server advertises `client_id_metadata_document_supported: true`. Otherwise it uses dynamic client registration (DCR), if available. An authorization server rejecting or failing to fetch a document does **not** guarantee a fallback to DCR.

The shared public identity covers `/callback` on HTTP `localhost`, `127.0.0.1`, or `[::1]`, with a variable loopback port. Normal callbacks still use an OS-assigned port. A different `clientName`, `clientUri`, callback path or query keeps DCR; explicitly matching identity values remain eligible. Set `oauth.clientMetadataUrl` to your own document URL for a custom identity/callback, or `false` to opt out. Documents cannot use shared secrets; the shared browser identity is never used for `client_credentials`, cross-app or private-key authentication.

Changing this option does not replace a usable stored login. Saved CIMD registrations allow only a loopback-port change during browser auth; host, scheme, path, query and issuer bindings remain enforced. To deliberately register again, use `/mcp logout <server>`. An authorization-server issuer change still requires clearing credentials; it is not silently migrated. See [OAuth configuration](../OAUTH.md#client-registration-order) for details.

### Private-key OAuth

Use `oauth.privateKeyJwt` with an existing registered client ID, or a custom metadata document containing the matching public verification key:

```json
{
  "url": "https://api.example.com/mcp",
  "oauth": {
    "grantType": "client_credentials",
    "clientId": "registered-service-client",
    "privateKeyJwt": {
      "privateKey": "${MCP_PRIVATE_KEY}",
      "algorithm": "ES256"
    }
  }
}
```

The SDK signs a fresh assertion for each token request. Keys are resolved at authentication time, never cached or added to the credential store. PEM strings must be PKCS#8 with an RS/PS/ES algorithm; EdDSA / Ed25519 use a JWK. `!command` may return PEM or JWK JSON. The same hook authenticates browser code and refresh requests when `grantType` is omitted. No keys are generated, registered or hosted for you. See [private-key options and identity rules](../OAUTH.md#private-key-jwt) for details.

### Enterprise cross-app authorization

Use an existing enterprise OIDC ID token to obtain an MCP access token without opening an MCP browser flow:

```json
{
  "url": "https://api.example.com/mcp",
  "auth": "oauth",
  "oauth": {
    "clientId": "registered-mcp-client",
    "clientSecret": "${MCP_CLIENT_SECRET}",
    "crossAppAccess": {
      "idpUrl": "https://idp.example.com",
      "clientId": "registered-idp-client",
      "idToken": "!your-id-token-command",
      "clientSecret": "${IDP_CLIENT_SECRET}"
    }
  }
}
```

The nested credentials belong to the IdP, not the MCP authorization server. Omit `grantType`: this option selects the JWT-bearer grant. The SDK discovers both servers, exchanges the ID token for an ID-JAG (JWT authorization grant), then exchanges that grant for the MCP access token using the outer client identity. Public custom metadata documents and `privateKeyJwt` work instead of the outer shared secret. The shared browser identity is not eligible.

Initial enterprise sign-in, ID-token renewal, IdP client registration and keys remain user-managed. The token source is re-read when a new grant is needed; no IdP tokens, secrets or grants are added to storage. The IdP supports public or `client_secret_post` authentication, not IdP private-key JWT, SAML or a built-in login/refresh flow. Headless proxy/direct tools and manual auth use the same noninteractive path. See [cross-app configuration and limits](../OAUTH.md#enterprise-cross-app-authorization).

### Shared MCP processes with rmcp-mux

To share one stdio MCP server across Pi sessions, run it under [`rmcp-mux`](https://github.com/VetCoders/rmcp-mux) and point each session at the service socket:

```json
{
  "mcpServers": {
    "memory": {
      "socket": "~/.rmcp-servers/rmcp-mux/sockets/memory.sock"
    }
  }
}
```

The adapter owns only its client socket and closes that connection when the Pi runtime stops. `rmcp-mux` owns the server process, request routing, initialization cache, restart policy, client limits, and socket permissions. Start and configure the mux separately; the adapter never discovers, starts, adopts, or stops its daemon. A socket is an explicit trusted local endpoint, so do not point unrelated projects or users at a mux service unless its tools, state, credentials, and filesystem access are intended to be shared.

### Remote/headless OAuth

If Pi is running on a remote server and cannot open a local browser, start OAuth through the proxy tool. Persistent OAuth still requires an available OS credential store; on headless Linux that usually means an unlocked Secret Service/libsecret keyring. The adapter fails closed instead of falling back to plaintext credentials when the secure store is unavailable.

On Linux, if credential access fails because Pi inherited a revoked session keyring, the adapter uses a best-effort recovery path through `keyctl session - node <packaged helper>` so explicit re-authentication can write fresh credentials without killing a long-lived tmux server. This path requires `keyctl` and `node` on `PATH`; missing, locked, or otherwise unavailable credential stores still fail closed.

```js
mcp({ action: "auth-start", server: "linear-server" });
```

Open the returned authorization URL in an authenticated browser. This can be a headless browser that can reach Pi's localhost callback; the adapter does not open a browser for `auth-start`. After approval reaches the callback, complete the flow in the same Pi session without copying the callback URL or code:

```js
mcp({ action: "auth-complete", server: "linear-server" });
```

The validated callback stays in memory until explicit completion or the pending flow's five-minute timeout. Calling `auth-complete` before the callback arrives gives guidance and leaves the flow available. A denied callback reports failure without exchanging a code.

If the browser cannot reach Pi's callback (for example, Pi runs on a remote server), copy the full redirected localhost URL from the address bar even if the page fails to load:

```js
mcp({
  action: "auth-complete",
  server: "linear-server",
  args: { redirectUrl: "http://localhost:19876/callback?code=...&state=..." },
});
```

You can also pass only the `code` query parameter with `args: { code: "..." }`. Treat authorization URLs and codes as sensitive; they can grant access to the MCP server until the flow expires or completes. Callback state and issuer are checked before provider error text is displayed, as well as before code exchange.

New scope requirements are retained within the current runtime for the next permitted OAuth flow. URL-only servers also activate OAuth when their first protected catalog or tool is reached; valid saved tokens do not require another sign-in. Token scopes remain exactly what the authorization server issued. See [OAuth permission recovery](../OAUTH.md#newly-required-permissions) for consent, cancellation, and transport limits.

Persistent OAuth is unsupported out of the box on Android/Termux because `@napi-rs/keyring` 2.1.2 ships no Android native binding. Use a supported platform with an OS credential store for OAuth; there is no plaintext fallback. Unauthenticated, header-token, and stdio servers remain available. See [Android/Termux OAuth limits](../OAUTH.md#android--termux).

### Lifecycle Modes

- **`lazy`** (default) — Connect on selected discovery or first call, then disconnect after idle timeout. Cached metadata keeps search/list working without connections. Configured pins can intentionally discover their server at startup.
- **`eager`** — Connect at startup but don't auto-reconnect if the connection drops. No idle timeout by default (set `idleTimeout` explicitly to enable).
- **`keep-alive`** — Connect at startup. Auto-reconnect via health checks. No idle timeout. Use for servers you always need available.
- **`lazy-keep-alive`** — Connect on selected discovery or first call (like `lazy`); configured pins can discover it at startup. Once spawned, never idle-shut down and auto-reconnect via health checks if the process dies (like `keep-alive`). Use for servers that are expensive to start but should stay resident after their first use.

### Settings

```json
{
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "requestTimeoutMs": 30000,
    "showStatusIcon": true,
    "mcpFooterStatus": "compact",
    "hostConfigDiscovery": "off",
    "approveTools": ["github_delete_*", "notion_update_*"],
    "oauthDir": ".pi/mcp-oauth",
    "trace": {
      "enabled": true,
      "file": ".pi/fitch-mcp-adapter/traces/mcp.jsonl",
      "maxBytes": 262144,
      "maxEvents": 10000
    }
  },
  "mcpServers": {}
}
```

| Setting                                       | Description                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolPrefix`                                  | `"server"` (default), `"short"` (strips `-mcp` suffix), `"none"`, or `"mcp"` (prefixes with `mcp__`, using server-mode normalization). Per-server `toolPrefix` overrides this for that server.                                                                                                                                                                                     |
| `idleTimeout`                                 | Global idle timeout in minutes (default: 10, 0 to disable)                                                                                                                                                                                                                                                                                                                         |
| `requestTimeoutMs`                            | Global request timeout in milliseconds for live MCP calls (if omitted or `<= 0`, the MCP SDK default timeout is used)                                                                                                                                                                                                                                                              |
| `showStatusIcon`                              | Show the plug icon in MCP status and connection text (default: `true`). Set to `false` for plain `MCP: ...` text.                                                                                                                                                                                                                                                                  |
| `mcpFooterStatus`                             | MCP footer verbosity: `"compact"` (default) for `MCP connected/enabled`, `"full"` for enabled/connected/disabled detail, or `"off"` to clear the persistent footer status. `/mcp status` remains available.                                                                                                                                                                        |
| `hostConfigDiscovery`                         | Host-specific config policy: `"off"` (default) or `"on"` (explicitly load detected host configs as the lowest-precedence fallback)                                                                                                                                                                                                                                                 |
| `approveTools`                                | `true` to require approval before every MCP tool call, or an array of glob patterns such as `["github_delete_*", "notion_update_*"]`. Per-server `approveTools` overrides this.                                                                                                                                                                                                    |
| `oauthDir`                                    | Parent directory for legacy OAuth imports. Runtime uses its `fitch-mcp-adapter/` child; explicit v4 migration reads the original directory. Relative paths resolve from the active project cwd. `FITCH_MCP_OAUTH_DIR` overrides the final runtime import path; the old `MCP_OAUTH_DIR` is read only by explicit migration. Persistent credentials live in the OS credential store. |
| `mcpServers.<name>.oauth.authorizationParams` | Extra authorization URL parameters for provider-specific OAuth extensions. Flow-owned parameters such as `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `response_type`, and `resource` cannot be overridden.                                                                                                                                                    |
| `directTools`                                 | Global default for all servers (default: false). Per-server overrides this.                                                                                                                                                                                                                                                                                                        |
| `freezeDirectTools`                           | Keep direct-tool registration stable after the initial sync so automatic reconnects and list-change notifications do not rebuild the system prompt. Use `mcp({ action: "connect", server: "server" })` or `/mcp reconnect <server>` to refresh deliberately. Default: false.                                                                                                       |
| `disableProxyTool`                            | Hide `mcp` once configured pinned tools are available. Legacy resource pins keep it available for resource access.                                                                                                                                                                                                                                                                 |
| `autoAuth`                                    | Auto-run OAuth on `connect`/tool calls when a server needs auth, then retry once (default: false).                                                                                                                                                                                                                                                                                 |
| `sampling`                                    | Allow MCP servers to sample through Pi models, honoring `modelPreferences.hints` before current/default fallback (default: true when UI approval is available).                                                                                                                                                                                                                    |
| `samplingAutoApprove`                         | Skip sampling confirmation prompts. Required for sampling in non-UI sessions (default: false).                                                                                                                                                                                                                                                                                     |
| `elicitation`                                 | Allow MCP servers to request user input through Pi dialogs (default: true when Pi UI is available).                                                                                                                                                                                                                                                                                |
| `outputGuard`                                 | Guard oversized MCP output: `true` (default), `false`, or `{ maxBytes, maxLines, detailsMaxBytes }`. See [Output Guard](#output-guard).                                                                                                                                                                                                                                            |
| `trace`                                       | Opt-in metadata-only protocol tracing. Set `{ enabled: true }` globally or `trace: true` on a server. The per-session JSONL file defaults to `.pi/fitch-mcp-adapter/traces/`; `file`, `maxBytes` (default 262144), and `maxEvents` (default 10000) can be set. Raw MCP payloads, prompts, tool arguments/results, auth data, and URLs are never persisted.                         |

Per-server `idleTimeout`, `requestTimeoutMs`, and `approveTools` override the global settings. `debug` remains stderr display and is unrelated to protocol tracing.

### Tool Approval

Use `approveTools` when a tool should stay visible but not run without confirmation. This is useful for destructive or high-cost actions where hiding the tool would make planning harder, but running it silently is too risky.

```json
{
  "settings": {
    "approveTools": ["github_delete_*", "notion_update_*"]
  },
  "mcpServers": {
    "github": { "approveTools": ["delete_*", "merge_pull_request"] },
    "docs": { "approveTools": false }
  }
}
```

When a matching tool is called from the proxy tool, a direct MCP tool, a resource call, or an MCP UI iframe, Pi asks: **Allow once**, **Allow for session**, or **Deny**. The dialog dismisses itself when its tool call or the session is cancelled. Session approvals are kept in memory only. In headless sessions, matching calls fail closed with an `approval_required` result instead of running. `excludeTools` still removes tools entirely; `approveTools` only gates visible tools at call time.

### Output Guard

Oversized MCP tool/resource results are guarded by default so a single huge response can't blow up the model context window or the session file:

- Inline text output is capped at **50 KiB / 2,000 lines** (matching Pi's built-in `bash` guard). Larger output is truncated to a head preview and the full text is saved to a temp file whose path is included in the result, so the agent can `read`/`grep` it.
- **Image content blocks pass through unchanged** — only text output is guarded. Images are delivered to the provider as native image content.
- In gateway and direct modes, `details.mcpResult` is kept raw when its JSON is **≤ 16 KiB**; larger results use a compact summary and retain the full raw JSON in a file.
- Structured data, media, resources, extra protocol fields, and oversized results include a model-visible **result reference** to the saved raw result. Tiny plain-text results remain inline without an artifact. `structuredContent` is shown even when the server also returns content blocks.

Tune the limits with the object form:

```json
{
  "settings": {
    "outputGuard": { "maxBytes": 51200, "maxLines": 2000, "detailsMaxBytes": 16384 }
  }
}
```

Set `"outputGuard": false` — or the env kill switch `MCP_OUTPUT_GUARD=0` — to disable the guard and restore raw output behavior. Recovery notices remain visible even when a configured cap is too small to fit them. Saved files are created with mode `0600` under the system temp directory (or the SDK host's `outputDirectory`). Returned result, payload and UI-history paths belong to the reader or embedding host, which owns their retention and deletion. Closing a UI session, reloading the adapter or shutting down Pi does not delete them: existing chat history can still refer to those files. Delete only files whose references you no longer need. The OS may remove files in its temp directory; use a persistent `outputDirectory` when references must survive that cleanup. Spilled MCP output and UI history may contain sensitive data.

Read a retained result without repeating the MCP operation:

```js
mcp({
  action: "read-result",
  ref: "/returned/result/path",
  path: "/structuredContent/rows",
  fields: ["id", "title"],
  offset: 0,
  limit: 12000,
});
```

`path` is an RFC 6901 JSON Pointer; `fields` keeps immediate keys on the selected object or each object in an array. Selection happens before paging. `offset` and `limit` count **characters in the selected, pretty-printed JSON**, starting at zero—not rows, lines, or bytes. Readback defaults to 12,000 characters and remains bounded by the output byte/line caps. Continue with `details.nextOffset` until it is `null`. Readback requires an existing adapter output artifact in this host's output directory; it never calls the server again.

### Multi-call work

Use Pi's `codemode` tool for loops, filters, and dependent tool calls. Its scripts call any registered catalog tool, deferred or loaded, as `await tools.<flat_name>(args)`, and find unlisted tools with `searchTools`, `describeTool`, and `describeNamespace`. Gateway actions stay available as `tools.mcp({ action, ... })`, including `read-result` and `read-resource`. Each nested call runs through Pi's tool pipeline and the adapter's normal execution path, so authentication, approvals, filters, `beforeExecute`, `onToolCall`, output guards, and cancellation apply to it. Enable `codemode` with `+codemode` in `defaultTools` or `--tools`.

### MCP Resources

Resources are catalog entries addressed by URI, separate from tools:

```js
mcp({ action: "resources", server: "docs", limit: 12, offset: 0 });
mcp({ action: "read-resource", server: "docs", uri: "docs://guide" });
```

List first, then use the exact URI. Listings preserve the server's resource descriptor fields, including name, title, MIME type, icons, and `_meta` when supplied. `exposeResources`, include/exclude filters, disabled servers, authentication, and approval policy remain binding. Existing `read_<resource>` filter names still select resources, but these compatibility aliases are not typed functions and cannot be pinned in `/mcp`.

### MCP Prompts

MCP servers can advertise prompt templates alongside tools and resources. The adapter registers cached prompt definitions as Pi slash commands under `/mcp__<server>__<prompt>`, and refreshes their metadata whenever a server connects. Arguments support positional and `key=value` forms with quoting; required arguments are validated before `prompts/get` is called.

```text
/mcp__agent_board__create_plan "harden retry policy"
/mcp__agent_board__review_pipeline status=paused
/mcp prompts
```

Prompt results are flattened into one user message, preserving `[user]` and `[assistant]` role markers for multi-message results. Servers without the `prompts` capability are not probed.

### MCP Elicitation

When Pi exposes dialog-capable UI, the adapter advertises form elicitation support. Forms use Pi's stock `select()` and `input()` dialogs, validate the response, and provide a review/edit step before submission. Explicit refusal maps to MCP `decline`; dismissing a dialog maps to `cancel`, and a dialog that is still open when the Pi session stops is dismissed automatically.

URL mode is advertised only in TUI mode. The adapter displays the requesting server, target host, and full URL, and always requires consent before opening the browser. It also handles URL-required tool errors (`-32042`) and completion notifications; after completing the browser interaction, retry the original tool call.

### Typed Discovery and Pinned Tools

Every eligible cached or live tool registers as a Pi tool under its flat prefixed name, with `mcp_<server>` namespace metadata and the server's instructions. Pinned tools (`directTools`) are direct tools, active from startup. A pin that the branch recorded removing stays off after resume and tree navigation, as Pi keeps any recorded removal; a `tools` allowlist or `+name` selection that names the pin still activates it. Every other catalog tool registers with Pi's native `deferred` exposure: it is not declared to the model until `tool_search` loads it, but `codemode` scripts and nested tool execution can call it at any time. Loading does not execute a tool.

Pi's transcript records which loaded tools a branch declares and restores them across resume, reload, and branch navigation in default-tool sessions; SDK sessions that pass a plain `tools` allowlist or `noTools` own their initial selection, and tree navigation restores the branch loadout in every session. Host tool allowlists remain binding. Loaded schemas remain available rather than unloading each turn; activation changes declarations and can invalidate the prompt-cache prefix.

Tools that a server drops from its catalog, tools of disabled servers, and tools outside the current working directory's configuration are re-registered with `hidden` exposure, which withdraws them from every path until the catalog offers them again. A returning pin is active again only if it was active when it left. If the session resumes or moves to another tree branch while the pin is withdrawn, that branch decides instead: the pin returns active unless the branch recorded removing it. Legacy resource pins keep the gateway registered even with `disableProxyTool: true`.

Both official Pi and the maintained fork use public tool registration and active-tool APIs. Always use the exact name returned by discovery rather than constructing names.

Tool execution uses Pi's public request-boundary scheduling, not retired native async or pending-call APIs. Configured approval, MCP App UI consent, and the `beforeExecute` sequential checkpoint barrier remain binding.

Add `directTools` to pin frequently used tools into the initial active set:

Per-server (the `mcp.example.com` URLs are placeholders for your own endpoints):

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp"],
      "directTools": true
    },
    "github": {
      "url": "https://mcp.example.com/github",
      "directTools": ["search_repositories", "get_file_contents"]
    },
    "huge-server": {
      "url": "https://mcp.example.com/catalog"
    }
  }
}
```

| Value                  | Behavior                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `true`                 | Pin all eligible real tools from this server                     |
| `["tool_a", "tool_b"]` | Pin these tools (use original MCP names)                         |
| Omitted or `false`     | No initial pins; `tool_search` loads tools when needed (default) |

To set a global default for all servers:

```json
{
  "settings": {
    "directTools": true
  },
  "mcpServers": {
    "huge-server": {
      "directTools": false
    }
  }
}
```

Per-server `directTools` overrides the global setting. The example above pins tools for every server except `huge-server`, whose tools remain discoverable.

Set `MCP_DIRECT_TOOLS=__none__` before loading the adapter to suppress all typed-tool registration, including pins and deferred catalog tools. Gateway search can still discover schemas; use gateway calls instead. Normal tool filters, host allowlists, and disabled-server settings still apply.

To expose only a subset of a server, add `includeTools`. Values can be exact original names, prefixed names, or simple glob patterns. Legacy `read_<resource>` names continue to filter resource access:

```json
{
  "mcpServers": {
    "dokploy": {
      "url": "http://localhost:3845/mcp",
      "directTools": true,
      "includeTools": ["get_*", "dokploy_list_apps"]
    }
  }
}
```

To hide specific tools while still using `directTools: true`, add `excludeTools` on the server. `excludeTools` is applied after `includeTools`:

```json
{
  "mcpServers": {
    "figma": {
      "url": "http://localhost:3845/mcp",
      "directTools": true,
      "excludeTools": ["read_figjam", "figma_get_code_connect_map"]
    }
  }
}
```

`includeTools` and `excludeTools` filter typed tools, gateway discovery, resource access, and the `/mcp` panel. App-only tools stay out of the model catalog and pin choices.

Active schemas consume context; inactive cached schemas do not. Pin the tools you routinely need and discover the rest as the task requires.

Valid cached descriptors avoid startup connections. Missing or stale metadata for configured pins is discovered intentionally at startup; eager and keep-alive servers also connect as configured. An empty cache does not trigger discovery of every lazy server. Search coverage reports which configured servers are still unknown.

MCP catalog notifications and reconnects refresh eligible metadata. Removed tools leave the active set. `settings.freezeDirectTools: true` keeps the automatic registered surface stable after initial sync; deliberate `mcp({ action: "connect", server: "name" })` or `/mcp reconnect <server>` refreshes remain available.

Run `/mcp` to see known tools, pinned counts, resource counts, and connection state. Uncached servers say **undiscovered**. Expand a server to pin or unpin real tools; resources have no checkboxes and use the resource actions instead. Pin changes apply to the current session and persist through `directTools`. Discovered session selections are separate from these startup pins: unpinning leaves a tool active if discovery already selected it for the current branch. Press Enter on a server that needs auth or `ctrl+a` on an OAuth server to authenticate; `ctrl+r` reconnects. Broader setup changes still use Pi's normal reload flow.

**Guided first-run setup:** Run `/mcp setup` to inspect detected shared MCP files, adopt compatibility imports from other hosts, open discovered config paths, preview exact before/after file diffs for writes, scaffold a minimal project `.mcp.json`, add a curated known server (DeepWiki, Context7, Notion, GitHub, or Chrome DevTools), or quick-add RepoPrompt into a standard/shared MCP file.

Scaffolding creates a new file only. If `.mcp.json` already exists when the write runs, setup reports the error and leaves its contents unchanged.

**Subagent integration:** If you use the subagent extension, agents can request direct MCP tools in their frontmatter with `mcp:server-name` syntax. See the subagent README for details.

### MCP UI Integration

MCP servers can ship interactive UIs via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). The adapter uses MCP Apps 2.0.4. When you call a tool that has a UI resource, the adapter opens it in a native macOS window via [Glimpse](https://github.com/hazat/glimpse) if available, otherwise falls back to the browser.

**How it works:**

1. Agent calls a tool like `launch_dashboard`
2. The tool's metadata includes `_meta.ui.resourceUri` pointing to a UI resource
3. The adapter fetches the UI HTML and opens it in an iframe
4. The UI can call MCP tools and send messages back to the agent

**Native rendering:** On macOS, if [Glimpse](https://github.com/hazat/glimpse) is installed (`pi install npm:glimpseui`), UIs open in a native WKWebView window instead of a browser tab. Set `MCP_UI_VIEWER=browser` to force the browser, `MCP_UI_VIEWER=glimpse` to require native rendering, or `MCP_UI_VIEWER=none` (also accepts `off` / `disabled`) to suppress the window entirely — the tool still runs and its inline result is returned to the agent, but no browser or native window opens. This is useful for headless setups, CI, or users who want the tool output delivered inline as text only. When suppressed, a one-line info notification shows the UI URL so it can still be opened manually if needed.

**Bidirectional communication:** The UI talks back. When it sends a prompt or intent, the message is stored and `triggerTurn()` wakes the agent. The agent retrieves messages via `mcp({ action: "ui-messages" })` and responds, enabling conversational UIs where the app and agent collaborate in real-time.

**Session reuse:** When the agent calls the same tool again while its UI is already open, the adapter pushes the new result to the existing window instead of replacing it. This enables live updates — the agent can refine a chart, add data, or respond to user input without losing the current view. Different tools still replace the session as before.

**Message types from UI:**

| Type      | Purpose                                      |
| --------- | -------------------------------------------- |
| `prompt`  | User message that triggers an agent response |
| `intent`  | Structured action with name + params         |
| `notify`  | Fire-and-forget notification                 |
| `message` | Generic message payload                      |
| (custom)  | Any other type forwarded as intent           |

**Retrieving UI messages:**

```
mcp({ action: "ui-messages" })
```

Returns completed UI sessions (the last ten), grouped in the existing prompt → intent → context → notification order. Prompt handoffs are also normalized into intents. Prompts, intents and notifications are saved in private disk history as they arrive; context updates and SSE replay retain their existing bounds. Small retrievals keep the original inline content/details. Large retrievals return `resultRef` for the complete grouped output and `historyRefs` for original JSONL events; use `read-result` with `offset`/`limit` to page them without rerunning UI actions. Plain output pages are streamed without loading the entire artifact into memory.

Retrievals run one at a time per adapter state, so concurrent callers cannot consume the same sessions twice. Each retrieval snapshots pending sessions after the preceding retrieval finishes. Retrieval drains only the sessions included in a usable inline/file receipt; read/write failure leaves them available for retry. History-write failure is explicitly reported, and unsaved events remain recoverable in the current instance's memory. **If normal storage fails and you then reload or exit, that unsaved tail is lost.** There is deliberately no session-journal rescue or alternate recovery file. Retrieve the pending messages before reloading or exiting when possible; do not treat the warning as a durable receipt. This rare failed-storage boundary does not change normal disk-history persistence or failed-delivery recovery. Files use private directory/file permissions and the existing output-directory lifetime: receipts remain readable after draining or UI closure, and are not deleted automatically. Remove artifacts only when you no longer need recovery. New sessions completed during retrieval are not cleared.

Messages and context updates are accepted only while the UI is open. An upload finishing after completion is rejected before it can invoke callbacks or alter history. Retrieval verifies the accepted history prefix's byte and event counts; truncated history remains pending recovery instead of being delivered and cleared.

**Browser controls:**

- **Cmd/Ctrl+Enter** — Complete and close
- **Escape** — Cancel and close
- **Done/Cancel buttons** — Same as keyboard shortcuts

**Technical notes:**

- Tool consent gates whether UIs can call MCP tools (never/once-per-server/always)
- `_meta.ui.visibility` controls audience: tools marked app-only stay out of the model tool list, and tools marked model-only cannot be called from the UI iframe.
- Works with both stdio and HTTP MCP servers
- Uses a local MCP Apps AppBridge bundle for browser↔server communication
- Enforces CSP from standard `_meta.ui.csp` and OpenAI-compatible `_meta["openai/widgetCSP"]` metadata in the response header while preserving provider HTML.

### Local Example: Interactive Visualizer

A minimal MCP UI example at `examples/interactive-visualizer` demonstrating charts, bidirectional messaging, and streaming. From that directory:

```bash
npm install
npm run build
npm run install-local
```

Restart pi, then ask the agent to show a chart — it calls `show_chart` and opens the UI in Glimpse (macOS) or the browser. Use `npm run uninstall-local` to remove the MCP entry.

### Import Existing Configs

Shared MCP files are loaded automatically. Use `imports` only for host-specific config formats that are not already covered by `.mcp.json` or `~/.config/mcp/mcp.json`.

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop", "opencode"],
  "mcpServers": {}
}
```

Supported compatibility imports: `cursor`, `claude-code`, `claude-desktop`, `opencode`, `vscode`, `windsurf`, `codex`

`fitch-mcp-adapter init` detects these host-specific configs and adds missing imports to the adapter-owned global config for you. The `opencode` import reads OpenCode V1 `mcp` entries from both `~/.config/opencode/opencode.json` and the project `opencode.json`, with project fields taking precedence. It is explicit-import only; OpenCode V2, inline content, managed configs, and remote discovery are not supported.

### Project Config

Prefer `.mcp.json` for project-local shared MCP config. Use `.pi/fitch-mcp-adapter/mcp.json` only when you need an adapter-specific project override. Project files override both user-global shared MCP config and Pi global overrides.

## Usage

| Action                        | Example                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Discover and load typed tools | `tool_search({ query: "screenshot" })` (native Pi)                                                                      |
| Status                        | `mcp({ action: "status" })`                                                                                             |
| List server tools             | `mcp({ action: "list", server: "name", limit: 12, offset: 0 })`                                                         |
| Search without activation     | `mcp({ action: "search", query: "screenshot navigate", limit: 12 })`                                                    |
| Describe                      | `mcp({ action: "describe", tool: "tool_name", server: "name" })`                                                        |
| Instructions                  | `mcp({ action: "instructions", server: "name" })`                                                                       |
| Call                          | `mcp({ action: "call", tool: "tool_name", args: { key: "value" } })`                                                    |
| Connect or refresh            | `mcp({ action: "connect", server: "name", limit: 12, offset: 0 })`                                                      |
| List resources                | `mcp({ action: "resources", server: "name" })`                                                                          |
| Read resource                 | `mcp({ action: "read-resource", server: "name", uri: "docs://guide" })`                                                 |
| Read saved result             | `mcp({ action: "read-result", ref: "/returned/result/path", path: "/structuredContent" })`                              |
| UI messages                   | `mcp({ action: "ui-messages" })`                                                                                        |
| Auth start                    | `mcp({ action: "auth-start", server: "name" })`                                                                         |
| Auth complete                 | `mcp({ action: "auth-complete", server: "name" })` after the browser callback, or supply `args: { redirectUrl: "..." }` |

`action` is required. Search requires `query`; describe/call require `tool`; list/connect/instructions/resources/auth require `server`; resource reads require `server` and `uri`; saved-result reads require `ref`. Pass object `args`. Optional `server` disambiguates tool calls and descriptions.

`connect` refreshes an already connected server, including tools, resources, prompts, and instructions. Server-scoped discovery connects that server if its catalog is unknown. Global search uses known catalogs and returns `coverage: { complete, knownServers, unknownServers }`; partial coverage is never presented as an exhaustive result. Gateway search provides schemas without activating functions, so it works for gateway-only hosts.

Gateway search ranks names, descriptions, and parameter guidance using MiniSearch. Catalog pages use item offsets: gateway search and lists default to 12; maximum 100. Follow the returned `nextOffset`. Saved-result readback uses character offsets instead. Native `tool_search` uses Pi's own ranking over the registered deferred tools.

An exact, case-sensitive public tool name ranks before lexical matches; with `server`, an exact original tool name also ranks first within that server. Unscoped original names do not select an account. All remaining matches retain MiniSearch order. Gateway search continuation and retry calls remain metadata-only.

Describe preserves the complete server descriptor, including JSON Schemas, annotations, `_meta`, and extensions when present. Search and typed-tool discovery exclude app-only tools and resources. Legacy hyphen/underscore matching remains a compatibility convenience; ambiguous names require an explicit server rather than executing an arbitrary match. Use the exact names returned by discovery.

The gateway description stays stable as catalogs and credentials change. Server instructions are available through `action: "instructions"` and previews in server listings, rather than injected dynamically into the prompt.

Gateway and typed-tool cards render compactly in the terminal. A collapsed card shows the first three terminal-wrapped rows of long call arguments and of long result text, each followed by an ellipsis and Pi's `app.tools.expand` hint. Arguments that fit in five rows show whole. Expanding shows the arguments as formatted JSON, cut at 1,500 characters, and the guarded result. Pi's HTML export shows the arguments as an expanded card does, because an exported call cannot be expanded; an exported result keeps its collapsed and expanded forms. Structured data and saved-result references remain visible to the model.

## Commands

| Command                   | What it does                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/mcp`                    | Interactive panel and first-run onboarding surface                                                                       |
| `/mcp setup`              | Guided setup for imports, a minimal `.mcp.json`, curated known servers, RepoPrompt quick-add, and config-path inspection |
| `/mcp tools`              | List discovered real tools, excluding resource aliases                                                                   |
| `/mcp status`             | Show connection state and separate tool/resource counts                                                                  |
| `/mcp prompts`            | List all MCP prompts registered as slash commands                                                                        |
| `/mcp reconnect`          | Reconnect all servers                                                                                                    |
| `/mcp reconnect <server>` | Connect or reconnect a single server                                                                                     |
| `/mcp disable <server>`   | Disable a server in the project-local `.pi/fitch-mcp-adapter/mcp.json` (requires `/reload` to apply)                     |
| `/mcp enable <server>`    | Enable through the project-local override layer (requires `/reload` to apply)                                            |
| `/mcp logout <server>`    | Clear stored OAuth credentials for a server and disconnect it                                                            |
| `/mcp-auth`               | Open an OAuth server picker in interactive UI sessions                                                                   |
| `/mcp-auth <server>`      | OAuth setup for a specific server                                                                                        |

If `settings.autoAuth` is `true`, `mcp({ action: "connect", server: "..." })`, gateway calls, and typed tool calls may run OAuth when needed, with at most one automatic auth attempt per invocation and one post-auth retry. Browser authorization requires an interactive host. Auth-only replacement preserves accepted work on the old client; ordinary `/mcp reconnect` and panel `ctrl+r` remain hard resets.

In interactive sessions, you can also authenticate from `/mcp` with `ctrl+a` or Enter on a server that needs auth. In remote/headless sessions, use the proxy tool's `auth-start` and `auth-complete` actions. Complete without arguments when the browser reaches Pi's callback, or paste the redirect URL when it cannot. `/mcp-auth` without a server only opens a picker in the interactive UI.

### MCP output schemas

Advertised tool `outputSchema` values support JSON Schema draft-07 and 2020-12. Unstamped schemas use the SDK's 2020-12 default. Returned `structuredContent` is validated against the advertised schema for both proxy and direct-tool calls. Typed direct tools also expose that schema and bounded `structuredContent` to native Pi composition. Human text/images remain complementary. Oversized, absent, or not-run structured results return an `mcpAdapter` receipt (`omitted`, optional `resultRef`/`error`) instead of fabricating a server-schema value. Only the protocol's structured field is exposed: private details and `_meta` are not copied. Native content-only result-hook redaction drops structured output, as intended. Any JSON structured value—including `null`, `false`, and `0`—is rendered as text, including alongside non-empty content or images. The raw result remains available for saved-result readback.

## How It Works

- Active `mcp` gateway; pins are active direct tools; other typed schemas register deferred and load through native `tool_search` or run from `codemode`
- Lazy servers connect on selected discovery or calls; configured pins and eager/keep-alive servers can bootstrap intentionally
- Tool metadata is cached to disk so search/list/describe work without live connections
- Idle servers disconnect after 10 minutes (configurable), reconnect automatically on next use
- npx-based servers resolve to direct binary paths, avoiding an extra npm parent process
- Pi validates loaded typed-tool arguments against their schemas; gateway arguments are validated by the MCP server
- Keep-alive servers get health checks and auto-reconnect
- `directTools` pins initial tools; search-driven selections persist separately on the native session branch
- Resources use explicit URI-based listing and reading, without synthetic function definitions

## Limitations

- The adapter does not manage shared server processes. Each Pi session starts its own stdio processes unless you configure an external [rmcp-mux service](#shared-mcp-processes-with-rmcp-mux).
- Compact MCP result rendering summarizes text, but inline images are still controlled by Pi's image display settings and may render below the compact text summary.
- MCP sampling support is text-only; context inclusion, tools, stop sequences, audio, and image content are rejected with explicit errors.
