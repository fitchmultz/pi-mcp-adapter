# Upgrading the MCP adapter

[Install the current package](../README.md#start-here). For pre-v5 state, follow the migration steps below **before restarting Pi**.

## Upgrading from v5

Version 6 keeps v5's package, config paths, and OAuth namespace. No credential migration is needed.

- Use `mcp_search({ query: "...", server: "name" })` to discover and load typed tools. It loads matches for the next request; it never executes a search hit. `directTools` now pins tools at startup rather than deciding which tools can ever be loaded.
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

Migration copies v4's global `mcp.json`, `mcp-cache.json`, `mcp-onboarding.json` and `mcp-npx-cache.json` into `<Pi agent dir>/fitch-mcp-adapter/`, and the current project's `.pi/mcp.json` into `.pi/fitch-mcp-adapter/mcp.json`. Existing destinations are reported and left unchanged, without merging. Repeat in each project that has an old override. Use the same `PI_CODING_AGENT_DIR` as your Pi installation.

For configured HTTP servers, migration copies an existing OAuth entry from the old OS credential namespace or legacy token file only when the new namespace has no entry. It preserves URL/issuer bindings, client registration and tokens, verifies the copy, and never prints plaintext credentials. All old sources remain untouched. A configured `settings.oauthDir` uses a `fitch-mcp-adapter/` child directory during normal operation, keeping the original import files separate. Dry-run lists file actions without reading the keychain or writing anything; repeated migration skips already-copied destinations.

Normal startup never falls back to old adapter-owned defaults or the old credential namespace, so logout cannot resurrect old credentials. Migration copies an existing provider grant; it does not create an independent grant. Sign in again if you need a separate provider grant. Shared standard MCP files and explicit `configPath`/imports retain their behavior. See [OAuth storage](../OAUTH.md#token-storage).

