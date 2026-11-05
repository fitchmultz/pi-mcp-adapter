# Strict quality audit

## Scope and state

This audit applies guide 5.2 to `fitchmultz/pi-mcp-adapter`, starting at
`3d6d65ea35c5eb95f683476f3013828c81122147`. Work is isolated on
`strict-quality-zero`; unrelated modified lockfiles in the installed checkouts
remain untouched. The full guide is [the adopted standard](strict-quality-standard.md).

The Appendix A rules and Oxfmt options already match the guide. They remain fully
enabled. Oxlint is upgraded to 1.91.0; Oxfmt 0.76.0, oxlint-tsgolint 7.0.2006 and
oxc-parser 0.157.0 are the current stable releases resolved from npm on 5 November 2026. No semantic tool patch or diagnostic filter is used.

## Removed exceptions and exclusions

| Item                                  | Change and verification owner                                                                                                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QX-011, invalid protocol assertion    | `__tests__/protocol-config.test-d.ts` sends the same three invalid inputs to the manager, with compiler-verified expected argument errors and zero received HTTP requests. A valid counterpart connects. No unsafe cast remains.                                      |
| QX-3003, missing UI theme             | The adapter-owned state derives its UI from Pi but represents the supported optional theme accurately. The real status test supplies an absent theme without reflection. Native Pi's declaration is unchanged.                                                        |
| QX-020, auth-entry parameter mutation | `saveAuthEntry` persists a URL-enriched copy and borrows a readonly input. Production callers do not consume an updated argument, and the package does not export this helper. The frozen-input save/read test verifies unchanged input and complete stored contents. |
| QX-023, five cleanup aggregates       | Each aggregate retains both original failures, in order, and now sets the cleanup failure as `cause`. The four OAuth and one connection-abort tests preserve identity, cancellation, cleanup and no-replay assertions and check that cause.                           |
| `conformance/baseline-client.yml`     | Deleted, together with both `--expected-failures` flags and baseline-based client-error bypasses. Every official scenario remains selected. A referee failure now fails acceptance.                                                                                   |
| `.pi/**` and `.dogfood/**`            | Removed from both quality configurations and the coverage check's ignored-source exclusions. Private state stays Git-ignored, but hidden JavaScript/TypeScript now fails coverage instead of escaping checking.                                                       |
| Six task-document Git ignore patterns | Removed `progress.md`, `worker-summary.md`, `worker-*.md`, `plan.md`, `triage-*.md`, and `review-*.md`; they have no generated-file ownership.                                                                                                                        |

The auth-input ownership and cleanup-cause changes are intentional internal
behavior changes, not claimed to be byte-neutral. Persisted credentials, error
messages/classes, ordered failure identities, and terminal error rendering retain
their contracts. The old mutation and absent-cause assertions were added during
prior compliance work; no product caller requires them. Runtime tests verify the
new ownership and cause contracts rather than weakening the important assertions.

Dedicated negative type tests use the guide's defined profile, not a local lint
relaxation. Their expected errors must remain compiler errors, and runtime tests
still exercise rejection. Diagnostic examples inside test strings do not suppress
maintained implementation.

## Retained rule exceptions

There are 36 operation-bound directives and two configuration allowances.
These are not grandfathered lint findings. Removing each requires changing a
supported API, hiding the same operation, or introducing the concrete extra
machinery below. [The detailed decisions](quality-exceptions.md) include the
alternative implementations and detection boundaries. Native valid, neighboring
invalid, copied, changed, duplicate and unused-directive controls remain in normal
acceptance. Line numbers below identify the directive itself.

| ID      | Rule                                  | Location                                                                                                           | Why the compliant alternative is worse                                                                                                                                                                                                                             |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QX-026  | `eslint/no-new`                       | [`utils.ts:239`](../utils.ts#L239)                                                                                 | The native URL constructor supplies the original TypeError, code and input. Nonthrowing parsers lose that failure; returning the parsed URL changes the caller's original URL bytes.                                                                               |
| QX-001  | `eslint/no-param-reassign`            | [`mcp-trace.ts:306`](../mcp-trace.ts#L306)                                                                         | The SDK requires the original stdio transport prototype for its disposable negotiation probe and uses the native receiver. A forwarding transport changes that behavior; an alias only hides the mutation.                                                         |
| QX-007  | `typescript/no-deprecated`            | [`__tests__/fixtures/oauth-cross-app-stdio.ts:7`](../__tests__/fixtures/oauth-cross-app-stdio.ts#L7)               | These fixtures test legacy initialize-based stdio capabilities. Per-request capability envelopes are not available on that supported transport; removing the accessor drops the capability assertions.                                                             |
| QX-007  | `typescript/no-deprecated`            | [`__tests__/runtime/fixtures/elicitation-server.mjs:15`](../__tests__/runtime/fixtures/elicitation-server.mjs#L15) | These fixtures test legacy initialize-based stdio capabilities. Per-request capability envelopes are not available on that supported transport; removing the accessor drops the capability assertions.                                                             |
| QX-009  | `typescript/only-throw-error`         | [`mcp-trace.ts:239`](../mcp-trace.ts#L239)                                                                         | Strict flush must forward the stored failure unchanged. Promise.reject was tried, but the native rule rejects the guard-narrowed unknown despite allowThrowingUnknown. Wrapping changes rejection identity; type laundering or a queue rewrite is not a sound fix. |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`__tests__/sdk-v2-http.test.ts:2380`](../__tests__/sdk-v2-http.test.ts#L2380)                                     | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-012  | `eslint/no-param-reassign`            | [`__tests__/index-lifecycle.test.ts:729`](../__tests__/index-lifecycle.test.ts#L729)                               | This test must mutate the adapter-supplied configuration to detect a missing input clone. Mutating a local copy makes the broken adapter pass.                                                                                                                     |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`__tests__/runtime/callback-http-lifetime.test.ts:264`](../__tests__/runtime/callback-http-lifetime.test.ts#L264) | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-016  | `typescript/unbound-method`           | [`__tests__/runtime/callback-http-lifetime.test.ts:405`](../__tests__/runtime/callback-http-lifetime.test.ts#L405) | The original native method is later called with the actual receiver. Vitest exposes no original-method getter; resetting and reinstalling the spy clears call history and adds shared-state changes on every forwarded call.                                       |
| QX-016  | `typescript/unbound-method`           | [`__tests__/runtime/callback-http-lifetime.test.ts:446`](../__tests__/runtime/callback-http-lifetime.test.ts#L446) | The original native method is later called with the actual receiver. Vitest exposes no original-method getter; resetting and reinstalling the spy clears call history and adds shared-state changes on every forwarded call.                                       |
| QX-016  | `typescript/unbound-method`           | [`__tests__/runtime/callback-http-lifetime.test.ts:476`](../__tests__/runtime/callback-http-lifetime.test.ts#L476) | The original native method is later called with the actual receiver. Vitest exposes no original-method getter; resetting and reinstalling the spy clears call history and adds shared-state changes on every forwarded call.                                       |
| QX-018  | `typescript/no-unsafe-type-assertion` | [`keyring-store.ts:105`](../keyring-store.ts#L105)                                                                 | Lazy synchronous native loading preserves startup on unsupported platforms and the synchronous storage API. Eager imports or async imports break those contracts; a cast-free reflective facade duplicates the native class and changes instance identity.         |
| QX-013  | `eslint/preserve-caught-error`        | [`keyring-store.ts:111`](../keyring-store.ts#L111)                                                                 | The primary module-load failure must remain in the cause chain used by credential diagnostics. Substituting the most recently caught fallback failure drops the primary loader evidence.                                                                           |
| QX-018  | `typescript/no-unsafe-type-assertion` | [`keyring-store.ts:135`](../keyring-store.ts#L135)                                                                 | Lazy synchronous native loading preserves startup on unsupported platforms and the synchronous storage API. Eager imports or async imports break those contracts; a cast-free reflective facade duplicates the native class and changes instance identity.         |
| QX-018  | `typescript/no-unsafe-type-assertion` | [`mcp-keyring-helper.cjs:31`](../mcp-keyring-helper.cjs#L31)                                                       | Lazy synchronous native loading preserves startup on unsupported platforms and the synchronous storage API. Eager imports or async imports break those contracts; a cast-free reflective facade duplicates the native class and changes instance identity.         |
| QX-021  | `typescript/no-unsafe-type-assertion` | [`auth-record-types.ts:7`](../auth-record-types.ts#L7)                                                             | The installed Zod declaration types a lazy synchronous require. Eager imports load Zod during cached startup; async imports change synchronous storage. Credential values themselves still pass the canonical schemas.                                             |
| QX-022  | `eslint/max-params`                   | [`tool-names.ts:127`](../tool-names.ts#L127)                                                                       | The package /types export exposes five positional arguments. Grouping the filters breaks existing calls and can omit exclusions; a rest tuple merely conceals the same arity from the metric.                                                                      |
| QX-025  | `eslint/max-params`                   | [`direct-tools.ts:56`](../direct-tools.ts#L56)                                                                     | Pi supplies tool context in position five. Four parameters lose that context; an options argument is incompatible with the SDK. A rest tuple would preserve behavior but hide the same five required positions.                                                    |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`connection-factory.ts:336`](../connection-factory.ts#L336)                                                       | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`connection-http.ts:259`](../connection-http.ts#L259)                                                             | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`tool-transport.ts:297`](../tool-transport.ts#L297)                                                               | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-010  | `unicorn/prefer-add-event-listener`   | [`tool-transport.ts:303`](../tool-transport.ts#L303)                                                               | MCP Client and Transport expose callback properties, not EventTarget.addEventListener. Replacing these assignments cannot deliver the SDK's close, error or cancellation messages.                                                                                 |
| QX-024  | `typescript/no-deprecated`            | [`connection-http.ts:120`](../connection-http.ts#L120)                                                             | These native SDK operations preserve legacy SSE, logging-request drain ownership, and OAuth issuer forwarding. Omitting them breaks supported connections or lifecycle/authentication behavior.                                                                    |
| QX-024  | `typescript/no-deprecated`            | [`connection-runtime.ts:139`](../connection-runtime.ts#L139)                                                       | These native SDK operations preserve legacy SSE, logging-request drain ownership, and OAuth issuer forwarding. Omitting them breaks supported connections or lifecycle/authentication behavior.                                                                    |
| QX-024  | `typescript/no-deprecated`            | [`connection-runtime.ts:181`](../connection-runtime.ts#L181)                                                       | These native SDK operations preserve legacy SSE, logging-request drain ownership, and OAuth issuer forwarding. Omitting them breaks supported connections or lifecycle/authentication behavior.                                                                    |
| QX-024  | `typescript/no-deprecated`            | [`connection-oauth-ownership.ts:34`](../connection-oauth-ownership.ts#L34)                                         | These native SDK operations preserve legacy SSE, logging-request drain ownership, and OAuth issuer forwarding. Omitting them breaks supported connections or lifecycle/authentication behavior.                                                                    |
| QX-025  | `eslint/max-params`                   | [`host-tools.ts:168`](../host-tools.ts#L168)                                                                       | Pi supplies tool context in position five. Four parameters lose that context; an options argument is incompatible with the SDK. A rest tuple would preserve behavior but hide the same five required positions.                                                    |
| QX-025  | `eslint/max-params`                   | [`host-tools.ts:225`](../host-tools.ts#L225)                                                                       | Pi supplies tool context in position five. Four parameters lose that context; an options argument is incompatible with the SDK. A rest tuple would preserve behavior but hide the same five required positions.                                                    |
| QX-025  | `eslint/max-params`                   | [`host-tools.ts:278`](../host-tools.ts#L278)                                                                       | Pi supplies tool context in position five. Four parameters lose that context; an options argument is incompatible with the SDK. A rest tuple would preserve behavior but hide the same five required positions.                                                    |
| QX-030  | `unicorn/prefer-add-event-listener`   | [`__tests__/fixtures/app-bridge-bundle-probe.ts:34`](../__tests__/fixtures/app-bridge-bundle-probe.ts#L34)         | The standalone bundle's compatibility tests cover actual callback setters/getters. The message setter handles a request, not an event; event listeners do not preserve the legacy getter/setter assertions.                                                        |
| QX-030  | `typescript/no-deprecated`            | [`__tests__/fixtures/app-bridge-bundle-probe.ts:54`](../__tests__/fixtures/app-bridge-bundle-probe.ts#L54)         | The standalone bundle's compatibility tests cover actual callback setters/getters. The message setter handles a request, not an event; event listeners do not preserve the legacy getter/setter assertions.                                                        |
| QX-030  | `typescript/no-deprecated`            | [`__tests__/fixtures/app-bridge-bundle-probe.ts:56`](../__tests__/fixtures/app-bridge-bundle-probe.ts#L56)         | The standalone bundle's compatibility tests cover actual callback setters/getters. The message setter handles a request, not an event; event listeners do not preserve the legacy getter/setter assertions.                                                        |
| QX-030  | `typescript/no-deprecated`            | [`__tests__/fixtures/app-bridge-bundle-probe.ts:61`](../__tests__/fixtures/app-bridge-bundle-probe.ts#L61)         | The standalone bundle's compatibility tests cover actual callback setters/getters. The message setter handles a request, not an event; event listeners do not preserve the legacy getter/setter assertions.                                                        |
| QX-030  | `typescript/no-deprecated`            | [`__tests__/fixtures/app-bridge-bundle-probe.ts:63`](../__tests__/fixtures/app-bridge-bundle-probe.ts#L63)         | The standalone bundle's compatibility tests cover actual callback setters/getters. The message setter handles a request, not an event; event listeners do not preserve the legacy getter/setter assertions.                                                        |
| QX-031  | `typescript/no-base-to-string`        | [`__tests__/fixtures/mcp-code-server.mjs:43`](../__tests__/fixtures/mcp-code-server.mjs#L43)                       | The raw echo fixture intentionally uses native JavaScript coercion for arbitrary JSON values. JSON.stringify changes output, while a compliant coercion reimplementation duplicates native semantics.                                                              |
| QX-7001 | `unicorn/no-thenable`                 | [`__tests__/catalog-metadata.test.ts:53`](../__tests__/catalog-metadata.test.ts#L53)                               | JSON Schema uses a noncallable then keyword. Renaming it or changing to another schema form removes the raw-descriptor preservation case; it is not a Promise thenable.                                                                                            |

| ID     | Configuration scope                                                                                                                               | Concrete constraint                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QX-017 | `.oxlintrc.json:433-453`, sampling `typescript/no-deprecated` override for `sampling-handler.ts` and `__tests__/runtime/sampling-handler.test.ts` | The SDK deprecates five sampling types while retaining the protocol. Removing sampling makes unchanged remote callbacks fail with method-not-found; migrating the remote server is outside the adapter's control. Wrong-origin, unlisted and out-of-scope deprecations still fail. |
| QX-019 | `.oxlintrc.json:302-328`, `typescript/no-floating-promises` override for the four root Node OAuth suites                                          | Node owns test registration promises. Awaiting registrations changes module evaluation and hook order. Only native `nodeIt` and `nodeDescribe` imports are allowed; all six required invalid-work controls run in normal acceptance.                                               |

## Retained profile and output exclusions

The guide's test, declaration and negative-type profiles are applied by role.
Conformance and `scripts/native-compat/` are exclusively executable test support.
Vitest is scoped to `__tests__/`; native composition controls verify base,
category-enabled and framework rules there.

The remaining lint/format exclusions at `.oxlintrc.json:456-465` and
`.oxfmtrc.json:15-24` own only dependencies or generated output:
`node_modules/**`, `dist/**`, `dist.staging*/**`, `conformance/results/**`,
`app-bridge.bundle.js`, `host-browser.bundle.js`, and the example's `dist/**`
and `node_modules/**`. Build, bundle freshness and conformance tools own those
outputs. Handwritten generators remain linted, compiled and formatted. Root
`skipLibCheck` at `tsconfig.json:22` does not exempt handwritten declarations: the independent required
`tsconfig.declarations.json:14` checks them with `skipLibCheck: false`.

The root project's exclusions at `tsconfig.json:38` send the example to its own
required project and omit only generated bundles/output and dependencies.
`tsconfig.build.json:12` excludes tests, Vitest configuration and handwritten
browser modules from distribution emit, not from root typechecking or lint.
`examples/interactive-visualizer/tsconfig.json:17` skips dependency declaration
checking only; maintained declarations still must enter the required declaration
project. These mappings do not remove maintained implementation from acceptance.

The following 19 expected-error comments are retained as compiler assertions in
dedicated negative type tests, not to grandfather implementation errors. Removing
one makes the deliberately invalid call fail compilation; weakening the API makes
the directive unused and also fails compilation. The executable suites additionally
verify runtime rejection, and the packed consumer checks the published types.

| Location                                                                                                                     | Expected contract failure                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`__tests__/catalog-metadata.test-d.ts:8`](../__tests__/catalog-metadata.test-d.ts#L8)                                       | SDK tool metadata is an optional record, never null.                         |
| [`__tests__/fixtures/published-types-consumer.test-d.mts:35`](../__tests__/fixtures/published-types-consumer.test-d.mts#L35) | Call phases must remain a typed union.                                       |
| [`__tests__/fixtures/published-types-consumer.test-d.mts:58`](../__tests__/fixtures/published-types-consumer.test-d.mts#L58) | Factory options must retain their declared value types.                      |
| [`__tests__/fixtures/published-types-consumer.test-d.mts:60`](../__tests__/fixtures/published-types-consumer.test-d.mts#L60) | The returned extension requires the host API.                                |
| [`__tests__/fixtures/published-types-consumer.test-d.mts:62`](../__tests__/fixtures/published-types-consumer.test-d.mts#L62) | The default export also requires the host API.                               |
| [`__tests__/fixtures/published-types-consumer.test-d.mts:64`](../__tests__/fixtures/published-types-consumer.test-d.mts#L64) | The /types export must retain function return types.                         |
| [`__tests__/oauth-config.test-d.ts:28`](../__tests__/oauth-config.test-d.ts#L28)                                             | Untrusted OAuth values are rejected by the typed extraction API.             |
| [`__tests__/oauth-config.test-d.ts:35`](../__tests__/oauth-config.test-d.ts#L35)                                             | Untrusted OAuth values are rejected by the typed provider API.               |
| [`__tests__/oauth-config.test-d.ts:91`](../__tests__/oauth-config.test-d.ts#L91)                                             | Untrusted OAuth values are rejected by the typed extraction API.             |
| [`__tests__/oauth-config.test-d.ts:98`](../__tests__/oauth-config.test-d.ts#L98)                                             | Untrusted OAuth values are rejected by the typed provider API.               |
| [`__tests__/oauth-config.test-d.ts:145`](../__tests__/oauth-config.test-d.ts#L145)                                           | Unknown client metadata values are rejected by the typed extraction API.     |
| [`__tests__/oauth-config.test-d.ts:153`](../__tests__/oauth-config.test-d.ts#L153)                                           | Unknown client metadata values are rejected by the typed provider API.       |
| [`__tests__/oauth-config.test-d.ts:207`](../__tests__/oauth-config.test-d.ts#L207)                                           | OAuth redirect URIs are strings, not port numbers.                           |
| [`__tests__/oauth-config.test-d.ts:220`](../__tests__/oauth-config.test-d.ts#L220)                                           | OAuth client names are strings, not numbers.                                 |
| [`__tests__/oauth-config.test-d.ts:230`](../__tests__/oauth-config.test-d.ts#L230)                                           | OAuth client URIs are strings, not numbers.                                  |
| [`__tests__/oauth-config.test-d.ts:243`](../__tests__/oauth-config.test-d.ts#L243)                                           | OAuth authorization parameters require a string-valued object.               |
| [`__tests__/oauth-config.test-d.ts:253`](../__tests__/oauth-config.test-d.ts#L253)                                           | Individual OAuth authorization parameter values must be strings.             |
| [`__tests__/oauth-config.test-d.ts:264`](../__tests__/oauth-config.test-d.ts#L264)                                           | OAuth clientId is a string in the public typed configuration.                |
| [`__tests__/protocol-config.test-d.ts:22`](../__tests__/protocol-config.test-d.ts#L22)                                       | Invalid protocol and OAuth option values must fail the typed connection API. |

The remaining Git ignores in `.gitignore:1-9` cover dependencies, local runtime
state, conformance output, log files, macOS metadata and generated distributions.
The two client-exit cases in `conformance/run.sh:34-36` are negative protocol-test
expectations, not accepted failures: the real referee asserts bounded scope retries
and rejection of a mismatched resource. All wire assertions and timeouts remain
fatal. The explicit legacy issuer option at `conformance/driver.ts:187` exercises
the product's opt-in compatibility setting; strict-default rejection is separately
tested. Neither mapping weakens lint or compiler coverage.

## Verification

The unchanged starting tree passes `npm run check` on the M1 using npm 12.2.0,
Node 24.22.1 and the locked official Pi 1.5.0 graph. This result includes the old
conformance baseline and is not evidence for baseline-free acceptance.

Termux builds, four compiler projects, formatting, policy, directive and OAuth
checks ran. Published semantic lint cannot execute there because
`@oxlint-tsgolint/android-arm64/tsgolint` is absent. The original local Vitest run
also reported associated lint-control failures and two timeouts. Native M1
verification is the applicable quality-tool result, not Android runtime proof.

The native M1 candidate is verified against the base revision above plus patch
SHA-256 `61d37b03299b2303016b786da28877502d1df8b67a492578fd9b45aa831a4391`.
This record's result updates are documentation-only. Commands below ran through
`npx --yes npm@12.2.0 run check` after clean root and example installs. They use
Node 24.22.1, official Pi 1.5.0, and the committed quality-tool versions.

| Gate                  | Command                                                                                                                                                | Result                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native lint           | `npm run lint` (`oxlint --deny-warnings .`)                                                                                                            | Passed, 401 source files, 228 rules, zero warnings and errors under the recorded exceptions.                                                                                |
| Formatting            | `npm run format:check` (`oxfmt --check .`)                                                                                                             | Passed, 438 files. The native fix/format/idempotence controls also pass.                                                                                                    |
| Compiler projects     | `npm run typecheck:all`                                                                                                                                | All four projects pass, including real handwritten declaration checking.                                                                                                    |
| Root build            | `npm run build`                                                                                                                                        | Passed, including schema freshness.                                                                                                                                         |
| Example build         | `npm run --prefix examples/interactive-visualizer build`                                                                                               | Passed.                                                                                                                                                                     |
| Vitest                | `npm run test:vitest`                                                                                                                                  | 130 files, 1,916 tests pass. Includes the native policy, structural, semantic, framework, directive and Node-registration controls.                                         |
| Node OAuth            | `npm run test:oauth`                                                                                                                                   | 90 tests pass; none skipped.                                                                                                                                                |
| Policy and directives | `npm run check:policy`; `npm run check:directives`                                                                                                     | Both pass. Hidden-source mutations fail as intended.                                                                                                                        |
| Generator freshness   | `npm run check:cache-schema`; `npm run check:browser`                                                                                                  | Both pass. Standalone bridge freshness passes in Vitest.                                                                                                                    |
| Packed official host  | `PI_COMPAT_HOST=official PI_COMPAT_EXPECTED_VERSION=1.5.0 node scripts/compat-host.mjs`; same environment with `node scripts/compat-package-smoke.mjs` | Passed. Packed npm install, native SDK reload, bundled CLI, commands without physical peers, nested tool cancellation/redaction and selection persistence run successfully. |
| Protocol conformance  | `npm run test:conformance`                                                                                                                             | Passed all 26 scenarios using the stable referee source with the reviewed IdP fixture correction. No assertions or scenarios are skipped.                                   |
| Aggregate             | `npm run check`                                                                                                                                        | Final integrated rerun follows the referee correction; all constituent checks are required.                                                                                 |

The supplied guide and adopted copy also match exactly after Oxfmt formatting,
excluding the repository's Appendix B adoption record. `git diff --check` passes.
Hosted official/fork qualification and both automated reviews passed on `8a8afd0`.
The current referee correction is requalified by the full integrated run and current-head
checks on [PR #208](https://github.com/fitchmultz/pi-mcp-adapter/pull/208). No required
failure is accepted; merge and release require all those checks.

## Files changed

- `.gitignore`
- `.oxfmtrc.json`
- `.oxlintrc.json`
- `__tests__/disabled-server.test.ts`
- `__tests__/fixtures/strict-manager-boundaries-http.ts`
- `__tests__/oauth-recovery-integration.test.ts`
- `__tests__/protocol-config.test-d.ts`
- `__tests__/quality/directive-policy.test.ts`
- `__tests__/quality/policy.test.ts`
- `__tests__/runtime/mcp-trace.test.ts`
- `__tests__/sdk-v2-http.test.ts`
- `__tests__/server-manager-runtime-owner.test.ts`
- `conformance/README.md`
- `conformance/baseline-client.yml` (deleted)
- `conformance/details.md`
- `conformance/idp-discovery.patch`
- `conformance/prepare-referee.sh`
- `conformance/run.sh`
- `connection-handshake.ts`
- `docs/development.md`
- `docs/quality-audit.md`
- `docs/quality-comparisons/auth-entry-ownership.md`
- `docs/quality-exceptions.md`
- `docs/strict-quality-standard.md`
- `init-status.ts`
- `mcp-auth-flow.ts`
- `mcp-auth.test.ts`
- `mcp-auth.ts`
- `mcp-oauth-start.ts`
- `mcp-trace.ts`
- `package-lock.json`
- `package.json`
- `quality-exceptions.json`
- `sampling-handler.ts`
- `scripts/check-directives.mjs`
- `scripts/check-policy.mjs`
- `state.ts`
- `tool-approval.ts`

## Guide feedback

- Required SDK callback arity and callback-property APIs conflict with generic
  arity/EventTarget preferences. Rest tuples and aliases hide these operations
  rather than improve them.
- Intentional legacy-protocol support conflicts with blanket deprecation errors.
  The adapter cannot migrate an independently owned remote MCP server.
- Synchronous lazy native modules have published declarations but Node's
  `createRequire` result is untyped in TypeScript. Reimplementing a native class
  through reflective validation is not safer than using its installed contract.
- Native URL validation and JavaScript echo coercion have observable failure/byte
  behavior that their suggested replacements do not retain.
- JSON Schema's noncallable `then` property is not a Promise thenable.

## Referee correction

The 0.1.16 release source is built with `conformance/idp-discovery.patch`, which
backports [upstream PR #574](https://github.com/modelcontextprotocol/conformance/pull/574).
It supplies the three required IdP metadata fields and uses RS256 for the fixture's
ID token, matching OIDC Discovery's mandatory advertised algorithm. ID-JAG signing,
all referee assertions, scenario selection and production OAuth validation are unchanged.
`conformance/prepare-referee.sh` uses the official release commit and its lockfile;
`conformance/run.sh` builds once, runs all 26 native scenarios and cleans temporary
source/output. Patch application and the native build happen on every run, so input
changes cannot reuse stale output. This fixes the dependency fixture rather than
recording or suppressing a failure.

The installed referee source is [cross-app-access.ts:160-173](https://github.com/modelcontextprotocol/conformance/blob/21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0/src/scenarios/client/auth/cross-app-access.ts#L160-L173).
A separate real-referee discovery probe received HTTP 200 with only `issuer`,
`authorization_endpoint`, `token_endpoint`, `jwks_uri`, and `grant_types_supported`.
The installed SDK's `discoverAuthorizationServerMetadata` rejected that actual
response with three `invalid_type` issues naming the missing fields. This confirms
the failure before either exchange, rather than inferring it from fixture text.

The upstream regression calls the SDK's real discovery helper against the running
fixture. It fails with those three missing-field errors before the correction. The
corrected upstream build and all 642 tests pass, and its canonical typecheck/lint
pass on the M1. The adapter's corrected stable runner passes all 26 scenarios on
Termux. These results do not claim that upstream has published the correction;
the patch and source provenance remain explicit until that release is available.
