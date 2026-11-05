# MCP client conformance tests

This directory runs the official `@modelcontextprotocol/conformance` client suite against `@fitchmultz/pi-mcp-adapter`.

The driver uses the adapter's own code rather than constructing a bare SDK client:

```text
conformance referee
  -> conformance/driver.sh (isolated token store; callback-port.ts allocates the callback port)
  -> conformance/driver.ts
  -> McpServerManager
  -> mcp-auth-flow + McpOAuthProvider + localhost callback server
  -> referee MCP and OAuth servers
```

The driver explicitly selects the legacy protocol profile; see the [referee compatibility details](details.md). Modern wire behavior is covered by the real local HTTP tests in `__tests__/sdk-v2-http.test.ts`.

The `auth/basic-cimd` fixture requires its own document identity, so the driver supplies it through `oauth.clientMetadataUrl`. The adapter still performs native discovery and CIMD selection; no static client ID or substitute provider is used. `__tests__/oauth-cimd.test.ts` separately proves the production shared document's acceptance, PKCE, refresh and MCP use over local HTTP.

The `auth/client-credentials-jwt` fixture supplies its throwaway client ID, PEM private key and algorithm through `oauth.clientId` and `oauth.privateKeyJwt`. Native signing, token exchange and the final MCP tool call use the adapter's real provider. `__tests__/oauth-private-key-jwt.test.ts` also covers JWK and command sources, browser code/refresh, custom documents, issuer guards and cancellation over local HTTP.

The `auth/cross-app-access-complete-flow` driver uses the real `oauth.crossAppAccess` configuration and discovers the fixture's IdP issuer. Its unmodified IdP fixture omits mandatory OIDC metadata. Strict discovery rejects it, so this scenario fails acceptance until the referee supplies a valid document. Local HTTP tests in `__tests__/oauth-cross-app.test.ts` cover valid OIDC discovery, both token exchanges, identity separation, actual network cancellation and final tool use. Corrected-fixture development evidence is supplemental, never a substitute for the unchanged official CI lane.

The `auth/2025-03-26-oauth-metadata-backcompat` fixture advertises an origin authorization server but returns a path-scoped issuer. That scenario explicitly enables `oauth.skipIssuerMetadataValidation`; it is not evidence of strict-default metadata acceptance. `__tests__/sdk-v2-oauth.test.ts` separately proves strict rejection, explicit opt-out, callback validation, issuer binding, and refresh with the actual SDK.

It covers the four core client scenarios and the full OAuth matrix shipped by the referee, 26 scenarios in total. Scope step-up must finish the client and final tool call, not just pass intermediate checks. `auth/scope-retry-limit` deliberately allows a client error after its bounded retries. The OAuth driver follows the referee's authorization redirect into the adapter's real callback server, then completes the pending flow through `completeAuthFromInput()`.

## Run the tests

From the repository root:

```sh
npm run lint:conformance
npm run test:conformance
```

The lint command checks all maintained JavaScript and TypeScript in `conformance/` with the test-support profile.

Run one scenario while developing:

```sh
bash conformance/run.sh --scenario initialize
bash conformance/run.sh --scenario auth/metadata-default --verbose
```

Results are written to `conformance/results/` and ignored by git. Set `CONFORMANCE_RESULTS_DIR` to use another directory, or `CONFORMANCE_TIMEOUT_MS` to change the 90-second per-scenario timeout.

The full runner is sequential. The conformance CLI's `--suite` mode runs scenarios in parallel, but pre-registered OAuth clients bind an exact localhost callback port. Parallel runs can therefore fail because another scenario briefly owns that port, which tests port contention rather than MCP behavior.

## Acceptance

Every scenario must pass. The runner has no expected-failure baseline or skipped scenarios. It also fails on timeouts and unexpected client-process errors, even if the referee's wire checks pass.

The published 0.1.16 referee's cross-app IdP document omits `response_types_supported`, `subject_types_supported`, and `id_token_signing_alg_values_supported`. This is a visible failing gate, not an accepted exception. [The quality audit](../docs/quality-audit.md) records the actual result and blocker. Production OAuth discovery remains strict.

`auth/scope-retry-limit` and `auth/resource-mismatch` deliberately exercise client rejection. Their successful wire assertions may accompany a nonzero client exit; a referee failure or timeout still fails the runner.
