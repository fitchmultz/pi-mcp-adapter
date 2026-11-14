# Development and releases

See [AGENTS.md](../AGENTS.md) for repository test conventions, the [strict quality standard](strict-quality-standard.md) for quality requirements, and [.github/workflows/ci.yml](../.github/workflows/ci.yml) for the full CI contract.

## Runtime ownership

The host runtime owns tool and command registrations across session changes.
Handlers resolve current state when invoked; borrowed Pi UI and session handles
must not be reused after their runtime owner stops. Session approvals belong to
the adapter state and expire when it is rebuilt, including after a working-directory
change.

Shutdown snapshots metadata before stopping connection cleanup. Failure-expiry
timers belong to that state's runtime owner; panel inactivity timers belong to the
panel and are cleared on disposal. OAuth runtime shutdown and runtime-owner stop
are repeat-safe because initialization failure, session replacement and final
shutdown can converge on the same owner.

A stdio send remains owned until it completes or the native transport reports
actual process and pipe closure. Native MCP client 2.4.0 can otherwise leave a
send waiting for `drain` after the pipe has closed. HTTP authentication tails,
callbacks and other client operations still drain through their existing owners.

Cancelling the agent turn that started initialization stops its remaining
startup requests, not the session. Completed connections keep their discovered
metadata, and owner-scoped health checks still reconnect keep-alive servers and
close idle connections.

Native catalog refreshes can finish while another startup catalog is still
loading or finish out of order. The manager reads the per-client SDK response
cache, whose native invalidation generations reject stale writes, before
publishing startup or callback catalog updates. Callback result arrays are not
an authority for publication. Retired clients remain fenced out. The cache uses
the SDK's in-memory store and default limits; catalog views read retained entries
regardless of response TTL, without making another request.

The OAuth runtime shares concurrent starts for the same server and storage
directory. A start for another URL cancels and waits for the earlier start.
Logout cancels an unpublished start before removing its credentials, and
shutdown waits for start cleanup before stopping the callback server.
Concurrent completions of the same callback share one code exchange. A different
callback cannot replace an exchange already in progress. A joining caller's
cancellation stops its wait without cancelling the shared operation.
Pasted completion also finishes an authentication waiting for the browser,
including while its URL notification is still in progress.

Metadata snapshots, the native keyring constructor and optional Glimpse module
availability are process caches, not session resources. Their contents survive
session rebuilds; they do not own live MCP connections or authorize use of stale
Pi handles.

UI listener startup can overlap. A completed listener replaces the current UI
slot immediately before publishing its own handle, so a later startup cannot
leave an untracked listener open. Optional viewer launches check that the session
still owns that slot; a Glimpse window that finishes opening after replacement
closes without taking ownership of the current viewer.

The served host opens SSE and starts heartbeats before loading the app iframe.
It waits for the native AppBridge `initialized` event before forwarding buffered
events, sends eager-mode initial input first, and preserves SSE delivery order.
Stream-first mode still omits that initial input. Completion drains initialized
delivery before teardown; an app that never initialized can complete without
waiting for initialization.

Config writers hold an exclusive native SQLite lock across their fresh read,
field update and write. The persistent `<config-path>.lock.sqlite` sidecar is
shared by the runtime, CLI and standalone example installers. Do not remove or
replace that sidecar while a writer is active. A competing write fails before
changing the config; retry after the other writer finishes. Project scaffolding
uses exclusive creation and never replaces an existing `.mcp.json`.
Onboarding state updates use the same transaction boundary and their own
`mcp-onboarding.json.lock.sqlite` sidecar, so independent setup and hint updates
cannot overwrite each other's flags.

The UI event stream owns the current tool input and its SSE event ID. A reopened
host gets those arguments in its HTML snapshot. Fresh replay starts at the current
call's input or its latest checkpoint, whichever is newer, so prior-call results
cannot follow the current snapshot. Replay retains the current input before that
call's results. Eager hosts omit replayed input
revisions at or before that snapshot; another call with identical
arguments still delivers its new input event. Stream-first hosts continue to
omit synthetic initial input and receive reused-call input through SSE.

A panel's first save or cancellation closes its input phase immediately.
The overlay remains visible while save persistence and live refresh finish,
but key repeats and cancellation cannot start another completion or overtake it.
Panel status and failure-message callbacks derive credential-store diagnostics
independently. The public callbacks retain their existing signatures; callers
can ask for either value first without preparing a diagnostic cache.

## Local checks

Use the npm version declared in `package.json`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix examples/interactive-visualizer --ignore-scripts --no-audit --no-fund
npm run check
```

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-mcp-adapter --source "$PWD" --host official --target latest --output /tmp/pi-mcp-adapter-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification. Preserve the separate extras checks in `.github/workflows/ci.yml`.

`npm run check` builds the example and root distribution, then requires formatting, full native `oxlint --deny-warnings .`, all four compiler projects, directive and policy checks, metadata cache and host browser freshness, Vitest, the four Node OAuth suites, and conformance. Independent stages keep running after a failure. Tests and package consumers that need emitted output are blocked when their build fails. Every failed or blocked required stage fails the aggregate.

`npm test` runs Vitest and the Node OAuth suites independently, retaining both results. `npm run check:quality` runs the non-writing quality checks after the example and root builds; it does not select or install another host. It includes the non-writing `check:cache-schema` and `check:browser` freshness checks. Generated bridge freshness remains checked by its actual Vitest owner, and builds verify uncommitted distribution assets. Named `lint:*` commands remain focused conveniences, not substitutes for full native lint. Adoption remains incomplete until the exact integrated revision passes all required local and hosted checks.

`lint:residual-tests` checks the remaining small root tests, their executed stdio and filesystem-fault fixtures, the standalone bridge probe, and the extracted credential-store test programs. Root compiler membership includes the checked CommonJS fixtures and bridge loader. The two credential suites copy one file-backed keyring program into their isolated directories. The Android binding remains a test double, not hardware qualification. QX-030 retains the original standalone-bundle callback assertions, and QX-031 preserves native coercion in the raw echo fixture. Full native lint in `npm run check` and the CI `check:quality` step covers this scope.

`lint:consumer-tooling` enforces the production profile for the selected-host resolver and packed-consumer loader, their result schemas and the checked CLI observer. The loader validates external JSON and checks the real SDK, gateway activation, reload and CLI registration against the selected host graph.

The same command enforces the production profile for `scripts/release-candidate.mjs` and its automation adapter. The launcher starts before source dependencies are installed, validates only the dynamic values it consumes, and preserves the selected automation's original host identity. Retained tarball, source, host-graph and packed-consumer checks remain owned by the release workflow.

The packed-consumer check also invokes `/mcp` and `/mcp-auth` through the selected host's RPC CLI with only the adapter's runtime dependencies present. It requires their UI notifications and successful command responses, so physical development peers cannot conceal a command-loading failure.

The command also checks the native-contract launcher under the production profile and `scripts/native-compat/` under the test profile. That directory contains only native SDK and CLI contract assertions and their HTTP, provider and extension fixtures. Its checked consumer uses ordinary ESM imports of the selected package and host. The scenarios retain nested-call redaction, cancellation without replay, tree and reload selection, saved-output paging, pinning and tool restrictions. The launcher resolves symlinked entrypoints before dispatch and rejects failed consumer assertions.

`lint:loader-runtime` enforces the production profile for gateway arguments, the typed loader and its catalog helper, the content registrar, and the canonical saved-result reader. It applies the test profile to the gateway-argument, loader, timeout, outcome and runtime-owner suites and their native loader and stdio/Unix-socket fixtures. Saved-result validation stays in the canonical reader, preserving field diagnostics, paging and UTF-8 boundaries.

`lint:host-runtime` checks the complete adapter factory, host runtime, its session phase record, command and tool registration, gateway dispatch, initialization, metadata, status, state cleanup, lifecycle and runtime ownership modules. It also checks their canonical UI-handle and status-event contracts, the root host and activation tests, the runtime directory, the native lifecycle/context fixtures, the affected directive-policy tests and the canonical abort-propagation suite with its proxy runtime fixture. The adapter-owned UI type includes an optional theme, preserving unstyled status for JavaScript hosts. QX-025 covers only Pi's native five-position execute callbacks, whose signatures derive from the installed SDK: the gateway's host tool callback here and the direct-tool callback under `lint:proxy-runtime`. `lint:ui-runtime` checks the complete `ui-server.ts` implementation and its shared handle contract. `lint:panel-runtime` owns `mcp-status.ts`.

`lint:tracing` enforces the production profile for `mcp-trace.ts`. Its disk, redaction and SDK transport tests are covered by `lint:runtime-tests`.

`lint:ui-runtime` enforces the production profile for all root `ui-*.ts` modules and `glimpse-ui.ts`: HTTP admission and completion, authenticated proxy routes, SSE delivery and replay, private durable history, resource metadata, session streams and optional viewers. `ui-server-contracts.ts` owns the public server handle; `ui-server.ts` re-exports it.

`lint:browser-runtime` enforces the production profile for `host-html-template.ts`, every handwritten `host-browser-*.ts` module and `scripts/build-host-browser.mjs`. `npm run build:browser` generates the committed `host-browser.bundle.js` with esbuild. The host bundle keeps `@modelcontextprotocol/ext-apps/app-bridge`, `@modelcontextprotocol/ext-apps`, `@modelcontextprotocol/core` and `zod` external. The host page's import map resolves them to the cached `app-bridge.bundle.js`, which `npm run build:bridge` generates from the native app-bridge API plus `EmptyResultSchema` and `z`. The UI server caches that asset for a year, so the import map adds the SHA-256 digest of its bytes as a `v` query; an upgraded host never links against an earlier cached copy. A custom `appBridgeModuleUrl` replaces only the app-bridge specifier and needs only `AppBridge` and `PostMessageTransport`. `tsconfig.build.json` excludes the handwritten browser modules from emit because only the generated bundle runs; the root compiler project still checks them. `npm run check:browser` regenerates in memory and compares without writing. CI extras requires this freshness check. The canonical build copies the committed asset beside `dist/host-html-template.js`; source installs do not need a browser or an additional bundling step. Only the generated bundle is excluded from compiler, lint and Oxfmt checks. Handwritten browser TypeScript remains fully checked and formatted.

`lint:build-tooling` covers `cli.js`, `cli.d.ts`, `vitest.config.ts`, the build, native bridge generator, prepare, compiler launcher, all-project compiler and packed-consumer type scripts, plus the example's install, uninstall and shared local-config scripts. Their production profile preserves standalone installation, CLI and atomic build-publication behavior. The CLI and standalone installers validate the containers they edit while preserving unrelated JSON properties and their serialization order.

`lint:ui-host-tests` covers `__tests__/ui-host/`, the root UI host-lifecycle, integration, resource-handler, server-session-recovery, server, streaming and viewer-none suites, and all `strict-ui-boundaries` and `host-*` fixtures. Native HTTP peers exercise resource schemas, session recovery and notifications. The served host and bundle tests retain heartbeat/watchdog, callback ordering, teardown and accepted-operation no-replay assertions. UI controls and layout are unchanged. The host tests execute the actual served browser bytes and served native AppBridge bundle in jsdom's separate VM realm, with real HTTP admission, SSE and completion callbacks. jsdom supplies the DOM, not layout or browser navigation. The fixture holds its iframe window stable while fetching the protected app over HTTP; actual navigation and visual behavior require Chrome verification. jsdom and its declarations are test-only dependencies; the complete DOM suites require the package's patched Node runtime (`^24.22.3 || >=26.13.1`). No desktop browser installation is required by `npm test` or by source builds.

`lint:example-runtime` checks all handwritten JavaScript and TypeScript under `examples/interactive-visualizer/`, including the UI, server, build script, and standalone install helpers. It also checks the root `interactive-visualizer-*.test.ts` suites and their filesystem-fault fixture under the test profile. Install the example dependencies before running it. The example compiler checks its source and scripts; the root compiler checks the suites and fixture. Oxfmt owns the handwritten files, and the example build owns its generated `dist/` output. Full native lint in `npm run check` and the CI `check:quality` step covers this scope. CI extras runs both the real stdio delivery and isolated installer suites after building the example.

`lint:core-runtime` enforces the production profile for cancellation, client-operation drains, process paths, legacy migration, onboarding storage, logging, panel keys, search ranking, the shared server-status derivation and Unix-socket transport. Rejections retain their original values. Transport cleanup failures reach the existing error callback.

`lint:manager-runtime` enforces the production profile for the manager, native client operation tracking, connection setup, callbacks, HTTP/stdio transports, disposal and lifecycle, session recovery and tool-transport outcomes. It also enforces the test profile for HTTP URL/header/auth configuration, native client-before-transport close ordering, AbortSignal propagation and its real HTTP fixture, session recovery policy/lifetime, real session cache and Pi reload suites. The same gate covers native integration fixtures and the complete proxy discovery, structured-content fallback, tool-call parity, UI server, streaming and viewer-suppression suites. Their initialized SDK clients, real HTTP peers and native Pi contexts retain the manager boundary contracts. Manager reconnect, shutdown, stderr, configuration and callback-lifetime suites remain covered by `lint:runtime-tests`. QX-010 covers only enumerated native callback assignments; QX-024 retains four enumerated supported SDK operations. Cleanup aggregates retain both failures in order and expose the caught cleanup failure as their cause. Full native lint also runs repository-wide.

`lint:config-runtime` enforces the production profile for `config*.ts`, `types.ts`, `public-types.ts`, `tool-names.ts` and `ui-message-types.ts`. It also checks the config, OpenCode interpolation and executable negative OAuth configuration suites under the test profile. File parsing validates known fields without stripping server, settings or OAuth extension properties. Malformed known fields warn and invalidate a Pi or shared file; malformed standard host entries are omitted. Legacy null values remain valid for server `command`, `socket`, and `oauth`, and for `settings.trace.file`. Only literal `disabled: true` disables a server; string values remain enabled. Other known fields retain their declared validation. Authentication semantics and command secrets remain lazy. QX-022 permits only the published five-position `isToolAllowed` predicate. Full native lint in `npm run check` and the CI `check:quality` step covers this scope.

`lint:sampling` enforces the production profile for the supported MCP sampling bridge. Its native model-registry and approval tests are covered by `lint:runtime-tests`. QX-017 permits only five deprecated MCP sampling types from their actual SDK package in these two files. Other deprecations and all other rules remain checked.

`lint:output-runtime` enforces the production profile for `mcp-output-*.ts` and the canonical `plain-result-reader.ts`: output guards, streaming previews, retained-result contracts, summaries and paged result reads. Raw MCP properties remain unknown until narrowed. The existing output suites, checked by `lint:output-tests`, verify artifact readback, private permissions, sparse paging, UTF-8 boundaries and native history append handoff.

`lint:proxy-runtime` enforces the production profile for `direct-tools.ts` and `proxy-*.ts`. It also checks the three root proxy discovery, manual-auth and UI-message suites, their real SDK fixture, the shared state and native-context fixtures, and the direct/proxy auto-auth and direct-tool discovery suites. Here QX-025 covers only Pi's five-position direct-tool callback; its three host tool callbacks are under `lint:host-runtime`. Internal search, connection and call requests use object arguments. The command also checks the migrated abort-signal, tool-call-parity, tool-approval, structured-content fallback, session-recovery integration and UI-viewer suites. They use complete state and native contexts, real MCP transports, and isolated HTTP session-expiry fixtures. The focused suites preserve catalog paging, native request options, cancellation, hook forwarding, ordered history, private disk permissions and failed-delivery retention. `lint:quality` owns the exception inventory's implementation and control suites. Other internal callers remain under their existing gates.

`lint:runtime-tests` includes native Pi gateway selection, reload, lazy startup and initialization tests, plus the standalone startup child. These tests use the installed Pi graph selected by qualification. The child installs module hooks before importing Pi, loads the source extension, and executes its first stdio call. Initialization tests use a real Pi context and public health-check timers.

The runtime scope includes disabled-server, elicitation-policy, footer, stale-context and failure-state initialization tests. Complete native contexts and owned managers replace partial host objects. Real HTTP capability and callback delivery, a stdio cwd tool, config files and SDK context invalidation retain the initialization contracts. Footer assertions retain the deliberate JavaScript-host missing-theme fault. Failure-state tests cross the expiry timer and verify owner shutdown prevents publication.

The runtime scope also includes the real HTTP callback-lifetime suite and its server fixture. It covers callback cancellation and reply drain, token reads and persistence, subscription refresh, URL completion and accepted-operation no-replay through native Pi contexts and MCP transports.

Manager configuration tests use real HTTP and stdio connections for capability advertisement, callback replies, cwd selection and native request options. A call-through native client records its actual constructor callbacks for the replaced-client and failed-refresh races.

The runtime scope also includes manager reconnect, owner-shutdown and stderr tests. Real loopback HTTP handshakes verify shared connection cancellation, replacement and stale-connection guards. Native SDK subclasses observe constructors and hold handshake completion for controlled races without replacing transport behavior. A real stdio child verifies captured stderr, native error causes and byte bounds. Focused fault injection retains the cleanup-failure and oversized string-event branches.

The runtime scope includes the stock-dialog elicitation and real stdio SDK suites. A typed three-method dialog fixture preserves selection/input order and notification history. Complete native extension contexts and state back the direct/proxy tool, resource and UI-resource cases. QX-007 covers only the initialized capability accessor in each of the two enumerated legacy stdio fixtures.

`lint:oauth-runtime` enforces the production profile for `mcp-auth-flow.ts`, `mcp-callback-server.ts`, the nine `mcp-oauth-{provider,runtime,config,discovery,request,response,start,registration,client-auth}.ts` owners, and `elicitation-{handler,form-dialog,form-values,form-schema}.ts`. OAuth configuration and registration mappings retain the canonical persisted-record schemas and native SDK provider methods. Internal provider construction uses named options; request challenge and issuer updates share a binding context. OAuth cleanup aggregates retain the primary and cleanup failures in order and expose the cleanup failure as their cause. The success page serializes the checked `closeAuthorizationWindow` function as its only inline script; a Vitest suite runs the served page in jsdom's separate window realm and verifies the two-second close. Every auth operation names the OAuth runtime that owns it; there is no shared default runtime. `lint:manager-runtime` checks the connection callers.

`lint:credential-runtime` enforces the production profile for native keyring loading, credential-store diagnostics, Linux recovery dispatch, its standalone CommonJS helper and `mcp-auth.ts`. Native declarations type the lazy synchronous module loads. QX-013 preserves the primary loader failure, and QX-018 covers only the three enumerated native module assertions. Credential operations require an explicit `{ serverName, serverUrl }` identity, separate from legacy directory options. `saveAuthEntry` borrows its input and persists a copy whose URL comes from that identity without mutating the caller's record. Versioned accounts hash the JSON name-and-exact-URL tuple. Matching name-only current-service and plaintext imports are verified before source removal; logout consumes matching automatic-import sources without touching another URL. QX-021 types only the installed lazy Zod load, preserving cached startup without Zod. Structural validation retains the original JSON property order. Canonical schemas validate persisted records before use or plaintext migration, preserve extension fields and leave legacy redirect validation with the OAuth flow. Malformed known fields fail before secure writes or plaintext deletion. The same scope includes the payload store for hashed accounts, manifest validation, chunk reads/writes and cleanup. The storage suite retains real child-process recovery, platform diagnostics, chunking and plaintext migration checks.

`lint:auth-boundaries` checks the real HTTP bearer-auth suite, the SDK OAuth compatibility suite and the isolated Android keyring probe. The first suite uses the native client and transport with received-header assertions. The OAuth suite retains PKCE, issuer, refresh, cancellation and no-replay checks. The Android probe blocks external access and uses the isolated implementation prepared by the storage suite. It tests loader diagnostics, not Android hardware.

`lint:resource-runtime` enforces the production profile for consent decisions, metadata cache reads and writes, npx invocation and resolution caches, prompt commands, resource dispatch, tool approval and metadata, result rendering, and shared utilities. It also checks the approval suite and its real stdio fixture, the cache lifetime suite and its separate-process writer fixture, and native URL error and byte-contract tests. QX-026 covers only constructor-based URL validation. Internal request objects retain the real transport, callback and cancellation paths. Full native lint and all four compiler projects also check the resource callers and catalog suites.

The resource scope includes `scripts/generate-metadata-cache-schema.mts` and its generated `metadata-cache-validator.ts`. The generator derives native fields from the installed SDK schemas with Zod's JSON Schema API. It adds only cache-envelope fields and legacy tool UI fields, makes legacy tool input schemas optional, and selects the prompt fields that the cache persists. TypeBox validates the generated input schema without loading MCP or Zod, parsing outputs, stripping extensions, or replacing record references. The native predicate must satisfy the existing cache consumers' SDK-derived types.

Run `npm run generate:cache-schema` after changing the cache contract or its dependencies. Oxfmt owns formatting of the generated TypeScript, which retains normal lint and compiler coverage. The artifact records installed SDK, Zod and formatter versions and a digest of both input and output contracts. TypeBox compiles the schema at runtime using the selected host graph. `check:cache-schema` compares fresh generation without writing files. Builds and CI require this check. The quality suite verifies valid, changed-input and restored-input controls.

`lint:sdk-http` enforces the test profile for the real HTTP SDK suite, its typed native capture extension fixture, and `__tests__/protocol-config.test-d.ts`. The latter compiles deliberately invalid calls and verifies runtime rejection before any HTTP request; a valid counterpart connects through the same manager boundary. Latest-host qualification supplies one consistent SDK graph for their static imports and Jiti-loaded factories.

`lint:node-oauth` covers the four root Node OAuth suites and their native-loader fixture. QX-019 permits only the `nodeIt` and `nodeDescribe` imports from `node:test` in those four root files. Registrations retain Node's scheduling. Context subtests and other asynchronous work still require ownership. The loader test uses synchronous `registerHooks` and restores its hooks and process descriptors. Invalid OAuth argument tests run in the compiler-checked negative configuration suite.

`lint:lifecycle-tests` enforces the test profile for the adapter's native SDK lifecycle tests, their extension fixture, and the shared complete SDK context fixture.

`lint:oauth-recovery` enforces the test profile for the real HTTP OAuth recovery suite and its native Pi and HTTP fixtures. The suite covers callback validation, scope recovery, cancellation, accepted-operation no-replay, and interactive and headless callers.

`lint:oauth-flows` enforces the test profile for the provider, client-credentials, private-key JWT, cross-app authorization and client-metadata document suites, their shared HTTP and wire fixtures, and their standalone stdio and shutdown fixtures. The OAuth configuration suite runs as both executable runtime validation and a dedicated negative type test: the compiler verifies described invalid API arguments, and Vitest verifies their real rejection and redaction. All HTTP, PKCE, refresh, signing, cancellation, storage and source-laziness assertions remain active. Malformed stored client-metadata callbacks enter through raw legacy JSON in an isolated credential directory, not an unsafe typed API call.

`lint:panel-runtime` enforces the production profile for `commands.ts`, `mcp-*-commands.ts`, `mcp-panel*.ts`, `mcp-setup-*.ts`, and `mcp-status*.ts`. It also checks the panel, status, command-authentication and index-lifecycle suites and their complete native context, state and host fixtures. The native panel child starts an isolated interactive host with piped terminal I/O. It verifies overlay disposal and factory-rejection ownership. It also saves a pin through the real overlay: the overlay stays open until the project file is written and live refresh finishes, and the success or failure notice appears before it closes. Internal panel and authentication APIs use options objects. The status-event sink lives in `mcp-status-events.ts`, with its existing type re-export retained in `mcp-status.ts`. The host command callers in `host-commands.ts` and the status import in `state.ts` are checked by `lint:host-runtime`.

The auth, runtime and panel scopes include the command authentication, status, onboarding and credential-storage suites. They use complete native Pi contexts and real panel components. They verify URL notifications, failure diagnostics, pending authorization cancellation and the disk writes that preserve inherited server definitions.

`check:directives` accepts only the operation-bound lint exceptions in `quality-exceptions.json`, documented in [quality exceptions](quality-exceptions.md). It rejects copied, replaced, duplicated, stale and incorrectly attached directives. The packed-consumer type fixture and the executable OAuth, protocol configuration and catalog metadata suites are dedicated negative type tests. Their `@ts-expect-error` comments require a description. `__tests__/catalog-metadata.test-d.ts` types every metadata row as SDK tool metadata. The compiler rejects only the described null row, which the SDK and cache validators also reject. Vitest includes this file and checks every row against the official extraction. Other TypeScript error suppressions, file-wide and range disables remain prohibited.

`check:policy` compares the root lint and formatter configurations with the adopted standard and declared profiles. It rejects nested quality configs and ignored maintained source, checks resolved compiler settings for root, build, declarations and example, and uses native compiler file membership to verify coverage. The production build must not import the declared test-only scopes. Concrete npm entrypoints and independent CI step conditions are also required. Native fault controls exercise failure propagation through the actual runner on reduced disposable projects. These checks do not prove the semantic justification of an editable exception record, every dynamic dependency, or hosted execution.

## Automatic npm releases (maintainers)

The `npm version` workflow queues main merges and opens a reviewed patch-version PR through the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases). A version PR opens when a merge changes the package users install; a merge that changes only CI, tests or development tooling ships with the next release. The `npm release` workflow publishes after full CI (including extras) and retained-candidate qualification pass. Verify the matching npm and GitHub releases; workflow validation is not evidence of a real OIDC publication.

Failed or unpublished candidates can retry daily at 12:17 UTC or through manual dispatch on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed.

The reusable `release-qualification.yml` gate installs the retained candidate tarball into an isolated consumer against each selected Pi host. It checks the native SDK and CLI, gateway activation and reload, local MCP transport behavior, and published declarations without repacking. Candidate and full host-graph identities are checked against the shared preparation receipt.

## Pi release qualification

Pi **1.5.2** is the support floor; host peers remain wildcard. Required qualification uses the latest stable official Pi and latest maintained fork `main`, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not qualification targets. Extras use the same resolved official graph. `npm run check:compat` verifies the installed SDK and CLI identity, builds and typechecks, runs Vitest and memory-only OAuth tests independently, then loads a packed consumer through the native SDK and CLI. The native identity and successful build are prerequisites for the packed consumer. The compatibility Vitest command retains its separate interactive-visualizer exclusion; extras verifies that example after its real build.

GitHub CI runs that contract on Node 24 against both official Pi and the maintained fork through the shared Pi compatibility automation, including fresh Git and npm installations loaded by the real Pi CLI. A second job checks lockfile registry hosts, published type declarations, the built interactive visualizer, and MCP protocol conformance. These checks use local MCP fixtures and disposable agent directories, never live credentials or paid providers.

Keep the locked development TypeBox snapshot aligned with its locked Pi cohort; qualification selects the latest host's actual companion graph independently. Standalone TypeBox updates are disabled: a second version in source installs adds measurable startup cost. Published peers remain optional wildcard dependencies, and qualification selects each host's actual TypeBox version.

## Android/Termux source builds

On **Android/Termux**, Git/source installs and type checks require an Android-native
TypeScript 7 compiler as `tsgo` on `PATH`. The [Fold development environment](https://github.com/fitchmultz/fold-dev-environment)
provides a pinned native build (validated with `7.1.0-dev.20260904.1`). npm's TypeScript
package has no Android binary, and its Linux binary probes a syscall Android blocks.
macOS/Linux use the package-local pinned compiler. Published precompiled packages
do not need a compiler at runtime.
