# MCP client conformance tests

This directory runs the official `@modelcontextprotocol/conformance` client suite against pi-mcp-adapter.

The driver uses the adapter's own code rather than constructing a bare SDK client:

```text
conformance referee
  -> conformance/driver.sh (isolated token store and callback port)
  -> conformance/driver.ts
  -> McpServerManager
  -> mcp-auth-flow + McpOAuthProvider + localhost callback server
  -> referee MCP and OAuth servers
```

The driver explicitly selects the legacy protocol profile: conformance 0.1.16 has no 2026-07-28 client profile. Modern wire behavior is covered by the real local HTTP tests in `__tests__/sdk-v2-http.test.ts`.

The `auth/basic-cimd` fixture requires its own document identity, so the driver supplies it through `oauth.clientMetadataUrl`. The adapter still performs native discovery and CIMD selection; no static client ID or substitute provider is used. `__tests__/oauth-cimd.test.ts` separately proves the production shared document's acceptance, PKCE, refresh and MCP use over local HTTP.

The `auth/client-credentials-jwt` fixture supplies its throwaway client ID, PEM private key and algorithm through `oauth.clientId` and `oauth.privateKeyJwt`. Native signing, token exchange and the final MCP tool call use the adapter's real provider. `__tests__/oauth-private-key-jwt.test.ts` also covers JWK and command sources, browser code/refresh, custom documents, issuer guards and cancellation over local HTTP.

The `auth/cross-app-access-complete-flow` driver uses the real `oauth.crossAppAccess` configuration and discovers the fixture's IdP issuer. The unmodified fixture remains baselined because its OIDC metadata is invalid, not because cross-app authorization is missing. Local HTTP tests in `__tests__/oauth-cross-app.test.ts` cover valid OIDC discovery, both token exchanges, identity separation, actual network cancellation and final tool use. Corrected-fixture development evidence is supplemental, never a substitute for the unchanged official CI lane.

The `auth/2025-03-26-oauth-metadata-backcompat` fixture advertises an origin authorization server but returns a path-scoped issuer. That scenario explicitly enables `oauth.skipIssuerMetadataValidation`; it is not evidence of strict-default metadata acceptance. `__tests__/sdk-v2-oauth.test.ts` separately proves strict rejection, explicit opt-out, callback validation, issuer binding, and refresh with the actual SDK.

It covers the four core client scenarios and the full OAuth matrix shipped by conformance 0.1.16, 26 scenarios in total. Scope step-up must finish the client and final tool call, not just pass intermediate checks. `auth/scope-retry-limit` deliberately allows a client error after its bounded retries. The OAuth driver follows the referee's authorization redirect into the adapter's real callback server, then completes the pending flow through `completeAuthFromInput()`.

## Run the tests

From the repository root:

```sh
npm run test:conformance
```

Run one scenario while developing:

```sh
bash conformance/run.sh --scenario initialize
bash conformance/run.sh --scenario auth/metadata-default --verbose
```

Results are written to `conformance/results/` and ignored by git. Set `CONFORMANCE_RESULTS_DIR` to use another directory, or `CONFORMANCE_TIMEOUT_MS` to change the 90-second per-scenario timeout.

The full runner is sequential. The upstream CLI's `--suite` mode runs scenarios in parallel, but pre-registered OAuth clients bind an exact localhost callback port. Parallel runs can therefore fail because another scenario briefly owns that port, which tests port contention rather than MCP behavior.

## Expected failures

`baseline-client.yml` lists known adapter or SDK gaps. A failure in that file keeps the suite green; an unexpected failure or a baseline entry that starts passing fails the run.

Current gaps:

| Scenario | Reason |
| --- | --- |
| `auth/cross-app-access-complete-flow` | Stable 0.1.16's IdP OIDC document omits required `response_types_supported`, `subject_types_supported` and `id_token_signing_alg_values_supported`; the native SDK rejects it before token exchange. |

Baseline comments contain the protocol-level details. Do not add a failure caused by the driver, callback-port contention, or test setup.
