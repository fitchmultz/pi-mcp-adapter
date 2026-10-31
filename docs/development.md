# Development and releases

See [AGENTS.md](../AGENTS.md) for repository test conventions and [.github/workflows/ci.yml](../.github/workflows/ci.yml) for the full CI contract.

## Local checks

Use the npm version declared in `package.json`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix examples/interactive-visualizer --ignore-scripts --no-audit --no-fund
npm run --prefix examples/interactive-visualizer build
npm run build
npm run typecheck
npm test
npm run test:conformance
```

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-mcp-adapter --source "$PWD" --host official --target latest --output /tmp/pi-mcp-adapter-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification. Preserve the separate extras checks in `.github/workflows/ci.yml`.

## Automatic npm releases (maintainers)

The `npm release` workflow uses the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases) to publish an unpublished package version on `main` after the full existing CI workflow (including extras) and candidate-tarball qualification pass. Complete applicable package-specific release evidence and verify the matching npm and GitHub releases; workflow validation is not evidence of a real OIDC publication.

Failed or unpublished candidates can retry daily at 12:17 UTC or through manual dispatch on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed.

## Pi release qualification

Pi **1.0.0** remains the support floor; host peers remain wildcard. Required qualification uses the latest stable official Pi and latest maintained fork `main`, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not qualification targets. Extras use the same resolved official graph. `npm run check:compat` verifies the installed SDK and CLI identity, builds and typechecks, runs Vitest and memory-only OAuth tests, then loads a packed consumer through the native SDK and CLI.

GitHub CI runs that contract on Node 24 against both official Pi and the maintained fork through the shared Pi compatibility automation, including fresh Git and npm installations loaded by the real Pi CLI. A second job checks lockfile registry hosts, published type declarations, the built interactive visualizer, and MCP protocol conformance. These checks use local MCP fixtures and disposable agent directories, never live credentials or paid providers.

Keep the locked development TypeBox snapshot aligned with its locked Pi cohort; qualification selects the latest host's actual companion graph independently. Standalone TypeBox updates are disabled: a second version in source installs adds measurable startup cost. Published peers remain optional wildcard dependencies, and qualification selects each host's actual TypeBox version.

## Android/Termux source builds

On **Android/Termux**, Git/source installs and type checks require an Android-native
TypeScript 7 compiler as `tsgo` on `PATH`. The [Fold development environment](https://github.com/fitchmultz/fold-dev-environment)
provides a pinned native build (validated with `7.1.0-dev.20260904.1`). npm's TypeScript
package has no Android binary, and its Linux binary probes a syscall Android blocks.
macOS/Linux use the package-local pinned compiler. Published precompiled packages
do not need a compiler at runtime.

