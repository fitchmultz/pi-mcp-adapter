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
