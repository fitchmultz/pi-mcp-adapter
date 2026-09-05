# OAuth 2.1 Authentication for MCP

This document describes the OAuth 2.1 + PKCE authentication implementation for the Pi MCP Adapter using the official MCP SDK.

## Overview

The Pi MCP Adapter uses the official MCP SDK's built-in OAuth implementation, which provides:

- **Automatic OAuth endpoint discovery** (RFC 9728) - No manual configuration needed
- **Client ID Metadata Documents (CIMD)** - Shared public browser identity without per-server registration
- **Dynamic client registration** (RFC 7591) - Native fallback when CIMD is unavailable
- **Automatic callback handling** - Built-in HTTP server handles callbacks automatically
- **Automatic token refresh** - SDK handles token refresh transparently
- **Enterprise cross-app authorization** - Native OIDC ID-token exchange and JWT-bearer MCP grants, without an MCP browser flow

## Features

- ✅ **PKCE (S256)** - Mandatory code challenge method for OAuth 2.1
- ✅ **Automatic Callback Server** - Local browser redirects automatically when available
- ✅ **Manual Remote Flow** - Copy auth URLs and pasted redirect URLs/codes for headless SSH sessions
- ✅ **Client ID Metadata Documents** - Uses the shared identity for compatible browser clients
- ✅ **Dynamic Client Registration** - Registers when no configured/stored client or eligible CIMD is available
- ✅ **Auto-Discovery** - Discovers OAuth endpoints from server metadata
- ✅ **Automatic Token Refresh** - SDK handles expired tokens automatically
- ✅ **State Parameter Validation** - CSRF protection
- ✅ **Secure Token Storage** - Persistent OAuth entries are stored in the operating system credential store

## Configuration

### Minimal Configuration (Recommended)

For most MCP servers, you only need the URL:

```json
{
  "mcpServers": {
    "my-oauth-server": {
      "url": "https://api.example.com/mcp"
    }
  }
}
```

OAuth is automatically enabled for HTTP servers. The SDK will:
- Auto-detect if the server requires OAuth
- Discover OAuth endpoints from the server
- Reuse a configured/stored client, use CIMD when supported, or register dynamically
- Handle the entire OAuth flow including callback

### Optional Configuration

You can optionally provide a pre-registered client:

```json
{
  "mcpServers": {
    "my-oauth-server": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "scope": "read write",
        "authorizationParams": { "access_type": "offline", "prompt": "consent" },
        "redirectUri": "http://localhost:3118/callback"
      }
    }
  }
}
```



### Configuration Options

- `url` - The MCP server URL (required)
- `auth` - Set to `"oauth"` to force OAuth, `false` to disable, or omit to auto-detect
- `oauth.grantType` - `"authorization_code"` (default, browser flow) or `"client_credentials"` (non-interactive)
- `oauth.clientId` - Pre-registered client ID (optional; takes priority over stored clients, CIMD and DCR)
- `oauth.clientSecret` - Client secret for confidential clients (optional)
- `oauth.privateKeyJwt` - Private-key client authentication instead of `clientSecret`; see [Private-key JWT](#private-key-jwt)
- `oauth.crossAppAccess` - Enterprise OIDC ID-token exchange; selects the JWT-bearer grant without `grantType`. See [Cross-app authorization](#enterprise-cross-app-authorization).
- `oauth.scope` - Requested OAuth scopes (optional)
- `oauth.authorizationParams` - Extra authorization URL parameters for provider-specific extensions, such as Google's `{ "access_type": "offline", "prompt": "consent" }`. Flow-owned parameters like `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `response_type`, and `resource` cannot be overridden.
- `oauth.redirectUri` - Exact browser callback URI to advertise and bind, such as `http://localhost:3118/callback` (optional)
- `oauth.clientName` - Client display name used for dynamic registration (optional, defaults to `Pi Coding Agent`)
- `oauth.clientUri` - Client homepage URI used for dynamic registration (optional)
- `oauth.clientMetadataUrl` - Custom HTTPS Client ID Metadata Document URL, or `false` to opt out for new registrations. Supports `${VAR}` and `$env:VAR` interpolation. URLs require a non-root path and must not contain userinfo, fragments or dot segments.
- `oauth.skipIssuerMetadataValidation` - Skip only the SDK's metadata issuer-echo check for a known incompatible authorization server (default: `false`). This weakens metadata validation; prefer correcting the provider's metadata.

Dynamic clients normally omit `oauth.redirectUri`; the adapter starts the callback server lazily on the default loopback host (`localhost`) and asks the OS for an available local port when auth begins. Use `oauth.redirectUri` when the provider requires a pre-registered callback, such as Slack MCP's Claude-compatible `http://localhost:3118/callback`. The URI must use `http://` with `localhost`, `127.0.0.1`, or `[::1]`, include an explicit port, and its host/path become the bound callback endpoint.

### Client registration order

The SDK selects a client in this order:

1. Configured `oauth.clientId` (and `clientSecret` or `privateKeyJwt`, when needed).
2. A usable stored registration for this server and issuer.
3. An eligible metadata document URL when the authorization server advertises `client_id_metadata_document_supported: true`.
4. Dynamic client registration, when supported.

The default document is [Pi MCP Adapter](https://fitchmultz.github.io/pi-mcp-adapter/client-metadata.json), with homepage `https://github.com/fitchmultz/pi-mcp-adapter`. It describes a native public browser client using `authorization_code`, `refresh_token` and token authentication method `none`. The authorization server fetches and validates the document; the adapter does not download or availability-check it.

The shared identity covers HTTP loopback `/callback` redirects on `localhost`, `127.0.0.1` and `[::1]`. The document's listed port represents native loopback port variation, not a fixed runtime port. The adapter still asks the OS for a port unless an exact callback or static client is configured. Scheme, host, path and query must match; there are no wildcard callback paths.

Explicit `clientName` or `clientUri` values matching the shared document remain eligible. Different values, custom callback paths/queries and configured shared secrets keep their existing registration path. To use a different public identity or callback, host your own matching document and set `oauth.clientMetadataUrl` to its HTTPS URL. A custom document must describe the actual grants, redirect URIs and authentication method. Shared-secret CIMD is not supported.

Set `oauth.clientMetadataUrl: false` to disable CIMD for new registrations. Changing the URL or setting `false` does not migrate an existing login: usable stored clients keep priority. Use `/mcp logout <server>` before authenticating if you want to replace that registration deliberately. If the authorization server advertises CIMD but rejects the document or cannot fetch it, the error is surfaced; the SDK does not guarantee a DCR fallback for that rejection.

### Non-Interactive `client_credentials`

For machine-to-machine OAuth, configure `grantType: "client_credentials"`.

```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "grantType": "client_credentials",
        "clientId": "service-client-id",
        "clientSecret": "service-client-secret",
        "scope": "read write"
      }
    }
  }
}
```

This flow does not open a browser or use callback handling. `oauth.redirectUri` is ignored for `client_credentials`; `oauth.clientName` and `oauth.clientUri` still apply to dynamic client registration metadata. The shared browser document is never selected, even when its URL is explicitly configured. A custom `clientMetadataUrl` without a shared secret can identify a noninteractive client if the authorization server accepts its document and authentication method. Configured client-credentials clients advertise the native `io.modelcontextprotocol/oauth-client-credentials` extension, including on auth-discovery requests.

### Private-key JWT

Set `oauth.privateKeyJwt` to authenticate native token requests with `private_key_jwt` instead of a shared secret:

```json
{
  "grantType": "client_credentials",
  "clientId": "registered-service-client",
  "privateKeyJwt": {
    "privateKey": "!cat /path/to/user-managed-private-key.pem",
    "algorithm": "ES256"
  }
}
```

| Option | Meaning |
| --- | --- |
| `privateKey` | PKCS#8 PEM string, JWK object or JWK JSON string. Strings support `${VAR}`, `$env:VAR`, `{env:VAR}` and existing `!command` / `!!` conventions, resolved only when authenticating. |
| `algorithm` | Required asymmetric JOSE algorithm. Native PEM import supports RS, PS and ES families; EdDSA / Ed25519 require a JWK. The SDK validates supported key/algorithm combinations. HMAC (`HS*`) and `none` are not private-key authentication. |
| `audience` | Optional nonempty JWT audience string; defaults to the discovered authorization-server issuer, then token URL. It does not change the request destination. |
| `lifetimeSeconds` | Optional positive integer; native default is 300 seconds. |
| `claims` | Optional object of additional JWT claims. Native `iss`, `sub`, `aud`, `iat`, `exp` and `jti` take precedence over overlapping entries. |

Keys must belong to an externally registered `clientId`, or a custom `clientMetadataUrl` whose document describes `private_key_jwt` and provides the matching public verification key. The SDK signs issuer and subject as the actual selected client ID. Configured and usable stored clients retain their existing priority. If a previous login uses the shared method-`none` browser identity or a shared secret, private-key authentication fails before key resolution instead of silently migrating or erasing that login. `clientSecret` and `privateKeyJwt` cannot be configured together. The shared Pi document cannot identify a private-key client. Explicit pre-registration and opaque DCR client IDs are not classified as shared CIMD merely because their strings resemble a document URL.

Omit `grantType` (or use `authorization_code`) for private-key authentication on browser code and refresh requests; existing PKCE, callbacks and issuer validation still apply. Client-credentials requests use `grant_type=client_credentials` plus a signed client assertion, not a JWT-bearer grant. Native scope precedence is unchanged: explicit `/mcp-auth` applies configured scope, while ordinary transport authentication can prefer a server challenge or protected-resource scope. This feature does not change scope step-up or retry policy.

Each actual token authentication re-resolves the key source and signs a fresh assertion. The existing command timeout/output limits apply. A local command, key or signing failure produces a non-disclosing error without retrying, deleting stored credentials or opening browser consent. Private keys and assertions are not added to stored client information, tokens or client metadata. There is no key provisioning, rotation service, key/assertion cache or extra credential store. The native signer has no custom header or `kid` option; a JWK's `kid` is not copied into the assertion header.

### Enterprise cross-app authorization

`oauth.crossAppAccess` exchanges an existing OIDC ID token at an enterprise identity provider (IdP), then uses the returned ID-JAG (JWT authorization grant) at the MCP authorization server. Configure:

```json
{
  "clientId": "registered-mcp-client",
  "privateKeyJwt": { "privateKey": "${MCP_PRIVATE_KEY}", "algorithm": "ES256" },
  "crossAppAccess": {
    "idpUrl": "https://idp.example.com",
    "clientId": "registered-idp-client",
    "idToken": "!your-id-token-command",
    "clientSecret": "${IDP_CLIENT_SECRET}"
  }
}
```

The outer `clientId` and `privateKeyJwt` (or `clientSecret`) authenticate to the MCP authorization server. The nested `clientId` and optional `clientSecret` authenticate only to the IdP; omit the nested secret for a public IdP client. A custom `clientMetadataUrl` may replace the outer client ID for public or private-key authentication when accepted by the MCP authorization server. The shared browser document is never selected or reused for this mode. Existing usable registrations and issuer bindings keep their normal priority; incompatible saved shared-browser registrations fail without being erased.

All four nested strings support `${VAR}`, `$env:VAR`, `{env:VAR}`, `!command` and `!!` conventions and are resolved only when acquiring an ID-JAG, not during config inspection or discovery-only probing. Obtain and renew the OIDC ID token outside the adapter. No initial enterprise login, SAML exchange, IdP refresh-token flow, IdP private-key/basic authentication, scheduler, key provisioning or separate credential store is provided. The native IdP helper uses public or `client_secret_post` authentication.

Omit `grantType`; explicitly combining it with `crossAppAccess` is an error. The SDK discovers and validates the MCP authorization-server issuer and protected-resource URL before the IdP exchange. There is no user-supplied audience/resource override. IdP discovery is strict and requires valid OAuth/OIDC metadata; `skipIssuerMetadataValidation` does not relax the IdP check. Resource-server headers and MCP client credentials are not forwarded to the IdP. Only the final MCP access tokens and normal client registration enter the existing credential store.

This flow opens no browser and binds no callback, including through `auth-start`, `/mcp-auth`, and headless proxy/direct tools. Native scope precedence and retry bounds remain unchanged. An IdP/source failure gives a safe setup error without erasing the MCP login or entering browser consent. Cancellation aborts IdP and MCP token HTTP requests; stopping one modern request does not stop concurrent requests sharing the connection. Auth-only connection retirement still drains accepted operations.

## Usage

### Step 1: Authenticate

Run the `/mcp-auth` command with the server name:

```
/mcp-auth my-oauth-server
```

Manual `/mcp-auth` is the default flow. With `settings.autoAuth: true`, proxy/direct/script tool execution may authenticate when a server needs auth or rejects a call for insufficient scope. Browser authorization still requires an interactive host, and each invocation gets at most one automatic auth attempt and one post-auth retry. Initial sign-in does not grant a second automatic consent attempt in the same invocation.

For browser authorization, this will:
1. Start the callback server lazily on an OS-assigned local port, or on the exact `oauth.redirectUri` port for pre-registered callbacks
2. Discover OAuth endpoints automatically
3. Select a configured/stored client, CIMD, or dynamic registration
4. Open your browser for authentication
5. Wait for the automatic callback
6. Complete the OAuth flow
7. Store tokens securely

### Remote/headless authentication

When Pi runs over SSH or in a headless environment, use the proxy tool to retrieve the authorization URL instead of relying on OS browser launch:

```
mcp({ action: "auth-start", server: "my-oauth-server" })
```

Open the returned URL in your local browser. After approval, copy the full redirected localhost URL from the browser address bar (the page may fail to load locally) and complete the same pending auth flow:

```
mcp({
  action: "auth-complete",
  server: "my-oauth-server",
  args: { redirectUrl: "http://localhost:19876/callback?code=...&state=..." }
})
```

You can also pass only the `code` query parameter with `args: { code: "..." }`. JSON-string args remain supported. Redirect URL completion validates the saved OAuth state; raw code completion is available for providers that display a code directly.

### Newly required permissions

A Streamable HTTP server can request additional scopes when a tool, resource, prompt, or catalog needs more permission. The adapter keeps that request in the current runtime and includes it in the next permitted automatic or manual OAuth flow. A wider request uses fresh consent rather than refreshing the old, narrower grant. Already-open authorization URLs and PKCE verifiers stay unchanged; later requirements wait for the next flow. Cancellation retains permission intent, while logout and runtime shutdown clear it.

URL-only servers can first require OAuth during catalog discovery or a later tool call. The adapter activates its provider once after that challenge, so valid stored tokens work without another sign-in, even with `autoAuth` off. Fully public servers do not read the credential store just to connect.

Requested scopes are not granted scopes: stored token fields come only from the authorization server. Missing or narrower token scopes are not filled in, and only a successful operation proves access. Native token refresh and machine-to-machine retry limits remain unchanged. This recovery covers both wire revisions over Streamable HTTP; deprecated SSE behavior is unchanged.

Auth-only connection replacement lets accepted native operations finish on the old client. Ordinary `/mcp reconnect`, panel `ctrl+r`, logout, and shutdown keep their existing reset behavior.

### Step 2: Use the Server

Once authenticated, use the server normally:

```
mcp({ server: "my-oauth-server" })
mcp({ tool: "my-tool", args: { key: "value" } })
```

The SDK automatically:
- Adds the access token to requests
- Refreshes expired tokens automatically
- Re-authenticates if tokens are invalid

To clear stored OAuth credentials and force a fresh authorization:

```
/mcp logout my-oauth-server
```

## How It Works

### Authentication Flow

```
┌─────────┐     ┌──────────────┐     ┌─────────────────┐
│   Pi    │────▶│  MCP Server  │────▶│  OAuth Server   │
│         │     │              │     │                 │
│ 1. Init │     │ 2. Discovery │     │ 3. Register     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 4. Auth URL     │
│         │     │              │     │                 │
│         │────▶│  Callback    │◀────│ 5. Browser      │
│         │     │  Server      │     │    Redirect     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 6. Code         │
│         │     │              │     │                 │
│         │────▶│              │────▶│ 7. Exchange     │
│         │     │              │     │                 │
│         │◀────│              │◀────│ 8. Tokens       │
└─────────┘     └──────────────┘     └─────────────────┘
```

### Auto-Discovery

The SDK attempts to discover OAuth endpoints using:

1. **RFC 9728 Metadata** - Fetches `/.well-known/oauth-protected-resource`
2. **WWW-Authenticate Header** - Parses `resource_metadata` from 401 responses

### Dynamic Client Registration

If no configured/stored client or eligible CIMD is selected, the SDK:

1. Discovers the registration endpoint from OAuth metadata
2. Registers a new client with:
   - `client_name`: configured `oauth.clientName` or "Pi Coding Agent"
   - `client_uri`: configured `oauth.clientUri` or the adapter repository URL
   - `redirect_uris`: `["http://localhost:<active-callback-port>/callback"]`, or the configured `oauth.redirectUri`
   - `grant_types`: `["authorization_code", "refresh_token"]`
3. Stores the registered client credentials and the redirect URIs returned by the authorization server

When browser auth starts, cached DCR client info with tokens is re-registered if its stored redirect URIs are missing or do not include the current redirect URI. Saved CIMD registrations also allow a port-only change on the same HTTP loopback host/path/query, preserving their refresh tokens across restarts. URL-shaped DCR IDs do not get this exception. Missing or malformed redirect lists still invalidate the registration and tokens. Token refresh outside browser-auth startup does not perform this redirect check.

### Callback Server

A Node.js HTTP server runs on a loopback callback endpoint and handles the active callback path:

- Dynamic registration starts the callback server only when auth begins, binds the default host `localhost`, and asks the OS for an available local port
- Pre-registered clients (`oauth.clientId`) without `oauth.redirectUri` require the exact configured callback port from `MCP_OAUTH_CALLBACK_PORT` or the default `19876` on `localhost`
- `oauth.redirectUri` binds the exact loopback host, port, and path from that URI and advertises the same URI to the provider

- Handles `code`, `state`, and `error` parameters
- Displays success/error HTML pages
- Validates state and issuer before accepting codes or displaying provider errors; unverifiable errors receive a generic response
- Has a 5-minute timeout for pending authorizations

## Token Storage

Persistent OAuth entries are stored per configured server name in the operating system credential store, using macOS Keychain, Windows Credential Manager, or Linux Secret Service/libsecret through `@napi-rs/keyring`. The stored entry contains tokens, dynamic client information, legacy verifier/state fields when present, and the server URL binding.

The adapter fails closed when the OS credential store is unavailable. On headless Linux, configure an unlocked Secret Service-compatible keyring before using persistent OAuth; the adapter does not silently fall back to plaintext token files.

On Linux, if credential access fails because Pi inherited a revoked session keyring, the adapter makes one best-effort retry through `keyctl session - node <packaged helper>`. This lets explicit re-authentication write fresh credentials from a new session keyring without restarting a long-lived tmux or server process. The recovery path requires `keyctl` and `node` on `PATH`; missing, locked, or otherwise unavailable credential stores still fail closed.

Older versions stored plaintext entries at `~/.pi/agent/mcp-oauth/sha256-<server-hash>/tokens.json`, or under `settings.oauthDir` / `MCP_OAUTH_DIR`. On first read after upgrade, a valid legacy entry is imported into the OS credential store and the plaintext `tokens.json` file is removed. These directories are now legacy import locations, not persistent credential stores or isolation namespaces.

The stored `serverUrl` field ensures credentials are invalidated if the server URL changes. Client and token issuer bindings also remain strict: a changed authorization-server issuer requires explicitly clearing credentials before authenticating again, including for CIMD. No stored-login or issuer migration is performed.

### Android / Termux

Persistent OAuth is unsupported out of the box on Android/Termux: the published `@napi-rs/keyring` 1.3.0 package has no Android native binding. When native loading fails, authentication and credential status explain this limitation rather than suggesting that unlocking a Linux keyring will fix it. Use a supported platform with a working OS credential store for persistent OAuth; there is no plaintext fallback. Unauthenticated servers, header-token authentication, and stdio servers remain available. Public HTTP servers still defer credential-store access until an OAuth challenge.

## Security Considerations

### PKCE

Authorization-code flows use PKCE with the S256 method, preventing authorization code interception attacks.

### State Parameter

A cryptographically secure random state parameter is generated for each flow and validated on callback.

### OS Credential Store

Persistent OAuth credentials are written to the OS credential store. Legacy plaintext files are read only for one-way migration and are removed after successful import. On Linux, revoked session-keyring errors can be retried once through a fresh `keyctl session` helper during explicit re-authentication.

### URL Validation

Credentials are tied to a specific server URL. If the URL changes, the credentials are invalidated and re-authentication is required.

## Troubleshooting

### "No OAuth tokens found"

Run `/mcp-auth <server>` to authenticate.

### "Failed to discover OAuth endpoints"

The SDK automatically discovers OAuth endpoints from the MCP server. If discovery fails, the server may require a pre-registered client ID:

```json
{
  "mcpServers": {
    "server": {
      "url": "https://api.example.com/mcp",
      "auth": "oauth",
      "oauth": {
        "clientId": "your-client-id",
        "scope": "read"
      }
    }
  }
}
```

### "Dynamic client registration not supported"

Some servers require pre-registered clients. Obtain a client ID from your OAuth provider and add it to the config.

### Callback server already in use

Dynamic browser OAuth uses a lazy OS-assigned port on the default loopback host (`localhost`), so the configured default port being busy should not block dynamic registration.

For pre-registered OAuth clients (`oauth.clientId`), the callback redirect URI must match exactly. Set `oauth.redirectUri` to the full registered callback, such as Slack MCP's Claude-compatible `http://localhost:3118/callback`, or free/set `MCP_OAUTH_CALLBACK_PORT` when you rely on the default `/callback` path without an explicit redirect URI.

### Browser doesn't open

If the browser fails to open (e.g., in SSH sessions), the authorization URL will be displayed. Copy it manually to your browser.

## Architecture

The OAuth implementation uses the following modules:

- `mcp-auth.ts` - Auth storage and retrieval through the OS credential store, with one-way legacy `tokens.json` import
- `mcp-oauth-provider.ts` - SDK OAuthClientProvider implementation
- `mcp-callback-server.ts` - Node.js HTTP callback server
- `mcp-auth-flow.ts` - High-level auth flow using SDK transport

## Issuer compatibility

SDK 2.0.0 checks that authorization-server metadata returns the issuer advertised by discovery. Some providers advertise a path-scoped issuer but return the origin instead. If the provider cannot be corrected, explicitly opt out for that server only:

```json
{
  "mcpServers": {
    "known-provider": {
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth",
      "oauth": { "skipIssuerMetadataValidation": true }
    }
  }
}
```

The default remains strict, including when `protocolVersion` is `"legacy"`. The exception applies to discovery during authorization, completion, and refresh. It does not disable URL-bound credentials, stored issuer bindings, callback state, or callback `iss` validation. If the provider requires `iss`, paste the full redirect URL rather than only the authorization code; a missing issuer leaves the pending flow available for another attempt. The adapter also passes `iss` to the SDK before token exchange. Both pasted redirects and the HTTP callback listener validate error responses before presenting provider text; issuer mismatches never display the received issuer.

## SDK Integration

The implementation uses the official split MCP SDK v2 client and OAuth APIs. SDK v1 remains installed only because the current MCP Apps package requires it:

```typescript
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client"
```

The `McpOAuthProvider` class implements `OAuthClientProvider` and is passed to `StreamableHTTPClientTransport`:

```typescript
const transport = new StreamableHTTPClientTransport(url, {
  authProvider: new McpOAuthProvider(serverName, serverUrl, config, callbacks),
})
```

## References

- [Enterprise Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Client ID Metadata Documents](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
- [PKCE (RFC 7636)](https://datatracker.ietf.org/doc/html/rfc7636)
- [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728)
