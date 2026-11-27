# Upgrading the MCP adapter

[Install the current package](../README.md#install). For pre-v5 state, follow the migration steps below **before restarting Pi**.

## Upgrading to v9

- Direct and deferred catalog MCP tools in Pi `codemode` now match Pi's built-in MCP extension: `await tools.<flat_name>(args)` always resolves to the untruncated `CallToolResult` object (`{ content, structuredContent?, isError? }` with `_meta` stripped) rather than display text (for schema-less tools) or bare `structuredContent` / `mcpAdapter` omission receipts (for schema-ful tools). Update scripts that previously treated schema-less direct tool calls as strings (`res.split(...)` -> `res.content[0].text.split(...)`) or read top-level fields off schema-ful direct tool calls (`res.rows` -> `res.structuredContent.rows`). Non-provider direct-tool failures (such as `approval_required`, `auth_required`, or `server_disabled`) now reject with an `Error` in codemode.
- Model-facing tool results render `structuredContent` as fallback text only when `content` has no visible blocks, matching Pi's built-in MCP extension and eliminating duplicate JSON output from spec-compliant servers. `structuredContent` remains intact in codemode `CallToolResult` values and retained `resultRef` artifacts.

## URL-scoped OAuth credentials

OAuth storage keys include the configured server name and exact URL. Existing name-only entries in the current credential service are imported automatically only when their stored URL matches. The adapter verifies the scoped copy before removing the matching source. An existing scoped login wins, and records with missing or different URLs stay untouched. Logout removes only that name and URL's login and matching automatic-import sources.

## Upgrading from 8.0.34

Releases after 8.0.34 remove `mcp_script`, the bundled `mcp-scripting` skill, the `scriptMode` setting, and the `defaultScriptTimeoutMs` factory option. Use Pi's `codemode` tool for loops and dependent calls: its scripts call deferred typed tools directly and reach gateway actions, including `read-result` and `read-resource`, through `tools.mcp`. The adapter ignores a leftover `scriptMode` setting and no longer reads `defaultScriptTimeoutMs`; remove both. A package entry that hid the skill with `"skills": []` keeps working.

## Upgrading from 8.0.33 or earlier

8.0.34 removes `mcp_search`. Pi's native `tool_search` loads deferred typed tools, Pi's transcript decides which loaded tools a branch declares, and the adapter no longer writes `mcp-tool-selection` session entries (existing entries are ignored). The `mcp` gateway is active whenever it is registered; `disableProxyTool` still hides it once configured pins are available. The adapter activates a registered `tool_search` when it registers deferred tools, unless the branch recorded removing it. Catalog tools that a server drops are re-registered hidden, and a tool that loses its pin leaves the active set. A pin you deselect stays off when the branch resumes or its server drops and restores the tool, unless the session's tool selection names it.

## Upgrading from v5

Version 6 keeps v5's package, config paths, and OAuth namespace. No credential migration is needed.

- Typed tools register as deferred Pi tools; Pi's native `tool_search` loads them for the next request and `codemode` calls them directly. `directTools` now pins tools at startup rather than deciding which tools can ever be loaded.
- Give every new gateway call an explicit `action`: `mcp({ action: "search", query: "..." })`, `mcp({ action: "describe", tool: "..." })`, or `mcp({ action: "call", tool: "...", args: {} })`. Arguments are objects. Stored v5 calls with optional mode fields or JSON-string arguments are normalized at the ingress compatibility boundary; they are not the advertised v6 interface.
- Resources use `resources` and `read-resource` actions, or `tools.resources` and `tools.readResource` in scripts. Generated `read_<resource>` aliases remain callable through gateway/script compatibility, but no longer appear as functions or panel checkboxes. Remove resource aliases from `directTools`; legacy resource pins keep the gateway available even with `disableProxyTool: true`.
- Script descriptions always return complete JSON Schema in `inputSchema`, with `outputSchema` and other descriptor fields when supplied. Replace `inputTypeScript` consumers. Calls keep raw MCP results, including error-result data; use returned result references for bounded readback without another server call.
- Global search reports partial catalog coverage instead of starting every uncached lazy server. Select a server to discover it. Cache format 2 preserves raw descriptors and still reads format 1; downgrading to v5 ignores format 2 and requires rediscovery.

## Upgrading from v4

Current installations use `@fitchmultz/pi-mcp-adapter`, adapter-owned state paths, and the `fitch-mcp-adapter.oauth` credential namespace. Remove any previous adapter entry from Pi settings before installing the current package. Keep only one adapter loaded in a Pi host.

After installation, **before restarting Pi**, run from your project directory:

```bash
fitch-mcp-adapter migrate --dry-run
fitch-mcp-adapter migrate
```

If Pi's package bin is not on your `PATH`, use `npx --package @fitchmultz/pi-mcp-adapter fitch-mcp-adapter migrate` (append `--dry-run` to preview).

Migration copies v4's global `mcp.json`, `mcp-cache.json`, `mcp-onboarding.json` and `mcp-npx-cache.json` into `<Pi agent dir>/fitch-mcp-adapter/`. Existing destinations are reported and left unchanged, without merging. Use the same `PI_CODING_AGENT_DIR` as your Pi installation.

`<Pi agent dir>/mcp.json` and project `.pi/mcp.json` are owned by Pi as its standard native MCP configs and are read read-only by the adapter (once trusted for project `.pi/mcp.json`), so `fitch-mcp-adapter migrate` leaves both untouched. Because native Pi and the adapter now read `<Pi agent dir>/mcp.json` and `.pi/mcp.json` read-only, move or remove any retired pre-v5 adapter-format file at those paths once migrated: files with top-level adapter keys (`settings`, `imports`) and entries with adapter-only fields (`disabled`, `directTools`, `socket`, etc.) are skipped with a warning, while plain `{ "mcpServers": { ... } }` entries share native Pi's format and would otherwise continue loading from `<Pi agent dir>/mcp.json` ahead of `<Pi agent dir>/fitch-mcp-adapter/mcp.json`.

For configured HTTP servers, migration first promotes any matching current-service name-only or current plaintext credential and reports it as existing. Otherwise, migration copies an entry from the old OS credential namespace or legacy token file only when its stored URL exactly matches the configured URL. It preserves URL/issuer bindings, client registration and tokens, verifies the copy, and never prints plaintext credentials. Historical sources remain untouched; promoted current sources are removed after verification. A configured `settings.oauthDir` uses a `fitch-mcp-adapter/` child directory during normal operation, keeping the original import files separate. Dry-run lists file actions without reading the keychain or writing anything; repeated migration skips already-copied destinations.

Normal startup never falls back to old adapter caches, onboarding state, npx cache, or the old credential namespace (`mcp-cache.json`, `mcp-onboarding.json`, `mcp-npx-cache.json`, `mcp-oauth/`, or `pi-mcp-adapter.oauth`), so logout cannot resurrect old credentials. `<Pi agent dir>/mcp.json` and trusted project `.pi/mcp.json` are read read-only only as native Pi's standard configs; adapter writes continue to go to `<Pi agent dir>/fitch-mcp-adapter/mcp.json` and `.pi/fitch-mcp-adapter/mcp.json`. Migration copies an existing provider grant; it does not create an independent grant. Sign in again if you need a separate provider grant. Shared standard MCP files and explicit `configPath`/imports retain their behavior. See [OAuth storage](../OAUTH.md#token-storage).
