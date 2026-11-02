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
npm run lint:prompts
npm run lint:runtime-tests
npm run lint:tracing
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

Strict lint is enforced for `conformance/`, the prompt tests and their shared fixtures, `__tests__/runtime/`, `__tests__/auth/`, `__tests__/discovery/`, `__tests__/state/`, `__tests__/output/`, `__tests__/packaging/`, `__tests__/ui-host/`, `__tests__/panel/`, and the pinning test fixture. Repository-wide strict lint remains a migration target.

`lint:tracing` enforces the production profile for `mcp-trace.ts`. Its disk, redaction and SDK transport tests are covered by `lint:runtime-tests`.

`check:directives` accepts only the operation-bound lint exceptions in `quality-exceptions.json`, documented in [quality exceptions](quality-exceptions.md). It rejects copied, replaced, duplicated, stale and incorrectly attached directives. The packed-consumer type fixture is the only approved negative type test; its `@ts-expect-error` comments require a description. Other TypeScript error suppressions, file-wide and range disables remain prohibited.

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
