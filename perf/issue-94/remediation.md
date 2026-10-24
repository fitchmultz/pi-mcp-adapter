# Issue 94 coordinator remediation evidence

This is the 2026-10-24 follow-up to the coordinator's [changes-requested audit](https://github.com/fitchmultz/pi-mcp-adapter/pull/95#issuecomment-6385458072). Earlier records under commit `809c68c396de927f4c5c499b099874281fd63d8d` remain historical evidence, not current-head acceptance. No historical record is rewritten to imply an earlier review or a maintained-fork timing run.

This directory, its task archives, and the one-off benchmark driver are retained in PR ancestry and removed in the following commit. They are not continuing product tooling and receive no artificial CI ritual. The final PR diff is the cache implementation, regression tests, and changelog. The PR links this evidence by full immutable commit and blob identities.

## 1. Matched maintained-fork performance and identity

Maintained fork main was independently re-resolved at remediation admission to `c17adbc400319887c5ab34fce1ed2a59be746da4`. The existing packed build receipt verifies that exact source commit and every cohort tarball. The shared automation at `9b08d65d70a01c74c4e01477ccf9473e86be33ee` prepares one coherent host, including TypeBox 1.3.37, and selects that graph for both existing adapter worktrees. Baseline node_modules points at the same selected development graph. Both sides use the identical SDK bytes, not merely the same printed 1.4.0 version.

Each sample records and asserts the realpath of the actually imported SDK, its SHA256, actual CLI path/hash, installed-lock path/hash, host-lock identity, selected packed artifact identities, implementation commit, and compiled runtime hashes. It also records all 30 individual successful request assertions and the aggregate work counters. Host and artifact hash validation is outside the timed regions.

- Actual SDK index SHA256: `8571698d27d098f224e684565fdf7bbcba72c0172b875adf59f0b7c088a94554`.
- Actual CLI SHA256: `ded5a256890d696a7aca93e62cf5ba26b0d63e1d176c6c97103b8df476c19e48`.
- SDK tarball SHA256: `3515c5895cca322bd51a4f8a904d92765628b815dc76cdc639c29fd21c781fe3`.
- Prepared host lock SHA256: `bbbcd1495e231ea9c236349be0b9af1c2efaac4ae2f5a718b9bb3fd46587230a`.
- Actual selected installed-lock SHA256: `3a0a573c3df02df2d6f8f6d1f6bd56161d7640c004643770cd327048e4ae34f6`.

The official SDK index is different: `4569157e6038be9840fa514db4b00a27fd0be9e3622cc7b49a281de6c027d7ff`. Version 1.4.0 alone cannot distinguish the hosts.

Five alternating A/B process pairs run in order A1 B1 B2 A2 A3 B3 B4 A4 A5 B5. All ten processes exit 0. Each consumes 12 cache loads, completes six actual SDK session replacements and 12 actual tree navigations, verifies 640 configured tool registrations and both branches' exact active tools, observes 651 registered tools, and records zero extension errors. All 300 individual request assertions pass. The 4,421,203-byte metadata input is byte-identical across every sample and the old official run, SHA256 `06c4001427d974bc69a969e39d49a799317824491844b010cbd25476b46943a4`.

| Maintained-fork boundary | Main median | Candidate median | Main process-median range | Candidate process-median range |
| --- | ---: | ---: | ---: | ---: |
| Real SDK session switch, including extension readiness | 208.63 ms | 168.43 ms | 203.51–223.28 ms | 157.66–183.95 ms |
| Real SDK first tree navigation per iteration | 13.16 ms | 2.33 ms | 12.26–13.81 ms | 2.09–2.93 ms |
| Warm cache load, consumed output | 10.044 ms | 0.0171 ms | 9.329–10.782 ms | 0.0121–0.0216 ms |
| First in-process cache load | 9.39 ms | 13.86 ms | 8.61–11.26 ms | 11.02–16.39 ms |

The warm session-switch median decreases **19.3%**. The first-load median **regresses by 4.47 ms / 47.6%**. “Cold” here means the first parsed-snapshot load in a new process, not an evicted OS page cache. Both sides read newly written files under the same page-cache conditions. Deep freezing trades a one-time cost for warm reuse. The five-point cold ranges overlap slightly; no population-level significance or cold-start improvement is claimed.

### Historical official-Pi result, kept explicitly separate

The earlier official Pi 1.4.0 / TypeBox 1.3.27 workload measured session switches **200.45 → 153.99 ms**, 23.2% lower. Its first-load median was **7.94 → 11.60 ms**, **3.66 ms / 46.2% higher**, with ranges 6.91–16.19 → 11.23–19.92 ms. Those old valid raw observations are preserved unchanged. The new summarizer reports their cold medians explicitly. They are not maintained-fork timings and are not measurements of the later future-pruning correction.

### Measurement scope and remaining limiter

Adapter main is the original admission/base `d01434ea56e89b6a15d9e085c73c53cdf521a988`. Fork timing uses candidate implementation `1f3beb286f731d6d14b6ea320bc86ea128993056`. The identity-enhanced reproducer is committed in `9375a616fe30b26919e5c00efaad1624d79549c7`. Later executable production bytes are identical; follow-up changes are test retention/accuracy, changelog whitespace, task evidence, and task-tree removal. `fork-matched/candidate-files.sha256` and `qualified-files.sha256` identify exact source/build/test inputs.

The timer boundaries are unchanged from the old driver: real SDK runtime replacement plus extension binding and one settling turn; first tree navigation only, with the second navigation asserted but excluded; metadata load with descriptor consumption. Fixture generation, SDK import, initial runtime creation, and correctness assertions are outside the switch timer. Node is v24.22.1; benchmark/build graph selection uses isolated npm 12.2.0 on the two-core Debian cloud workspace. No concurrent build/test runs during the ten timing samples.

Independent fork A/B CPU profiles are not timing samples. Main profile self time includes 285.97 ms in loadMetadataCache and 119.98 ms in adapter sync; the candidate's largest self-time function remains the host's _refreshToolRegistry (429.83 ms across the profile). Profiles include process setup and all iterations, so those totals are not switch medians or a new end-to-end timing claim. The host registry is outside this adapter PR.

A fresh corrected-source save proof retains all eight configured entries, removes all 46 expired recovery entries, and shrinks the synthetic cache from 4,421,203 to 1,251,341 bytes. No real/private cache is used.

## 2. Evidence location and scope correction

Keep the existing old archives, every failed attempt, and every synthetic Pi JSONL journal in immutable PR ancestry. The new `remediation-evidence.tar.gz` contains fork samples and request assertions, exact host identities and locks, input fixtures, new profiles, red/green tests, the protection-wiring mutation failure, fresh qualification reports/CLI transcripts, source hashes/patch, full local gates, and a journal manifest. The benchmark and summarizer are available by commit-pinned source links. No release, gist, unrelated branch, force push, or history rewriting is used.

This is the coordinator's maintainability/scope decision, not a universal ban on committed evidence. The earlier archive README/decisions retain their historical status wording; they are not current delivery claims. The old PR handoff is explicitly marked historical and superseded. Current PR claims and links are updated to this evidence and later exact-head check/review outcomes.

## 3. Changelog

CHANGELOG.md Unreleased follows existing Changed/Fixed headings. It describes immutable snapshot/descriptor reuse and recognized expired/future entry pruning, with configuration/branch validation and protected/unknown retention intact. No package version or release changes.

## 4. Future-dated entries

Save now prunes a recognized unprotected record when cachedAt is greater than the current clock, matching the existing load rejection. This deliberately covers only the same recognized positive-finite timestamp/descriptor shape, not arbitrary malformed or future-format records. Incoming entries and all configured server names remain protected, including future-dated entries. Fresh disk read/merge and PID-temp atomic rename are unchanged. The pre-existing overlapping-save last-writer limit is not fixed or disguised.

The pre-fix regression leaves recovery-future behind and exits 1. Corrected source passes. Unknown future-format data, explicitly supplied future entries, and selected future entries survive. No clock-skew deletion applies to current/incoming/unknown records.

## 5. Real-event test accuracy, wiring and journals

The branch-selection test is renamed to claim only what it observes. A separate test in the same real Pi SessionManager harness restarts through session_start with two configured servers, connects a real local stdio MCP fixture through the native registered gateway, and reads the actual disk save. It verifies the newly discovered catalog, preservation of another configured server's expired record and unknown future-format data, and pruning of expired/unprotected future recovery entries. Removing Object.keys(state.config.mcpServers) at the production save call makes this exact host-boundary test fail because the protected record disappears. Restoring the existing wiring makes it pass. No test-only production seam or duplicate helper-only protection test is added.

The harness now appends a public synthetic assistant message before its selection snapshots, forcing real SDK journal persistence. Test cleanup removes only disposable non-journal resources, retains sessions and root JSONL, and prints each retained fixture root. With the shared qualifier's existing PI_COMPAT_EVIDENCE_DIR, it also copies the journals into retained qualification probes before the qualifier tears down its outer temporary root. The dedicated retention proof captures all three new test journals; both full qualifier lanes capture three each.

**Explicit rebuttal:** deleting these synthetic Pi journals under a generic temp-folder cleanup suggestion conflicts with the owner's program retention rule. That suggestion is not followed. Only disposable cache/config/model resources are cleaned. Actual owner history is neither read nor deleted. Local copies under /workspace/evidence remain retained, including failed-attempt journals.

## Fresh local gates

Source `9375a616fe30b26919e5c00efaad1624d79549c7`, clean tree, passes shared official and maintained-fork qualification. Both run the native SDK/CLI contracts, 112 Vitest files / 1,581 tests (the shared contract intentionally excludes the three example UI tests), 93 OAuth tests, packed external SDK/MCP smoke, Git consumers, npm consumers, and actual CLI RPC. Their four stdout JSONL transcripts and six harness journals are retained. Each report records actual npm 11.19.1 selected by the shared qualifier's process-execPath environment; this is separate from the npm 12.2.0 benchmark/root gate driver. Historical top-level summaries that name npm 12.2.0 do not override the raw qualifier's actual version field.

The complete root gate separately passes **113 Vitest files / 1,584 tests plus 93 OAuth tests**, including the example UI tests. Example build, production build, typecheck, every MCP conformance scenario or its existing reviewed baseline, both public-registry/HTTPS lock checks, production-only packed consumer type check, whitespace check, and measured runtime hash checks all exit 0. No baseline, timeout, safety rule, assertion, or support floor was weakened. `local-gates/exits.tsv` and individual command/log pairs are authoritative.

New expected red attempts are the future-pruning regression and deliberate configured-protection mutation. Both are retained. A missing local Git author identity also caused a commit attempt to fail; it was corrected with the pre-existing Pi Durable author identity passed through per-command git -c, without changing any default/global configuration. All ten measured fork processes and both profile processes exit 0.

## Boundaries and delivery

The approved actual model remains openai/gpt-6.1-sol, thinking xhigh. No model/default/provider/account configuration is changed. Existing owner-authenticated provenance remains at old commit 809c68c396de927f4c5c499b099874281fd63d8d.

No installed macOS/new-dist timing, private-corpus measurement, local macOS/Android execution, live install, restart, release, deployment or activation is performed. These are synthetic Linux SDK source measurements. Isolated cloud qualification dependency graphs are test prerequisites, not an owner-runtime installation.

Fresh final-head CI and both enabled independent reviewers remain separate delivery gates, recorded on the PR after the final cleanup commit. This evidence record does not self-certify coordinator acceptance. Leave PR #95 OPEN, non-draft, auto-merge OFF, unmerged, for the coordinator and Mitch.
