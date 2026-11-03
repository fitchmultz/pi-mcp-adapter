# Development and releases

See [AGENTS.md](../AGENTS.md) for repository test conventions, the [strict quality standard](strict-quality-standard.md) for quality requirements, and [.github/workflows/ci.yml](../.github/workflows/ci.yml) for the full CI contract.

## Local checks

Use the npm version declared in `package.json`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix examples/interactive-visualizer --ignore-scripts --no-audit --no-fund
npm run --prefix examples/interactive-visualizer build
npm run build
npm run format:check
npm run check:directives
npm run check:policy
npm run lint:conformance
npm run lint:consumer-tooling
npm run lint:prompts
npm run lint:runtime-tests
npm run lint:tracing
npm run lint:core-runtime
npm run lint:config-runtime
npm run lint:sampling
npm run lint:output-runtime
npm run lint:credential-runtime
npm run lint:auth-boundaries
npm run lint:node-oauth
npm run lint:sdk-http
npm run lint:lifecycle-tests
npm run lint:oauth-recovery
npm run lint:oauth-flows
npm run lint:auth-tests
npm run lint:discovery-tests
npm run lint:state-tests
npm run lint:output-tests
npm run lint:packaging-tests
npm run lint:quality
npm run lint:ui-host-tests
npm run lint:panel-tests
npm run typecheck
npm run typecheck:all
npm test
npm run test:conformance
```

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-mcp-adapter --source "$PWD" --host official --target latest --output /tmp/pi-mcp-adapter-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification. Preserve the separate extras checks in `.github/workflows/ci.yml`.

Strict lint is enforced for `conformance/`, the prompt tests and their shared fixtures, `__tests__/runtime/`, `__tests__/auth/`, `__tests__/discovery/`, `__tests__/state/`, `__tests__/output/`, `__tests__/packaging/`, `__tests__/ui-host/`, `__tests__/panel/`, and the pinning test fixture. The discovery scope also includes the root search-ranking suite. Repository-wide strict lint remains a migration target.

`lint:consumer-tooling` enforces the production profile for the selected-host resolver and packed-consumer loader, their result schemas and the checked CLI observer. The loader validates external JSON and checks the real SDK, gateway activation, reload and CLI registration against the selected host graph.

The same command enforces the production profile for `scripts/release-candidate.mjs` and its automation adapter. The launcher starts before source dependencies are installed, validates only the dynamic values it consumes, and preserves the selected automation's original host identity. Retained tarball, source, host-graph and packed-consumer checks remain owned by the release workflow.

The command also checks the native-contract launcher under the production profile and `scripts/native-compat/` under the test profile. That directory contains only native SDK and CLI contract assertions and their HTTP, provider and extension fixtures. Its checked consumer uses ordinary ESM imports of the selected package and host. The scenarios retain nested-call redaction, cancellation without replay, tree and reload selection, saved-output paging, pinning and tool restrictions. The launcher resolves symlinked entrypoints before dispatch and rejects failed consumer assertions.

`lint:tracing` enforces the production profile for `mcp-trace.ts`. Its disk, redaction and SDK transport tests are covered by `lint:runtime-tests`.

`lint:core-runtime` enforces the production profile for cancellation, client-operation drains, process paths, legacy migration, onboarding storage, logging, panel keys, search ranking and Unix-socket transport. Rejections retain their original values. Transport cleanup failures reach the existing error callback.

`lint:config-runtime` enforces the production profile for `config*.ts`, `types.ts`, `public-types.ts`, `tool-names.ts` and `ui-message-types.ts`. It also checks the config, OpenCode interpolation and executable negative OAuth configuration suites under the test profile. File parsing validates known fields without stripping server, settings or OAuth extension properties. Malformed known fields warn and invalidate a Pi or shared file; malformed standard host entries are omitted. Legacy null values remain valid for server `command`, `socket`, and `oauth`, and for `settings.trace.file`. Only literal `disabled: true` disables a server; string values remain enabled. Other known fields retain their declared validation. Authentication semantics and command secrets remain lazy. QX-022 permits only the published five-position `isToolAllowed` predicate. The CI extras job requires this scoped gate; repository-wide lint remains a migration target.

`lint:sampling` enforces the production profile for the supported MCP sampling bridge. Its native model-registry and approval tests are covered by `lint:runtime-tests`. QX-017 permits only five deprecated MCP sampling types from their actual SDK package in these two files. Other deprecations and all other rules remain checked.

`lint:output-runtime` enforces the production profile for `mcp-output-*.ts`: output guards, streaming previews, retained-result contracts, summaries and paged result reads. Raw MCP properties remain unknown until narrowed. The existing output suites verify artifact readback, private permissions, paging and UTF-8 boundaries.

`lint:runtime-tests` includes native Pi gateway selection, reload, lazy startup and initialization tests, plus the standalone startup child. These tests use the installed Pi graph selected by qualification. The child installs module hooks before importing Pi, loads the source extension, and executes its first stdio call. Initialization tests use a real Pi context and public health-check timers.

The runtime scope includes disabled-server, elicitation-policy, footer, stale-context and failure-state initialization tests. Complete native contexts and owned managers replace partial host objects. Real HTTP capability and callback delivery, a stdio cwd tool, config files and SDK context invalidation retain the initialization contracts. Footer assertions retain the deliberate JavaScript-host missing-theme fault. Failure-state tests cross the expiry timer and verify owner shutdown prevents publication.

The runtime scope also includes the real HTTP callback-lifetime suite and its server fixture. It covers callback cancellation and reply drain, token reads and persistence, subscription refresh, URL completion and accepted-operation no-replay through native Pi contexts and MCP transports.

Manager configuration tests use real HTTP and stdio connections for capability advertisement, callback replies, cwd selection and native request options. A call-through native client records its actual constructor callbacks for the replaced-client and failed-refresh races.

The runtime scope also includes manager reconnect, owner-shutdown and stderr tests. Real loopback HTTP handshakes verify shared connection cancellation, replacement and stale-connection guards. Native SDK subclasses observe constructors and hold handshake completion for controlled races without replacing transport behavior. A real stdio child verifies captured stderr, native error causes and byte bounds. Focused fault injection retains the cleanup-failure and oversized string-event branches.

The runtime scope includes the stock-dialog elicitation and real stdio SDK suites. A typed three-method dialog fixture preserves selection/input order and notification history. Complete native extension contexts and state back the direct/proxy tool, resource and UI-resource cases. QX-007 covers only the initialized capability accessor in each of the two enumerated legacy stdio fixtures.

`lint:credential-runtime` enforces the production profile for native keyring loading, credential-store diagnostics, Linux recovery dispatch, its standalone CommonJS helper and `mcp-auth.ts`. Native declarations type the lazy synchronous module loads. QX-013 preserves the primary loader failure, and QX-018 covers only the three enumerated native module assertions. QX-020 preserves the supplied auth entry's URL update. QX-021 types only the installed lazy Zod load, preserving cached startup without Zod. Structural validation retains the original JSON property order. Canonical schemas validate persisted records before use or plaintext migration, preserve extension fields and leave legacy redirect validation with the OAuth flow. Malformed known fields fail before secure writes or plaintext deletion. The same scope includes the payload store for hashed accounts, manifest validation, chunk reads/writes and cleanup. The storage suite retains real child-process recovery, platform diagnostics, chunking and plaintext migration checks.

`lint:auth-boundaries` checks the real HTTP bearer-auth suite, the SDK OAuth compatibility suite and the isolated Android keyring probe. The first suite uses the native client and transport with received-header assertions. The OAuth suite retains PKCE, issuer, refresh, cancellation and no-replay checks. The Android probe blocks external access and uses the isolated implementation prepared by the storage suite. It tests loader diagnostics, not Android hardware.

`lint:sdk-http` enforces the test profile for the real HTTP SDK suite and its typed native capture extension fixture. Latest-host qualification supplies one consistent SDK graph for their static imports and Jiti-loaded factories.

`lint:node-oauth` covers the four root Node OAuth suites and their native-loader fixture. QX-019 permits only the `nodeIt` and `nodeDescribe` imports from `node:test` in those four root files. Registrations retain Node's scheduling. Context subtests and other asynchronous work still require ownership. The loader test uses synchronous `registerHooks` and restores its hooks and process descriptors. Invalid OAuth argument tests run in the compiler-checked negative configuration suite.

`lint:lifecycle-tests` enforces the test profile for the adapter's native SDK lifecycle tests, their extension fixture, and the shared complete SDK context fixture.

`lint:oauth-recovery` enforces the test profile for the real HTTP OAuth recovery suite and its native Pi and HTTP fixtures. The suite covers callback validation, scope recovery, cancellation, accepted-operation no-replay, and interactive and headless callers.

`lint:oauth-flows` enforces the test profile for client-credentials, private-key JWT, cross-app authorization and client-metadata document suites, their shared HTTP and wire fixtures, and their standalone stdio and shutdown fixtures. The OAuth configuration suite runs as both executable runtime validation and a dedicated negative type test: the compiler verifies described invalid API arguments, and Vitest verifies their real rejection and redaction. All HTTP, PKCE, refresh, signing, cancellation, storage and source-laziness assertions remain active. Malformed stored client-metadata callbacks enter through raw legacy JSON in an isolated credential directory, not an unsafe typed API call.

The auth, runtime and panel scopes include the command authentication, status, onboarding and credential-storage suites. They use complete native Pi contexts and real panel components. They verify URL notifications, failure diagnostics, pending authorization cancellation and the disk writes that preserve inherited server definitions.

`check:directives` accepts only the operation-bound lint exceptions in `quality-exceptions.json`, documented in [quality exceptions](quality-exceptions.md). It rejects copied, replaced, duplicated, stale and incorrectly attached directives. The packed-consumer type fixture and executable OAuth configuration suite are approved negative type tests. Their `@ts-expect-error` comments require a description. Other TypeScript error suppressions, file-wide and range disables remain prohibited.

`check:policy` compares the root lint and formatter configurations with the adopted standard and declared profiles, rejects nested quality configs, and checks resolved compiler settings and membership for maintained source and handwritten declarations. It does not yet verify all source classifications or acceptance wiring.

## Automatic npm releases (maintainers)

The `npm version` workflow queues main merges and opens a reviewed patch-version PR through the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases). The `npm release` workflow publishes after full CI (including extras) and retained-candidate qualification pass. Verify the matching npm and GitHub releases; workflow validation is not evidence of a real OIDC publication.

Failed or unpublished candidates can retry daily at 12:17 UTC or through manual dispatch on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed.

The reusable `release-qualification.yml` gate installs the retained candidate tarball into an isolated consumer against each selected Pi host. It checks the native SDK and CLI, gateway/script activation and reload, local MCP transport behavior, and published declarations without repacking. Candidate and full host-graph identities are checked against the shared preparation receipt.

## Pi release qualification

Pi **1.5.0** is the support floor; host peers remain wildcard. Required qualification uses the latest stable official Pi and latest maintained fork `main`, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not qualification targets. Extras use the same resolved official graph. `npm run check:compat` verifies the installed SDK and CLI identity, builds and typechecks, runs Vitest and memory-only OAuth tests, then loads a packed consumer through the native SDK and CLI.

GitHub CI runs that contract on Node 24 against both official Pi and the maintained fork through the shared Pi compatibility automation, including fresh Git and npm installations loaded by the real Pi CLI. A second job checks lockfile registry hosts, published type declarations, the built interactive visualizer, and MCP protocol conformance. These checks use local MCP fixtures and disposable agent directories, never live credentials or paid providers.

Keep the locked development TypeBox snapshot aligned with its locked Pi cohort; qualification selects the latest host's actual companion graph independently. Standalone TypeBox updates are disabled: a second version in source installs adds measurable startup cost. Published peers remain optional wildcard dependencies, and qualification selects each host's actual TypeBox version.

## Android/Termux source builds

On **Android/Termux**, Git/source installs and type checks require an Android-native
TypeScript 7 compiler as `tsgo` on `PATH`. The [Fold development environment](https://github.com/fitchmultz/fold-dev-environment)
provides a pinned native build (validated with `7.1.0-dev.20260904.1`). npm's TypeScript
package has no Android binary, and its Linux binary probes a syscall Android blocks.
macOS/Linux use the package-local pinned compiler. Published precompiled packages
do not need a compiler at runtime.
