# MCP adapter

## Test ownership
- Use the real HTTP, stdio, SDK or host-event boundary for transport, delivery and lifecycle contracts. Keep focused helper tests only for distinct validation or race conditions the stronger boundary cannot exercise.
- Assert actual outcomes: served app/bundle bytes, received SSE events, callback results and disk history. Do not replace these with fixture identity, source inventories, conditional assertions that accept errors, or mocks that implement the claimed deduplication.
- Preserve private disk permissions, paging and UTF-8 boundaries, ordered UI history, accepted-operation no-replay and native transport cancellation/drain contracts. Slow fsync tests and dependency/package/security byte checks are not deletion candidates merely because they are slow or static.
- Heartbeat success is not timeout prevention unless a test crosses the timer boundary. Bind occupied-port fixtures to a separately allocated port; never silently return on a collision.

## Local validation
- Qualify latest stable official Pi and latest maintained fork main using complete selected host graphs; resolve version/commit once per workflow run and retain exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not qualification targets. Plain npm ci checks only the snapshot; the shared qualifier selects latest before the commands below.
- Install with the `packageManager` version in `package.json`; use `npm ci --ignore-scripts --no-audit --no-fund`.
- Build the example before the complete suite: `npm ci --prefix examples/interactive-visualizer --ignore-scripts --no-audit --no-fund`, then `npm run --prefix examples/interactive-visualizer build`.
- Run `npm run build`, `npm run typecheck`, `npm test` and `npm run test:conformance`. `npm run check:compat` additionally checks the selected native host and packed package.
- Follow `.github/workflows/ci.yml` for public-registry lockfile and packed-consumer type checks. Native compatibility checks must use one isolated, internally consistent host graph.
- Never edit source or tests while checks are running in that checkout.

## Dependency maintenance

- Frequently and proactively check releases and make appropriate upgrades across maintained packages and all runtime, development, build, test, and tool dependencies, prioritizing the latest stable official Pi and the intended maintained Pi fork. Routine in-scope maintenance needs no repeated approval; delivery remains subject to existing authority and gates.
- Review crossed release notes, changelogs, migration guidance, and security advisories before upgrading. Verify real APIs and contracts across supported hosts and platforms using each target's exact SDK/CLI and compatible, consistently locked dependency cohort, including host-supplied companions. Preserve lockfile policies, peer contracts, and support floors; a matching version string or locked snapshot alone is not latest-host qualification.
- Adopt beneficial current conventions, patterns, APIs, and functionality instead of extending deprecated or obsolete approaches. Preserve supported behavior and independent use; align affected callers, documentation, generated surfaces, and fixtures through their canonical owners.
- Follow [development and release rules](docs/development.md) and [full CI contract](.github/workflows/ci.yml). Run all applicable required lint, format, type, test, build, package, native, CI, and review gates; report exact targets, commands, results, skips, and unverified limits honestly. Documentation checks alone do not qualify runtime behavior. Never weaken safety, checkers, fixture contracts, or supported-target requirements to make an update pass.
- Roll out updates controllably with a rollback path through existing review, approval, and release gates; honor every explicit hold. This authorization is not blanket permission to publish, install into or restart an active runtime, disclose private data, or change global model or authentication settings.
