<p>
  <img src="banner.png" alt="pi-mcp-adapter" width="1100">
</p>

# Fitch MCP Adapter

Use MCP servers with [Pi](https://github.com/earendil-works/pi) without burning your context window.

An independently maintained distribution of [Nico's Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter), under the original MIT license.

https://github.com/user-attachments/assets/4b7c66ff-e27e-4639-b195-22c3db406a5a

## Why This Exists

Mario wrote about [why you might not need MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/). The problem: tool definitions are verbose. A single MCP server can burn 10k+ tokens, and you're paying that cost whether you use those tools or not. Connect a few servers and you've burned half your context window before the conversation starts.

His take: skip MCP entirely, write simple CLI tools instead.

The MCP ecosystem has useful databases, browsers, and APIs. This adapter keeps their full tool schemas out of context until needed. `mcp_search` discovers and loads typed tools for the next request; `mcp` handles explicit gateway actions, and `mcp_script` composes MCP calls in JavaScript. Lazy servers stay disconnected until selected discovery or a call needs them.

## Pi release qualification

The development baseline is official Pi **0.87.1**; host peers remain wildcard. `npm run check:compat` verifies the installed SDK and CLI identity, builds and typechecks, runs Vitest and memory-only OAuth tests, then loads a packed consumer through the native SDK and CLI.

GitHub CI runs that contract on Node 24 against both official Pi and the maintained fork through the shared Pi compatibility automation, including fresh Git and npm installations loaded by the real Pi CLI. A second job checks lockfile registry hosts, published type declarations, the built interactive visualizer, and MCP protocol conformance. These checks use local MCP fixtures and disposable agent directories, never live credentials or paid providers.

## Install

Requires Pi 0.87.1 or later and Node.js 24 or later.

```bash
pi install npm:@fitchmultz/pi-mcp-adapter
```

Or install from Git: `pi install git:github.com/fitchmultz/pi-mcp-adapter`.

Restart Pi after installation. Existing v4 users should migrate first.

### Upgrading from v5

Version 6 keeps v5's package, config paths, and OAuth namespace. No credential migration is needed.

- Use `mcp_search({ query: "...", server: "name" })` to discover and load typed tools. It loads matches for the next request; it never executes a search hit. `directTools` now pins tools at startup rather than deciding which tools can ever be loaded.
- Give every new gateway call an explicit `action`: `mcp({ action: "search", query: "..." })`, `mcp({ action: "describe", tool: "..." })`, or `mcp({ action: "call", tool: "...", args: {} })`. Arguments are objects. Stored v5 calls with optional mode fields or JSON-string arguments are normalized at the ingress compatibility boundary; they are not the advertised v6 interface.
- Resources use `resources` and `read-resource` actions, or `tools.resources` and `tools.readResource` in scripts. Generated `read_<resource>` aliases remain callable through gateway/script compatibility, but no longer appear as functions or panel checkboxes. Remove resource aliases from `directTools`; legacy resource pins keep the gateway available even with `disableProxyTool: true`.
- Script descriptions always return complete JSON Schema in `inputSchema`, with `outputSchema` and other descriptor fields when supplied. Replace `inputTypeScript` consumers. Calls keep raw MCP results, including error-result data; use returned result references for bounded readback without another server call.
- Global search reports partial catalog coverage instead of starting every uncached lazy server. Select a server to discover it. Cache format 2 preserves raw descriptors and still reads format 1; downgrading to v5 ignores format 2 and requires rediscovery.

### Upgrading from v4

The Fitch distribution uses its own package, state paths and OAuth credential namespace. Remove the previous adapter package entry from Pi settings (for example, `pi remove npm:pi-mcp-adapter` for the unscoped npm source), then install the distribution above. Keep only one adapter loaded in a Pi host.

After installation, **before restarting Pi**, run from your project directory:

```bash
fitch-mcp-adapter migrate --dry-run
fitch-mcp-adapter migrate
```

If Pi's package bin is not on your `PATH`, use `npx --package @fitchmultz/pi-mcp-adapter fitch-mcp-adapter migrate` (append `--dry-run` to preview).

Migration copies v4's global `mcp.json`, `mcp-cache.json`, `mcp-onboarding.json` and `mcp-npx-cache.json` into `<Pi agent dir>/fitch-mcp-adapter/`, and the current project's `.pi/mcp.json` into `.pi/fitch-mcp-adapter/mcp.json`. Existing destinations are reported and left unchanged, without merging. Repeat in each project that has an old override. Use the same `PI_CODING_AGENT_DIR` as your Pi installation.

For configured HTTP servers, migration copies an existing OAuth entry from the old OS credential namespace or legacy token file only when the new namespace has no entry. It preserves URL/issuer bindings, client registration and tokens, verifies the copy, and never prints plaintext credentials. All old sources remain untouched. A configured `settings.oauthDir` uses a `fitch-mcp-adapter/` child directory during normal operation, keeping the original import files separate. Dry-run lists file actions without reading the keychain or writing anything; repeated migration skips already-copied destinations.

Normal startup never falls back to old adapter-owned defaults or the old credential namespace, so logout cannot resurrect old credentials. Migration copies an existing provider grant; it does not create an independent grant. To use both distributions with independent provider grants, sign in separately. Shared standard MCP files and explicit `configPath`/imports retain their behavior. See [OAuth storage](OAUTH.md#token-storage).

## What happens on first run

The adapter reads standard MCP files automatically. No extra setup needed if you already have them.

| You already have... | What happens |
|---------------------|--------------|
| `.mcp.json` or `~/.config/mcp/mcp.json` | Pi uses it immediately. The first time you open `/mcp`, you'll see a short heads-up explaining which file Pi detected and that Pi only writes adapter-specific overrides to its own files. |
| Host-specific configs (Cursor, Claude Code, Codex, etc.) but no standard MCP files | Run `/mcp setup` to adopt those host configs into Pi. The setup flow shows exactly what it found, lets you pick which ones to import, and previews the exact file changes before writing. |
| Nothing configured yet | Run `/mcp setup` to scaffold a minimal `.mcp.json`, add a curated known server, quick-add RepoPrompt, or inspect what the adapter discovered on your machine. |

If you prefer the terminal, run `fitch-mcp-adapter init` after install to scan for host-specific configs and add missing compatibility imports to `~/.pi/agent/fitch-mcp-adapter/mcp.json` (or `$PI_CODING_AGENT_DIR/fitch-mcp-adapter/mcp.json` when set).

## Quick Start

Preferred project config: `.mcp.json`

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

Servers are **lazy by default**. Cached tool descriptors can be searched without a live connection. To discover an uncached server and load the tools relevant to a task:

```js
mcp_search({ query: "take screenshot", server: "chrome-devtools" })
```

The returned exact tool references become available with their full argument schemas on the next model request. The agent then calls the chosen typed tool normally. Discovery does not run it.

If the host only permits `mcp`, use explicit gateway actions instead:

```js
mcp({ action: "search", query: "take screenshot", server: "chrome-devtools" })
mcp({ action: "describe", tool: "chrome_devtools_take_screenshot" })
mcp({ action: "call", tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
```

Gateway search returns schemas without activating direct tools. All paths preserve the same authentication, approval, and call-capture behavior.

## Config

### File Layout

Use the shared MCP files when you want one setup to work across hosts, and Pi-owned files when you need Pi-specific overrides or settings.

| File | Purpose |
|------|---------|
| `~/.config/mcp/mcp.json` | User-global shared MCP config |
| `~/.agents/mcp.json` | User-global tool-agnostic MCP config |
| `~/.agents/mcp/mcp.json` | User-global tool-agnostic MCP config |
| `.mcp.json` | Project-local shared MCP config |
| `<Pi agent dir>/fitch-mcp-adapter/mcp.json` | Adapter global override and compatibility imports |
| `.pi/fitch-mcp-adapter/mcp.json` | Adapter project override |

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

Set `createMcpAdapter({ outputDirectory: "/workspace/internal/mcp-output" })` to keep oversized tool/resource text, raw MCP JSON, and final `mcp_script` output beneath a host-owned directory. The directory is created on the first spill; each file still uses a random subdirectory/name and mode `0600`. Relative paths resolve from the process working directory when written; prefer an absolute path for hosts that change directories. This runtime option works with either configuration mode and does not change live results, output limits, or cleanup. The host owns retention, access, and any redaction of saved copies; files may contain sensitive data. Omitting it keeps the system temp directory.

Set `createMcpAdapter({ defaultScriptTimeoutMs: null })` to remove the default overall `mcp_script` deadline for that host only. Omitting the option keeps 30,000ms; a numeric default must be an integer from 1 to 2,147,483,647 milliseconds. Each script's explicit `timeoutMs` takes precedence. This is a factory option, not an MCP config or global Pi setting. It does not change initialization waits, individual MCP request deadlines, Stop/AbortSignal, session-owner shutdown, or unfinished-call cleanup. Without an overall deadline, a script can run until it completes or is stopped. Script result `details.timeoutMs` is `null` when no overall deadline applies.

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

`createMcpAdapter({ beforeExecute: async (toolCallId, ctx, operation) => { ... } })` lets a host finish its workspace/native-session checkpoint before the next MCP action. For direct tools, actual `mcp` calls and every resolved `mcp_script` inner call, it runs after target resolution, connection, approval and UI preparation but **before the individual service deadline** and `onToolCall` capture. Any configured overall script deadline still applies. A second awaited script call reaches this boundary after the first call's output files have finished writing. The callback receives the native Pi call ID and that invocation's `ExtensionContext`, with its caller/owner/script cancellation signal in `ctx.signal`. Pass it to checkpoint I/O and throw if the checkpoint cannot complete. Rejection prevents that call: direct/proxy execution throws, while scripts keep their failed-call envelope so they can handle preparation failures. Existing two-argument callbacks remain supported.

The optional `McpOperationContext` (exported from the package and `/types`) carries the same `server`, `tool`, resolved `args`, optional `annotations`/`resourceUri`, and outer/inner IDs as the native before event, plus `annotationsTrusted`. Live connection annotations take precedence over frozen direct-tool hints, including when live hints are absent. `annotationsTrusted` reports only the existing server `retryOnTransportFailure: true` opt-in; it is not a new permission or configuration gate. No server configuration, headers, credentials, or SDK clients are exposed. Non-call proxy modes (including status, discovery, connect and auth actions) still invoke the callback without an operation; unresolved or denied tool calls do not dispatch.

A host can skip an expensive before-effect save for a native resource read (`operation.resourceUri`) or for `operation.annotationsTrusted && operation.annotations?.readOnlyHint === true`. Missing/false hints and `idempotentHint: true` alone are not read-only: an idempotent write still changes state. Keep unknown operations conservative and retain original intent/outcome capture. The adapter does not choose the host's save policy.

Supplying `beforeExecute` marks the adapter's tools `executionMode: "sequential"`, so Pi finishes earlier sibling tools before entering this boundary. Omitting it keeps normal scheduling. It does not serialize `Promise.all` inside a script, join detached writers, or implement checkpoint storage. The host still owns coherent capture and a final completion checkpoint, including final script output files. These callbacks do not change request or script timeout defaults.

`createMcpAdapter({ onToolCall: async (event) => { ... } })` supplies one optional, session-scoped callback for `mcp`, direct tools, and each resolved `mcp_script` call. Load this factory instead of also loading the default adapter. The callback is passed directly, so separate Pi/Jiti module instances do not need to share a singleton or event bus.

`McpToolCallEvent` (exported from `@fitchmultz/pi-mcp-adapter/types`) contains `server`, `tool`, the actual resolved `args`, optional SDK `annotations` and `resourceUri`, and a cancellation/deadline `signal`. `toolCallId` is the outer native Pi ID; scripts additionally carry their existing numeric `innerCallId`. These IDs are correlation only, not provider idempotency keys.

- `phase: "before"`: awaited after approval, before dispatch. Rejection prevents the call.
- `phase: "after"`: contains either the raw `result` (including MCP error results) or the thrown `error`. Awaited before delivering the outcome to Pi or dependent script work. It runs once after native recovery/retry settles, not once per HTTP subrequest. Output spill files are written **after** this callback; they are complete when the tool or awaited script call resolves, not at the after event.
- Capture failure returns `call_capture_failed` with the original event, excluding `signal`, in `details.recovery`. A completed result stays there; the adapter never repeats it. A script stops before consuming that result or starting dependent work. Cancellation remains `aborted`.

The two callbacks serve different boundaries: `beforeExecute` saves completed workspace writes; `onToolCall` captures the resolved operation and its raw outcome. The host owns `pi.appendEntry()` and the awaited checkpoint of that same native JSONL. Exclude `signal`, serialize thrown errors explicitly, redact sensitive checkpoint bytes, and honor the signal and session/attempt fence. `pi.appendEntry()` alone only persists locally; `pi.events.emit()` is not an awaited barrier. Custom entries do not enter model context automatically: the host must provide truthful recovered results or readback instructions when resuming. The adapter stores no separate transcript or receipts, does not replay scripts, and does not invent provider operation keys.

### Native working-session checkpoints

On hosts that emit the optional awaited `session_checkpoint` event, the adapter can acknowledge an **idle, stateless Streamable HTTP** runtime with its **default sampling and elicitation capabilities intact**. Older Pi hosts continue normally and never invoke this hook. The host still owns native session capture, coherent filesystem capture, private credential retention, and commit-before-sleep.

Sampling/elicitation handlers are owned through their actual UI/model/handler promises. A pending handler returns a named veto; after it finishes, an otherwise reconstructible runtime can qualify. Cancelling an SDK response or closing a transport does not discard an unfinished handler: connection cleanup drains those callbacks. Native sends that outlive per-server cancellation remain owned and veto readiness; final shutdown joins them. SDK-generated callback replies remain owned through HTTP/auth completion even after the handler returns. Unfinished callbacks also prevent automatic idle closure. Configured `beforeExecute`/`onToolCall` hooks likewise do not block idle checkpoints. Their underlying promises stay counted even if the caller's abortable wait has ended. Callbacks must return/await their work and persist any logical state they need on resume; arbitrary unreturned detached work and closure memory are not serialized.

Ordinary logging, argument completion, empty experimental metadata, and the SDK's auto-opened catalog notification subscription are reconstructible: requests are owned and notification ingress is fenced. Explicit consumer resource/listen subscriptions, negotiated remote tasks, opaque protocol capabilities, HTTP session IDs, legacy SSE, stdio/Unix servers, pending initialization/requests/refresh/health checks, browser OAuth flows, UI sessions/messages, active scripts, and unpersisted session approvals return a named `sleepReady: false`. Session grants are not silently reset to obtain readiness. Advertising subscription support alone is not an active subscription. A resource-subscribe attempt with a cancelled/lost response remains unresolved until successful unsubscribe or connection disposal; it is not silently replayed. Completed URL elicitation clears only its accepted ID; other pending IDs still veto. Failed cleanup remains owned; an explicit later close may retry only if the native client still owns its transport. Unsupported work remains usable while compute stays running; the hook does not cancel accepted operations to manufacture readiness.

Before any asynchronous flush, the adapter fences owned activity and pauses its existing health-check timer. New requests, background HTTP GET/reconnect/auth work, or incoming callbacks invalidate the host's hold **before** dispatch or mutation. Native provider promises and HTTP headers/body reads remain owned through settlement, including cancellation tails; final shutdown joins them while per-server cancellation stays prompt. An idle inbound SSE stream is not a perpetual active request. Completed refreshes use the existing native OS credential store; no token file or second auth store is introduced. Server OAuth challenges reconstruct through normal re-challenge, with granted scopes and issuer bindings in native credentials. Required metadata persistence errors reject capture; optional diagnostic tracing stays best-effort and never prevents recovery or clean exit. Release/cancellation resumes the same clients and timer, without replaying tools, reauthenticating, or running shutdown. Cold startup uses normal discovery and native credentials; only a new explicit tool invocation sends a new tool request.

`session_shutdown` separately performs best-effort cleanup and propagates persistence/cleanup failures through the host's ordinary extension error contract. A host callback still running after cleanup also prevents clean-shutdown success. A clean-exit host must not infer success after a failed handler. No callback/process memory recovery is promised.

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

The adapter uses official split MCP SDK 2.0.0. HTTP connections automatically negotiate protocol `2026-07-28` and fall back to older revisions using the SDK's native rules. The SDK generates protocol metadata, method/name headers, and schema-driven `Mcp-Param-*` headers. Modern HTTP supports streamed POST responses without opening a legacy standalone GET stream. Deprecated SSE is tried only when the Streamable HTTP handshake rejects the endpoint with HTTP 404, 405, 406, or 415—not after a timeout, network failure, or authentication failure.

For known legacy servers, set `protocolVersion: "legacy"`. This is also the workaround for servers that answer `server/discover` with an HTTP 200 JSON-RPC error whose `id` is `null`: SDK 2.0.0 cannot negotiate that response. The adapter reports the native failure rather than inventing authentication guidance or overriding the SDK's fallback classifier. Stdio and Unix sockets remain legacy by default. Explicit `"auto"` on native stdio uses the SDK's disposable probe process before starting the session process.

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

Unknown or non-idempotent tools remain callable but are never automatically redispatched after those failures. An unresolved transport failure, interrupted JSON response body, closed connection, or cancellation/deadline while a dispatched tool request awaits its response returns internal `ambiguous_outcome` details with server/tool/call identity and readback instructions. Scripts retain these outcomes in their `calls` trace even when stopped by an overall timeout, cancellation, or early return. Use the original saved arguments and the provider's supported operation/resource identity to read the prior result, then continue the remaining work; do not blindly repeat a write or rerun its whole script. Missing annotations are not permission denial. Confirmed pre-dispatch legacy-session and authentication recovery remain available.

A broken SSE body fails only the affected request, even when retries are disabled. Completed responses and later stream notifications remain intact. Native SSE resumption stays SDK-owned: a server-provided event ID lets the SDK resume the existing stream before any adapter retry.

This transport-failure option does not retry OAuth failures, JSON-RPC errors, tool error results, invalid responses, closed connections, cancellation, or expired deadlines. Permission recovery uses the separate existing `autoAuth` gate, not this option. JSON response-body failures, clean SSE endings without a response, and streams that merely stop making progress are not replayed. The original tool deadline covers SDK subrequests and retries, and modern retry never stacks with legacy expired-session recovery. Native header-schema refresh and multi-round-trip input handling remain SDK-owned.

### Server Options

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "lifecycle": "lazy",
      "idleTimeout": 10,
      "requestTimeoutMs": 30000
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `command` | Executable for stdio transport; mutually exclusive with `url` and `socket` |
| `args` | Command arguments |
| `socket` | Explicit `rmcp-mux` Unix-domain socket path; supports `${VAR}`, `$env:VAR`, and `~` expansion and is mutually exclusive with `command` and `url` |
| `env` | Environment variables; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the stdio server connects; use `!!` for a literal leading `!`. |
| `cwd` | Working directory; supports `${VAR}`, `$env:VAR`, and `~` expansion |
| `protocolVersion` | `"auto"` or `"legacy"`. HTTP defaults to `"auto"`; stdio and Unix sockets default to `"legacy"`. |
| `retryOnTransportFailure` | Trust explicit read-only/idempotent annotations for one modern transport retry (default: `false`); see [Transport compatibility](#transport-compatibility) before enabling. |
| `url` | HTTP endpoint (StreamableHTTP with SSE fallback); supports raw `${VAR}` and `$env:VAR` interpolation, and missing URL variables fail before any request is sent |
| `headers` | HTTP headers; supports `${VAR}` and `$env:VAR` interpolation. A value beginning with `!` runs a command when the HTTP server connects or OAuth authenticates; use `!!` for a literal leading `!`. |
| `auth` | `"bearer"` or `"oauth"` |
| `oauth.grantType` | `"authorization_code"` (default) or `"client_credentials"` for non-interactive machine auth |
| `oauth.clientId` | Pre-registered OAuth client ID; takes priority over stored clients and automatic registration |
| `oauth.clientSecret` | OAuth client secret for confidential clients; a value beginning with `!` runs a command when OAuth authenticates, while `!!` escapes a literal leading `!` |
| `oauth.privateKeyJwt` | Native private-key authentication: `privateKey` (PKCS#8 PEM, JWK object/JSON, environment or `!command` source), `algorithm`, optional `audience`, `lifetimeSeconds`, `claims`; requires a configured client ID or custom metadata document, not `clientSecret` |
| `oauth.crossAppAccess` | Native enterprise OIDC exchange: `idpUrl`, IdP `clientId`, `idToken`, optional IdP `clientSecret`; all support lazy environment/`!command` sources. Omit `grantType`. |
| `oauth.scope` | Requested OAuth scopes |
| `oauth.redirectUri` | Exact localhost redirect URI for browser OAuth, including port and path, for providers that pre-register callbacks |
| `oauth.clientName` | Client display name advertised during dynamic registration |
| `oauth.clientUri` | Client homepage URI advertised during dynamic registration |
| `oauth.clientMetadataUrl` | Custom HTTPS Client ID Metadata Document URL, or `false` to disable automatic CIMD for new registrations; supports environment interpolation |
| `oauth.skipIssuerMetadataValidation` | Skip only the authorization-server metadata issuer check for a known incompatible provider (default: `false`). Stored issuer and callback checks remain enforced. |
| `bearerToken` / `bearerTokenEnv` | Token or env var name; `bearerToken` supports `${VAR}` and `$env:VAR` interpolation. A leading `!` in `bearerToken` runs a command when the HTTP server connects; use `!!` for a literal leading `!`. |
| `lifecycle` | `"lazy"` (default), `"eager"`, `"keep-alive"`, or `"lazy-keep-alive"` |
| `idleTimeout` | Minutes before idle disconnect (overrides global) |
| `requestTimeoutMs` | Request timeout in milliseconds for live MCP calls (overrides global; if omitted or `<= 0`, the MCP SDK default timeout is used) |
| `exposeResources` | Make MCP resources available through resource listing/reading (default: true) |
| `directTools` | `true`, `string[]`, or `false` — pin real tools into the initial active tool set |
| `toolPrefix` | Override global `settings.toolPrefix` for this server (`"server"`, `"short"`, `"none"`, or `"mcp"`) |
| `includeTools` | `string[]` of tool names or glob patterns to expose (matches original names like `get_screenshot`, legacy resource filter aliases like `read_figjam`, and prefixed names like `figma_get_screenshot`) |
| `excludeTools` | `string[]` of tool names or glob patterns to hide (applied after `includeTools`) |
| `debug` | Show server stderr (default: false) |
| `trace` | Enable metadata-only JSONL protocol tracing for this server; payloads, prompts, tool arguments/results, authorization data, and URLs are never persisted |
| `disabled` | Keep the server visible in config and status, but prevent connections, authentication, tools, and resource calls (only literal `true` disables it) |

For pre-registered browser OAuth clients, set `oauth.redirectUri` to the exact callback registered with the provider, for example `"http://localhost:3118/callback"`. Dynamic clients normally omit it and use a lazy OS-assigned localhost callback port.

Secret values in `headers`, `bearerToken`, `oauth.clientSecret`, `oauth.privateKeyJwt.privateKey`, `oauth.crossAppAccess` fields, and stdio `env` may use a leading `!command` to obtain their value at connection or authentication time. The command runs with stdin and stderr suppressed, stdout is limited to 1 MiB and trimmed, and it must finish within 10 seconds with non-empty output; failures stop the connection or authentication flow. Commands are not run during OAuth discovery or while reading, merging, previewing, hashing, or rendering configuration. Use `!!` to escape a literal leading `!`; ordinary and escaped values retain environment interpolation.

### OAuth client registration

Eligible browser clients automatically use the [Fitch MCP Adapter client metadata document](https://fitchmultz.github.io/pi-mcp-adapter/client-metadata.json). The SDK keeps configured `clientId` and usable stored registrations first, then uses the document when the authorization server advertises `client_id_metadata_document_supported: true`. Otherwise it uses dynamic client registration (DCR), if available. An authorization server rejecting or failing to fetch a document does **not** guarantee a fallback to DCR.

The shared public identity covers `/callback` on HTTP `localhost`, `127.0.0.1`, or `[::1]`, with a variable loopback port. Normal callbacks still use an OS-assigned port. A different `clientName`, `clientUri`, callback path or query keeps DCR; explicitly matching identity values remain eligible. Set `oauth.clientMetadataUrl` to your own document URL for a custom identity/callback, or `false` to opt out. Documents cannot use shared secrets; the shared browser identity is never used for `client_credentials`, cross-app or private-key authentication.

Changing this option does not replace a usable stored login. Saved CIMD registrations allow only a loopback-port change during browser auth; host, scheme, path, query and issuer bindings remain enforced. To deliberately register again, use `/mcp logout <server>`. An authorization-server issuer change still requires clearing credentials; it is not silently migrated. See [OAuth configuration](OAUTH.md#client-registration-order) for details.

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

The SDK signs a fresh assertion for each token request. Keys are resolved at authentication time, never cached or added to the credential store. PEM strings must be PKCS#8 with an RS/PS/ES algorithm; EdDSA / Ed25519 use a JWK. `!command` may return PEM or JWK JSON. The same hook authenticates browser code and refresh requests when `grantType` is omitted. No keys are generated, registered or hosted for you. See [private-key options and identity rules](OAUTH.md#private-key-jwt) for details.

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

Initial enterprise sign-in, ID-token renewal, IdP client registration and keys remain user-managed. The token source is re-read when a new grant is needed; no IdP tokens, secrets or grants are added to storage. The IdP supports public or `client_secret_post` authentication, not IdP private-key JWT, SAML or a built-in login/refresh flow. Headless proxy/direct tools and manual auth use the same noninteractive path. See [cross-app configuration and limits](OAUTH.md#enterprise-cross-app-authorization).

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

The adapter owns only its client socket and closes that connection when the Pi runtime stops. `rmcp-mux` owns the upstream process, request routing, initialization cache, restart policy, client limits, and socket permissions. Start and configure the mux separately; the adapter never discovers, starts, adopts, or stops its daemon. A socket is an explicit trusted local endpoint, so do not point unrelated projects or users at a mux service unless its tools, state, credentials, and filesystem access are intended to be shared.

### Remote/headless OAuth

If Pi is running on a remote server and cannot open a local browser, start OAuth through the proxy tool. Persistent OAuth still requires an available OS credential store; on headless Linux that usually means an unlocked Secret Service/libsecret keyring. The adapter fails closed instead of falling back to plaintext credentials when the secure store is unavailable.

On Linux, if credential access fails because Pi inherited a revoked session keyring, the adapter uses a best-effort recovery path through `keyctl session - node <packaged helper>` so explicit re-authentication can write fresh credentials without killing a long-lived tmux server. This path requires `keyctl` and `node` on `PATH`; missing, locked, or otherwise unavailable credential stores still fail closed.

```js
mcp({ action: "auth-start", server: "linear-server" })
```

Open the returned authorization URL in an authenticated browser. This can be a headless browser that can reach Pi's localhost callback; the adapter does not open a browser for `auth-start`. After approval reaches the callback, complete the flow in the same Pi session without copying the callback URL or code:

```js
mcp({ action: "auth-complete", server: "linear-server" })
```

The validated callback stays in memory until explicit completion or the pending flow's five-minute timeout. Calling `auth-complete` before the callback arrives gives guidance and leaves the flow available. A denied callback reports failure without exchanging a code.

If the browser cannot reach Pi's callback (for example, Pi runs on a remote server), copy the full redirected localhost URL from the address bar even if the page fails to load:

```js
mcp({
  action: "auth-complete",
  server: "linear-server",
  args: { redirectUrl: "http://localhost:19876/callback?code=...&state=..." }
})
```

You can also pass only the `code` query parameter with `args: { code: "..." }`. Treat authorization URLs and codes as sensitive; they can grant access to the MCP server until the flow expires or completes. Callback state and issuer are checked before provider error text is displayed, as well as before code exchange.

New scope requirements are retained within the current runtime for the next permitted OAuth flow. URL-only servers also activate OAuth when their first protected catalog or tool is reached; valid saved tokens do not require another sign-in. Token scopes remain exactly what the authorization server issued. See [OAuth permission recovery](OAUTH.md#newly-required-permissions) for consent, cancellation, and transport limits.

Persistent OAuth is unsupported out of the box on Android/Termux because `@napi-rs/keyring` 1.3.0 ships no Android native binding. Use a supported platform with an OS credential store for OAuth; there is no plaintext fallback. Unauthenticated, header-token, and stdio servers remain available. See [Android/Termux OAuth limits](OAUTH.md#android--termux).

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
  "mcpServers": { }
}
```

| Setting | Description |
|---------|-------------|
| `toolPrefix` | `"server"` (default), `"short"` (strips `-mcp` suffix), `"none"`, or `"mcp"` (prefixes with `mcp__`, using server-mode normalization). Per-server `toolPrefix` overrides this for that server. |
| `idleTimeout` | Global idle timeout in minutes (default: 10, 0 to disable) |
| `requestTimeoutMs` | Global request timeout in milliseconds for live MCP calls (if omitted or `<= 0`, the MCP SDK default timeout is used) |
| `showStatusIcon` | Show the plug icon in MCP status and connection text (default: `true`). Set to `false` for plain `MCP: ...` text. |
| `mcpFooterStatus` | MCP footer verbosity: `"compact"` (default) for `MCP connected/enabled`, `"full"` for enabled/connected/disabled detail, or `"off"` to clear the persistent footer status. `/mcp status` remains available. |
| `hostConfigDiscovery` | Host-specific config policy: `"off"` (default) or `"on"` (explicitly load detected host configs as the lowest-precedence fallback) |
| `approveTools` | `true` to require approval before every MCP tool call, or an array of glob patterns such as `["github_delete_*", "notion_update_*"]`. Per-server `approveTools` overrides this. |
| `oauthDir` | Parent directory for legacy OAuth imports. Runtime uses its `fitch-mcp-adapter/` child; explicit v4 migration reads the original directory. Relative paths resolve from the active project cwd. `FITCH_MCP_OAUTH_DIR` overrides the final runtime import path; the old `MCP_OAUTH_DIR` is read only by explicit migration. Persistent credentials live in the OS credential store. |
| `mcpServers.<name>.oauth.authorizationParams` | Extra authorization URL parameters for provider-specific OAuth extensions. Flow-owned parameters such as `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `response_type`, and `resource` cannot be overridden. |
| `directTools` | Global default for all servers (default: false). Per-server overrides this. |
| `freezeDirectTools` | Keep direct-tool registration stable after the initial sync so automatic reconnects and list-change notifications do not rebuild the system prompt. Use `mcp({ action: "connect", server: "server" })` or `/mcp reconnect <server>` to refresh deliberately. Default: false. |
| `scriptMode` | Register the MCP-only `mcp_script` plain-JavaScript tool (default: true). Set to `false` to hide it. |
| `disableProxyTool` | Hide `mcp` once configured pinned tools are available. Legacy resource pins keep it available for resource access. |
| `autoAuth` | Auto-run OAuth on `connect`/tool calls when a server needs auth, then retry once (default: false). |
| `sampling` | Allow MCP servers to sample through Pi models, honoring `modelPreferences.hints` before current/default fallback (default: true when UI approval is available). |
| `samplingAutoApprove` | Skip sampling confirmation prompts. Required for sampling in non-UI sessions (default: false). |
| `elicitation` | Allow MCP servers to request user input through Pi dialogs (default: true when Pi UI is available). |
| `outputGuard` | Guard oversized MCP output: `true` (default), `false`, or `{ maxBytes, maxLines, detailsMaxBytes }`. See [Output Guard](#output-guard). |
| `trace` | Opt-in metadata-only protocol tracing. Set `{ enabled: true }` globally or `trace: true` on a server. The per-session JSONL file defaults to `.pi/fitch-mcp-adapter/traces/`; `file`, `maxBytes` (default 262144), and `maxEvents` (default 10000) can be set. Raw MCP payloads, prompts, tool arguments/results, auth data, and URLs are never persisted. |

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

When a matching tool is called from the proxy tool, a direct MCP tool, a resource call, or an MCP UI iframe, Pi asks: **Allow once**, **Allow for session**, or **Deny**. Session approvals are kept in memory only. In headless sessions, matching calls fail closed with an `approval_required` result instead of running. `excludeTools` still removes tools entirely; `approveTools` only gates visible tools at call time.

### Output Guard

Oversized MCP tool/resource results are guarded by default so a single huge response can't blow up the model context window or the session file:

- Inline text output is capped at **50 KiB / 2,000 lines** (matching Pi's built-in `bash` guard). Larger output is truncated to a head preview and the full text is saved to a temp file whose path is included in the result, so the agent can `read`/`grep` it.
- **Image content blocks pass through unchanged** — only text output is guarded. Images are delivered to the provider as native image content.
- In gateway and direct modes, `details.mcpResult` is kept raw when its JSON is **≤ 16 KiB**; larger results use a compact summary and retain the full raw JSON in a file. Scripts receive the raw result before model-facing rendering, so they can reduce it without creating an unused text preview.
- Structured data, media, resources, extra protocol fields, and oversized results include a model-visible **result reference** to the saved raw result. Tiny plain-text results remain inline without an artifact. `structuredContent` is shown even when the server also returns content blocks.

Tune the limits with the object form:

```json
{
  "settings": {
    "outputGuard": { "maxBytes": 51200, "maxLines": 2000, "detailsMaxBytes": 16384 }
  }
}
```

Set `"outputGuard": false` — or the env kill switch `MCP_OUTPUT_GUARD=0` — to disable the guard and restore raw output behavior. Recovery notices remain visible even when a configured cap is too small to fit them. Saved files are created with mode `0600` under the system temp directory (or the SDK host's `outputDirectory`) and are not cleaned up automatically; note that spilled MCP output may contain sensitive data.

Read a retained result without repeating the MCP operation:

```js
mcp({ action: "read-result", ref: "/returned/result/path", path: "/structuredContent/rows", fields: ["id", "title"], offset: 0, limit: 12000 })
```

`path` is an RFC 6901 JSON Pointer; `fields` keeps immediate keys on the selected object or each object in an array. Selection happens before paging. `offset` and `limit` count **characters in the selected, pretty-printed JSON**, starting at zero—not rows, lines, or bytes. Readback defaults to 12,000 characters and remains bounded by the output byte/line caps. Continue with `details.nextOffset` until it is `null`. Readback requires an existing adapter output artifact in this host's output directory; it never calls the server again. The same operation is available as `tools.readResult` in scripts.

### MCP Scripting

For multi-call MCP work, write ordinary JavaScript: discover, inspect, call, loop, filter, chain, or fan out, then return one result. Run that code with the default-on `mcp_script` tool. Use `mcp_search` for typed discovery, a loaded typed tool for a single call, and `mcp` for explicit gateway actions. Set `settings.scriptMode` to `false` to hide the scripting tool.

The bundled `mcp-scripting` skill is a separate Pi package resource. To hide that skill while keeping the adapter extension installed, replace the package entry in Pi settings with the object form and disable package skills:

```json
{
  "packages": [
    { "source": "npm:@fitchmultz/pi-mcp-adapter", "skills": [] }
  ]
}
```

Preserve any version pin in `source` if your existing package entry has one. You can also disable package resources through `pi config`.

First inspect candidate schemas. This script discovers and describes without executing a search hit:

```js
const found = await tools.search({ query: "search issues", server: "github" });
if (found.error) return found;
emit(found.coverage);
for (const item of found.items) {
  emit(await tools.describe({ path: item.path, server: item.server }));
}
```

After choosing a tool and checking its schema, pass ordinary JavaScript as `mcp_script`'s `code` argument:

```js
const results = [];
for (const query of ["is:open label:bug", "is:open label:docs"]) {
  const result = await tools.call("github_search_issues", { query });
  if (!result.ok) return result;
  results.push({ query, data: result.data });
}
return results;
```

The script API is:

| Method | Result |
|--------|--------|
| `tools.search({ query, server?, limit?, offset? })` | `{ items, total, hasMore, nextOffset, coverage }`; items include `path`, `name`, and `server`; discovery errors include `error` |
| `tools.describe({ path, server? })` | Complete descriptor with `path`, `server`, `name`, and the server's `inputSchema`, `outputSchema`, `title`, annotations, `_meta`, and other fields when present; failures contain `error` |
| `tools.call(path, args, server?)` or `tools.exact_flat_name(args)` | `{ ok: true, data, resultRef? }` or `{ ok: false, error: { code, message, ... }, data?, resultRef? }` |
| `tools.resources({ server, limit?, offset? })` | `{ mode: "resources", server, items, total, hasMore, nextOffset }`; failures contain `error` |
| `tools.readResource({ server, uri })` | The call envelope above, with raw resource data in `data.contents` |
| `tools.readResult({ ref, path?, fields?, offset?, limit? })` | `{ content, details }`; readback text and `details.nextOffset`, or `details.error` on failure |
| `emit(value)` / `console.log(value)` | Captured output before the final return value |

For an ambiguous flat name, call `tools.call(descriptor.name, args, descriptor.server)` using the original name and server returned by describe.

Search/resource pages default to 12 items, maximum 100. `coverage` contains `complete`, `knownServers`, and `unknownServers`. Selecting an uncached server discovers it; global search does not connect every lazy server. Script discovery does not activate typed tools. Descriptions retain JSON Schema rather than a lossy TypeScript projection.

`data` is the raw MCP result: tool calls usually return `{ content, structuredContent?, isError?, ... }`; resource reads return `{ contents, ... }`. Error results retain their raw data when available. Handle `ok: false`; ordinary call failures do not automatically stop the script. Capture failures stop dependent work, and ambiguous outcomes require provider readback instead of blindly repeating a call. Result details include a concise `calls` trace and saved result references. Reduce raw results before emitting them; the final output uses the normal output guard.

Use JavaScript loops and Promise utilities; fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided. Await every call before returning. The default timeout is 30 seconds unless the SDK host overrides it with `defaultScriptTimeoutMs`; an explicit per-script `timeoutMs` wins. Each script runs in a local worker that is terminated on timeout or cancellation, including infinite loops.

For a tool-restricted subagent, a host can allow only `mcp_script`; include the relevant exact tool names or let the script use its discovery methods. A gateway-only host can use `mcp({ action: "search", query: "..." })` without activating tools outside its allowlist. Authentication, approvals, filters, and cancellation apply to every call.

`mcp_script` is a trusted agent-authored MCP scripting layer, not an isolation boundary. The worker exposes no Node, filesystem, or network globals such as `process`, `Buffer`, or `fetch`. Run Pi in an isolated environment if you need isolation. This is local orchestration, not provider-native programmatic tool calling; it does not claim Codex native PTC support. Pi's general code-mode skill is separate and batches general Pi tools.

See the bundled `mcp-scripting` skill for the workflow and exact return shapes.

### MCP Resources

Resources are catalog entries addressed by URI, separate from tools:

```js
mcp({ action: "resources", server: "docs", limit: 12, offset: 0 })
mcp({ action: "read-resource", server: "docs", uri: "docs://guide" })
```

List first, then use the exact URI. Listings preserve the server's resource descriptor fields, including name, title, MIME type, icons, and `_meta` when supplied. `exposeResources`, include/exclude filters, disabled servers, authentication, and approval policy remain binding. Existing `read_<resource>` filter names still select resources, but these compatibility aliases are not typed functions and cannot be pinned in `/mcp`. Scripts use `tools.resources` and `tools.readResource`.

### MCP Prompts

MCP servers can advertise prompt templates alongside tools and resources. The adapter registers cached prompt definitions as Pi slash commands under `/mcp__<server>__<prompt>`, and refreshes their metadata whenever a server connects. Arguments support positional and `key=value` forms with quoting; required arguments are validated before `prompts/get` is called.

```text
/mcp__agent_board__create_plan "harden retry policy"
/mcp__agent_board__review_pipeline status=paused
/mcp prompts
```

Prompt results are flattened into one user message, preserving `[user]` and `[assistant]` role markers for multi-message results. Servers without the `prompts` capability are not probed.

### MCP Elicitation

When Pi exposes dialog-capable UI, the adapter advertises form elicitation support. Forms use Pi's stock `select()` and `input()` dialogs, validate the response, and provide a review/edit step before submission. Explicit refusal maps to MCP `decline`; dismissing a dialog maps to `cancel`.

URL mode is advertised only in TUI mode. The adapter displays the requesting server, target host, and full URL, and always requires consent before opening the browser. It also handles URL-required tool errors (`-32042`) and completion notifications; after completing the browser interaction, retry the original tool call.

### Typed Discovery and Pinned Tools

`mcp_search({ query, server?, limit?, offset? })` searches real tools and loads the matching typed functions for the next request. It defaults to five matches, with a maximum of 100 and zero-based pagination. Use a specific query, or an empty query with `server` to browse that server. It does not execute a hit or rewrite dynamic instructions into the system prompt.

Cached eligible schemas register inactive; only pins and tools selected for the current branch are active. The adapter persists canonical `{ server, tool }` selections in native Pi session entries and restores them across resume, reload, branch navigation, and working-directory changes. Host tool allowlists remain binding.

On hosts with native tool-search support, lazy tools use exact references in namespace `mcp_<server>` with the original tool name as the leaf. Existing direct pins retain their flat prefixed names. On official Pi 0.87.1, which has no native tool search, the ordinary `mcp_search` loader activates flat tools with the same discover-then-call workflow. Always use the exact reference returned by discovery rather than constructing names.

Typed tools may opt into native asynchronous execution only when both the host's pending-call API and the selected model route support it. Tools requiring configured approval, an MCP App UI, or the `beforeExecute` sequential checkpoint barrier keep ordinary awaited execution. This is separate from local `mcp_script` orchestration.

Add `directTools` to pin frequently used tools into the initial active set:

Per-server:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "directTools": true
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "directTools": ["search_repositories", "get_file_contents"]
    },
    "huge-server": {
      "command": "npx",
      "args": ["-y", "mega-mcp@latest"]
    }
  }
}
```

| Value | Behavior |
|-------|----------|
| `true` | Pin all eligible real tools from this server |
| `["tool_a", "tool_b"]` | Pin these tools (use original MCP names) |
| Omitted or `false` | No initial pins; load tools with `mcp_search` when needed (default) |

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

Set `MCP_DIRECT_TOOLS=__none__` before loading the adapter to suppress all direct-tool registration, including pins and search-driven activation. `mcp_search` can still discover schemas and report that no functions were loaded; use gateway or script calls instead. Normal tool filters, host allowlists, and disabled-server settings still apply.

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

`includeTools` and `excludeTools` filter typed tools, gateway/script discovery, resource access, and the `/mcp` panel. App-only tools stay out of the model catalog and pin choices.

Active schemas consume context; inactive cached schemas do not. Pin the tools you routinely need and discover the rest as the task requires.

Valid cached descriptors avoid startup connections. Missing or stale metadata for configured pins is discovered intentionally at startup; eager and keep-alive servers also connect as configured. An empty cache does not trigger discovery of every lazy server. Search coverage reports which configured servers are still unknown.

MCP catalog notifications and reconnects refresh eligible metadata. Removed tools leave the active set. `settings.freezeDirectTools: true` keeps the automatic registered surface stable after initial sync; deliberate `mcp({ action: "connect", server: "name" })` or `/mcp reconnect <server>` refreshes remain available.

Run `/mcp` to see known tools, pinned counts, resource counts, and connection state. Uncached servers say **undiscovered**. Expand a server to pin or unpin real tools; resources have no checkboxes and use the resource actions instead. Pin changes apply to the current session and persist through `directTools`. Discovered session selections are separate from these startup pins: unpinning leaves a tool active if discovery already selected it for the current branch. Press Enter on a server that needs auth or `ctrl+a` on an OAuth server to authenticate; `ctrl+r` reconnects. Broader setup changes still use Pi's normal reload flow.

**Guided first-run setup:** Run `/mcp setup` to inspect detected shared MCP files, adopt compatibility imports from other hosts, open discovered config paths, preview exact before/after file diffs for writes, scaffold a minimal project `.mcp.json`, add a curated known server (DeepWiki, Context7, Notion, GitHub, or Chrome DevTools), or quick-add RepoPrompt into a standard/shared MCP file.

**Subagent integration:** If you use the subagent extension, agents can request direct MCP tools in their frontmatter with `mcp:server-name` syntax. See the subagent README for details.

### MCP UI Integration

MCP servers can ship interactive UIs via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). The adapter uses MCP Apps 2.0.0 with the split MCP SDK 2.0.0 runtime. When you call a tool that has a UI resource, the adapter opens it in a native macOS window via [Glimpse](https://github.com/hazat/glimpse) if available, otherwise falls back to the browser.

**How it works:**

1. Agent calls a tool like `launch_dashboard`
2. The tool's metadata includes `_meta.ui.resourceUri` pointing to a UI resource
3. The adapter fetches the UI HTML and opens it in an iframe
4. The UI can call MCP tools and send messages back to the agent

**Native rendering:** On macOS, if [Glimpse](https://github.com/hazat/glimpse) is installed (`pi install npm:glimpseui`), UIs open in a native WKWebView window instead of a browser tab. Set `MCP_UI_VIEWER=browser` to force the browser, `MCP_UI_VIEWER=glimpse` to require native rendering, or `MCP_UI_VIEWER=none` (also accepts `off` / `disabled`) to suppress the window entirely — the tool still runs and its inline result is returned to the agent, but no browser or native window opens. This is useful for headless setups, CI, or users who want the tool output delivered inline as text only. When suppressed, a one-line info notification shows the UI URL so it can still be opened manually if needed.

**Bidirectional communication:** The UI talks back. When it sends a prompt or intent, the message is stored and `triggerTurn()` wakes the agent. The agent retrieves messages via `mcp({ action: "ui-messages" })` and responds, enabling conversational UIs where the app and agent collaborate in real-time.

**Session reuse:** When the agent calls the same tool again while its UI is already open, the adapter pushes the new result to the existing window instead of replacing it. This enables live updates — the agent can refine a chart, add data, or respond to user input without losing the current view. Different tools still replace the session as before.

**Message types from UI:**

| Type | Purpose |
|------|---------|
| `prompt` | User message that triggers an agent response |
| `intent` | Structured action with name + params |
| `notify` | Fire-and-forget notification |
| `message` | Generic message payload |
| (custom) | Any other type forwarded as intent |

**Retrieving UI messages:**

```
mcp({ action: "ui-messages" })
```

Returns accumulated messages from UI sessions. Each message includes `type`, `sessionId`, `serverName`, `toolName`, and `timestamp`. Prompt messages include `prompt`, intent messages include `intent` and `params`.

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
  "mcpServers": { }
}
```

Supported compatibility imports: `cursor`, `claude-code`, `claude-desktop`, `opencode`, `vscode`, `windsurf`, `codex`

`fitch-mcp-adapter init` detects these host-specific configs and adds missing imports to the adapter-owned global config for you. The `opencode` import reads OpenCode V1 `mcp` entries from both `~/.config/opencode/opencode.json` and the project `opencode.json`, with project fields taking precedence. It is explicit-import only; OpenCode V2, inline content, managed configs, and remote discovery are not supported.

### Project Config

Prefer `.mcp.json` for project-local shared MCP config. Use `.pi/fitch-mcp-adapter/mcp.json` only when you need an adapter-specific project override. Project files override both user-global shared MCP config and Pi global overrides.

## Usage

| Action | Example |
|--------|---------|
| Discover and load typed tools | `mcp_search({ query: "screenshot", server: "chrome-devtools", limit: 5 })` |
| Status | `mcp({ action: "status" })` |
| List server tools | `mcp({ action: "list", server: "name", limit: 12, offset: 0 })` |
| Search without activation | `mcp({ action: "search", query: "screenshot navigate", limit: 12 })` |
| Describe | `mcp({ action: "describe", tool: "tool_name", server: "name" })` |
| Instructions | `mcp({ action: "instructions", server: "name" })` |
| Call | `mcp({ action: "call", tool: "tool_name", args: { key: "value" } })` |
| Connect or refresh | `mcp({ action: "connect", server: "name", limit: 12, offset: 0 })` |
| List resources | `mcp({ action: "resources", server: "name" })` |
| Read resource | `mcp({ action: "read-resource", server: "name", uri: "docs://guide" })` |
| Read saved result | `mcp({ action: "read-result", ref: "/returned/result/path", path: "/structuredContent" })` |
| UI messages | `mcp({ action: "ui-messages" })` |
| Auth start | `mcp({ action: "auth-start", server: "name" })` |
| Auth complete | `mcp({ action: "auth-complete", server: "name" })` after the browser callback, or supply `args: { redirectUrl: "..." }` |

`action` is required. Search requires `query`; describe/call require `tool`; list/connect/instructions/resources/auth require `server`; resource reads require `server` and `uri`; saved-result reads require `ref`. Pass object `args`. Optional `server` disambiguates tool calls and descriptions.

`connect` refreshes an already connected server, including tools, resources, prompts, and instructions. Server-scoped discovery connects that server if its catalog is unknown. Global search uses known catalogs and returns `coverage: { complete, knownServers, unknownServers }`; partial coverage is never presented as an exhaustive result. Gateway search provides schemas without activating functions, so it works for gateway-only hosts.

Search ranks names, descriptions, and parameter guidance using MiniSearch. Catalog pages use item offsets: gateway/script search and lists default to 12, while `mcp_search` defaults to 5; maximum 100. Follow the returned `nextOffset`. Saved-result readback uses character offsets instead.

An exact, case-sensitive public tool name ranks before lexical matches; with `server`, an exact original tool name also ranks first within that server. Unscoped original names do not select an account. All remaining matches retain MiniSearch order. Search continuation and retry calls preserve their entry point: `mcp_search` loads the next page, while gateway search remains metadata-only.

Describe preserves the complete server descriptor, including JSON Schemas, annotations, `_meta`, and extensions when present. Search and typed-tool discovery exclude app-only tools and resources. Legacy hyphen/underscore matching remains a compatibility convenience; ambiguous names require an explicit server rather than executing an arbitrary match. Use the exact names returned by discovery.

The gateway description stays stable as catalogs and credentials change. Server instructions are available through `action: "instructions"` and previews in server listings, rather than injected dynamically into the prompt.

Gateway and typed-tool results render compactly in the terminal: long text shows the first three terminal-wrapped lines with Pi's `app.tools.expand` hint. Expanding reveals the guarded result. Structured data and saved-result references remain visible to the model.

## Commands

| Command | What it does |
|---------|--------------|
| `/mcp` | Interactive panel and first-run onboarding surface |
| `/mcp setup` | Guided setup for imports, a minimal `.mcp.json`, curated known servers, RepoPrompt quick-add, and config-path inspection |
| `/mcp tools` | List discovered real tools, excluding resource aliases |
| `/mcp status` | Show connection state and separate tool/resource counts |
| `/mcp prompts` | List all MCP prompts registered as slash commands |
| `/mcp reconnect` | Reconnect all servers |
| `/mcp reconnect <server>` | Connect or reconnect a single server |
| `/mcp disable <server>` | Disable a server in the project-local `.pi/fitch-mcp-adapter/mcp.json` (requires `/reload` to apply) |
| `/mcp enable <server>` | Enable through the project-local override layer (requires `/reload` to apply) |
| `/mcp logout <server>` | Clear stored OAuth credentials for a server and disconnect it |
| `/mcp-auth` | Open an OAuth server picker in interactive UI sessions |
| `/mcp-auth <server>` | OAuth setup for a specific server |

If `settings.autoAuth` is `true`, `mcp({ action: "connect", server: "..." })`, gateway calls, and typed/script tool calls may run OAuth when needed, with at most one automatic auth attempt per invocation and one post-auth retry. Browser authorization requires an interactive host. Auth-only replacement preserves accepted work on the old client; ordinary `/mcp reconnect` and panel `ctrl+r` remain hard resets.

In interactive sessions, you can also authenticate from `/mcp` with `ctrl+a` or Enter on a server that needs auth. In remote/headless sessions, use the proxy tool's `auth-start` and `auth-complete` actions. Complete without arguments when the browser reaches Pi's callback, or paste the redirect URL when it cannot. `/mcp-auth` without a server only opens a picker in the interactive UI.

### MCP output schemas

Advertised tool `outputSchema` values support JSON Schema draft-07 and 2020-12. Unstamped schemas use the SDK's 2020-12 default. Returned `structuredContent` is validated against the advertised schema for both proxy and direct-tool calls. Any JSON structured value—including `null`, `false`, and `0`—is rendered as text, including alongside non-empty content or images. The raw result remains available for script reduction and saved-result readback.

## How It Works

- Stable `mcp_search`, `mcp`, and optional `mcp_script` entry points; full typed schemas load when selected
- Lazy servers connect on selected discovery or calls; configured pins and eager/keep-alive servers can bootstrap intentionally
- Tool metadata is cached to disk so search/list/describe work without live connections
- Idle servers disconnect after 10 minutes (configurable), reconnect automatically on next use
- npx-based servers resolve to direct binary paths, skipping the ~143 MB npm parent process
- Pi validates loaded typed-tool arguments against their schemas; gateway and script arguments are validated by the MCP server
- Keep-alive servers get health checks and auto-reconnect
- `directTools` pins initial tools; search-driven selections persist separately on the native session branch
- Resources use explicit URI-based listing and reading, without synthetic function definitions

## Limitations

- Cross-session server sharing not yet implemented (each Pi session runs its own server processes)
- Compact MCP result rendering summarizes text, but inline images are still controlled by Pi's image display settings and may render below the compact text summary.
- MCP sampling support is text-only; context inclusion, tools, stop sequences, audio, and image content are rejected with explicit errors.
