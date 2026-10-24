# Issue 94 evidence

## Result

Faster on the public synthetic Linux workload. Real Pi SDK session replacement decreased from 200.45 ms to 153.99 ms, a 23.2% reduction. These are fresh current-main and candidate source measurements, not the historical issue timings or installed macOS measurements.

Each side ran five separate processes in alternating A/B order. Each process measured six session switches and six branch navigations. The reported statistic is the median of those five process medians. The byte-identical metadata input SHA256 is `06c4001427d974bc69a969e39d49a799317824491844b010cbd25476b46943a4`.

| Boundary | Main median | Candidate median | Main process-median range | Candidate process-median range |
| --- | ---: | ---: | ---: | ---: |
| Native SDK `AgentSessionRuntime.switchSession` through bound extension readiness | 200.45 ms | 153.99 ms | 188.14 to 215.74 ms | 151.57 to 168.64 ms |
| Native SDK `navigateTree`, including `session_tree` and selection restoration | 11.56 ms | 1.89 ms | 10.52 to 12.05 ms | 1.87 to 2.04 ms |
| Warm metadata load, with returned descriptors consumed | 9.399 ms | 0.0157 ms | 8.592 to 9.752 ms | 0.0093 to 0.0183 ms |

The warm helper is one load, about 4.7% of the baseline switch duration. Session replacement performs multiple metadata loads and tool synchronizations. The end-to-end saving does not extrapolate the helper's ratio to the whole operation.

The first metadata load is not the warm result. Its five observations are retained in `matched/summary.json` in the raw archive. Cold parse plus immutable-snapshot construction adds work. The cold ranges overlap, so this evidence does not establish a cold-load improvement.

## Workload and timed region

The driver creates a 4,421,203-byte synthetic cache with eight configured servers, 640 configured tools, and 46 expired recovery servers. There are 54 cached servers and 2,480 cached tools in total. Each synthetic session has 400 unrelated history entries and two different selection snapshots. No real session or account data is used.

Every process consumes 12 metadata-load results, completes six actual runtime replacements, and completes 12 actual tree navigations. Six return navigations are checked but excluded from the tree timing. The host reports 651 registered tools. Assertions check all 640 configured tool registrations, exact active tools on each branch, descriptor content, and zero extension errors. Any assertion or runtime error exits nonzero. All ten measured processes exit zero.

The switch timer covers the real SDK runtime replacement, fresh resource loading, SessionManager open, extension binding and session_start, plus one event-loop turn to settle cached initialization. It ends before the active-tool and output checks. Fixture generation, SDK imports, initial runtime creation, and assertion work are outside that region. No model request or remote MCP operation is part of this workload. Separate native package qualification exercises real local MCP HTTP traffic, actual CLI RPC, schemas, cancellation, and tool execution.

Both sides use recently written files in the same OS page cache conditions. Both use the same compiled production build configuration, Node v24.22.1, npm 12.2.0, official Pi 1.4.0 cohort, and host TypeBox 1.3.27 on this two-core Debian cloud workspace. The run starts at the load average recorded in `matched/environment.txt`. No other build or test runs during the measured A/B sequence.

## Limiter and implementation

Separate CPU-profile runs are not timing samples. The baseline profile locates repeated cache read/parse and tool serialization in the adapter. The remaining candidate limiter is the host's tool registry refresh and registration, which this PR does not change. The profiles and aggregate self-time summaries are retained in the raw archive.

The cache owner retains one immutable parsed snapshot per file revision. Device, inode, size, nanosecond modification time, and change time identify the revision. A second stat prevents a concurrent replacement from being cached under the wrong revision. Missing, repaired, replaced, or differently located files are observed on subsequent reads. Trust-disabled reads return null before any snapshot lookup.

Tool projections and registration fingerprints reuse immutable metadata. Mutable live discovery metadata still receives fresh fingerprints. Config/trust resolution, resolved server identity checks, runtime shutdown/startup, branch selection restoration, name collisions, and host allowlists still run. There is no config-hash-only lifecycle shortcut and no transport or credential reuse.

Save/merge rereads disk rather than using the retained read snapshot. It removes recognized expired entries unless the caller protects a currently configured server or explicitly supplies that entry. Unknown records remain intact. A disk proof removes all 46 expired recovery entries while retaining the eight current servers, reducing this synthetic file from 4,421,203 to 1,251,341 bytes despite pretty-printed output. The existing read/merge/atomic-rename protocol is unchanged. Simultaneous overlapping save transactions still have the pre-existing last-writer limitation. This PR does not introduce a cross-process locking protocol.

## Provenance and reproduction

- Baseline `origin/main` was resolved at admission as `d01434ea56e89b6a15d9e085c73c53cdf521a988`.
- The candidate runtime patch and source/build hashes are in the raw archive. They identify the exact measured implementation independently of later evidence-only commits.
- [Configured model evidence](actual-model-evidence.json) records the coordinator's owner-authenticated active configuration, `openai/gpt-6.1-sol` with `xhigh`.
- [Decision trail](decisions.md) records the pinned pstack workflow, chosen data shape, and verification checkpoint.
- `scripts/benchmark-session-cache.mjs` is the rerunnable measurement driver. `summarize.mjs` verifies equal input hashes and work counts before it reports medians.
- `synthetic-evidence.tar.gz` retains raw commands, all samples, profiles, failed attempts, and synthetic Pi JSONL journals. No journals are deleted as artifact cleanup.

Run the benchmark from a build of this branch, pointing `--source` at each independently built worktree. Reuse one `--timestamp` value across all ten invocations. The full measured commands are in `matched/commands.txt` in the archive.

```bash
node scripts/benchmark-session-cache.mjs --source /path/to/worktree --output /path/to/sample.json --fixtures /path/to/disposable-fixtures --timestamp 1792849100000
node perf/issue-94/summarize.mjs /path/to/five-alternating-pairs
```

The fixed timestamp must still be within the cache lifetime when replayed. Choose a fresh common timestamp for a later run. Keep both sides' toolchain and selected host graph identical.

## Compatibility and limits

The package manifest, lockfile policy, optional wildcard peers, Pi 1.0.0 support floor, and Node 24 floor are unchanged. No dependency upgrade is part of this PR. Latest-release inspection found official Pi 1.4.0, MCP client/core 2.4.0, and TypeBox 1.4.3. Tests retain the adapter's MCP 2.3.1 dependencies and the selected host's actual TypeBox companion rather than independently upgrading either graph.

Official Pi 1.4.0 release notes explicitly cover resumed extension-tool selections and coherent companion pinning. The test driver uses the real current APIs rather than replacing those contracts with mocks. Maintained fork main was independently resolved once as `c17adbc400319887c5ab34fce1ed2a59be746da4` and built in this isolated cloud workspace. Exact host SDK, CLI, lock, tarball, and probe evidence belongs in the qualification artifact.

Installed macOS runtimes, the owner's private corpus, macOS and Android execution, live activation, and publication are NOT RUN. Historical issue measurements came from old installed builds and are diagnosis hints only. Local and GitHub qualification results are recorded separately from these source/cloud timing claims.

## Completed latest-host qualification

Both local shared-automation lanes pass on implementation commit `e8644bd3d7470d0564f586a98c94d25be1dd228b`, with a clean source tree. See [qualification.json](qualification.json) for exact SDK and CLI hashes, selected companions, package integrity, and lane outcomes. `qualification-evidence.tar.gz` retains both full reports, actual selected host lockfiles and trees, fork build receipt, packed adapter artifacts, native CLI stdout JSONL, and all qualification logs.

The official lane uses latest stable Pi 1.4.0. The maintained fork lane uses main commit `c17adbc400319887c5ab34fce1ed2a59be746da4`, built and packed with its coherent companion graph. Each lane passes `npm run check:compat`, a fresh Git consumer install, a packed npm consumer install, and actual native CLI RPC probes. The separate packed external consumer type check also exits zero.

The following evidence-only commit does not change executable source, tests, package contents, or the measured runtime patch. Current-head GitHub CI and independent review remain separate delivery gates.
