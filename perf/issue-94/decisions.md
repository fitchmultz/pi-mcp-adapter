# Issue 94 decision trail

## Admission

The baseline is current `origin/main`, resolved once at admission as `d01434ea56e89b6a15d9e085c73c53cdf521a988`. Work uses an isolated cloud Git worktree and `perf/issue-94-pi-mcp-adapter`. The coordinator cleared the model gate with supported owner chat configuration. See [actual-model-evidence.json](actual-model-evidence.json). The actual configured model is `openai/gpt-6.1-sol`, thinking `xhigh`.

## Data shape and throughput checkpoint

The persistent shape stays a versioned JSON object with server-keyed raw descriptors and timestamps. A process-local, bounded file snapshot will be keyed by resolved path and filesystem revision. Derived tool registrations remain separate from per-session selections. File revisions, server identity, metadata, presentation options, trust, and branch selections are distinct invalidation inputs. No config-only shortcut may preserve a transport or skip branch restoration.

The checkpoint is a real Pi SDK SessionManager plus session_start and session_tree path on identical synthetic config and approximately 4.5 MB metadata. Compare uninstrumented alternating A/B runs, at least five per side, with output, failure, and work counts. Profile separately. Also run the packed external-consumer native SDK and actual CLI qualification. Do not claim a speedup for private sessions.

## Checklist

1. Capture a baseline trace via the matching control skill. Vet the baseline, and each later number, with the benchmark-checklist skill.
2. how to ground hypotheses. Skip the panel unless profiling exposes a concrete unresolved design need. Apply the Pi adapter task-scope override.
3. Plan the fix from the trace. Keep this isolated code-owner assignment local rather than start a nested program. Verify each unit before the next. Capture a separate post-fix trace.
4. Parse and compare the artifacts (JSON to sqlite, diff). "Inconclusive" or wrong-surface is not a pass. Flag it.
5. Cite the measurement in the PR.
6. Run Opening a PR.
7. Inspect changed hunks with the Pi adapter standalone cleanup. Run required gates before commit.
8. Create one ready PR with the built-in GitHub integration. No merge, auto-merge, publication, deployment, or live activation.
9. Run the explicitly assigned Babysit drive pass through current-head CI, reviews, annotations, discussions, and threads. Leave the PR open.

Architect, arena, swarm, how, and no-comments panels are not selected automatically. Existing local owners cover the design. External GitHub independent review remains required. Reconsider a specialist only for a concrete unresolved need.

## Principles applied

- Model the Domain separates immutable metadata revisions from mutable branch selections.
- Explain the Number requires a separate profile and counts beside timings.
- Sequence work into verifiable units separates cache persistence, reuse, and SDK regression checks.
- Test Behavior, Not Implementation requires disk outcomes and actual active tools at the SDK boundary.
- Prove It Works requires packed SDK and CLI evidence rather than source inspection alone.

All principle leaves and required workflow documents were read at pstack commit `94f83d6fb0581e0602e467f7fafdfd9f87c4b402`. No real owner cache, session, history, or runtime is used.

## Baseline and implementation decisions

- The first SDK probe failed before work because the locked Pi 1.0.0 development snapshot resolved incompatible companion exports. Resolve latest official Pi once as 1.4.0 and select its complete coherent companion graph without changing the committed manifest or lock. This is an environment qualification correction, not a dependency upgrade.
- The first runtime-switch prototype reused a loaded extension instance across replacement sessions and correctly hit Pi's stale-context guard. Retain that failed attempt. The corrected driver creates a fresh resource loader for each replacement, as the host does.
- A separate CPU profile reproduced repeated cache reads and serialization. Host tool registration and registry refresh are a larger end-to-end limiter. Do not modify that separate owner's repository.
- The chosen change reuses one immutable parsed file snapshot with device, inode, size, nanosecond mtime, and ctime identity. It reconstructs only requested server projections and caches fingerprints only for immutable metadata. It never shortcuts lifecycle teardown, config/trust resolution, server identity validation, selection restoration, collision checks, or host allowlists.
- Save still rereads disk before its atomic rename. Do not use the read snapshot as a merge base. Preserve the existing cross-process read/merge/rename contract rather than add a new locking protocol. Concurrent overlapping save transactions retain the pre-existing last-writer limitation.
- Prune recognized expired merged entries, except current configured servers and explicitly incoming entries. Preserve unknown shapes. Invalid/future timestamps cannot authorize cached capabilities.
- Claim to test in the alternating uninstrumented runs: unchanged metadata avoids repeated read/parse and descriptor serialization on synthetic cloud session switches and branch navigation. The overall switch may remain host-registration-bound. No claim concerns the owner's private corpus or installed macOS builds.
- The provenance addendum confirms historical issue numbers refer to old installed builds. None of those numbers are used as the measured before side here.

## Verification checkpoint

- Persistence regression first ran red on current main. Expired pruning, future timestamps, and malformed collections failed. It then passed with the implementation.
- The real SessionManager regression also ran red on main because it advertised future-dated tools. Both SDK tests pass with the implementation. A first draft of one expectation incorrectly omitted a gateway explicitly selected by the fixture. Correct that expectation without weakening the direct-tool capability assertion. Retain the failed attempt.
- Typecheck found an over-wide string in the new test's lifecycle fixture. Narrow it to the real lazy literal. Retain the compiler failure and the passing rerun.
- The matched ten-process A/B sequence passed every output/work assertion. Final source/cloud switch medians are 200.45 ms and 153.99 ms. The full raw data, input hash, commands, and ranges are retained. Exploratory and profiler runs are not included in that comparison.
- Build the baseline again under the selected coherent official graph and compare every emitted JavaScript hash. The output is byte-identical to the measured baseline build.
- Required example install/build, build, typecheck, all 113 Vitest files with 1,583 tests, 93 OAuth tests, MCP conformance, both lockfile checks, and packed SDK/native/CLI proof pass locally. No standalone formatter or lint script is configured. `git diff --check` passes.
- Standalone Pi adapter cleanup inspected every changed runtime hunk and new fixture before commit. No speculative layers, changed ceilings, checker suppressions, hidden catches, or narration comments were added. Necessary race and lifecycle comments remain.

## Opening and drive pass

- PR #95 is ready, open, and has auto-merge disabled. The cloud-native built-in GitHub integration is the supported authenticated forge. No `gh-personal` profile, credential shim, or GitHub MCP fallback is created.
- Both independent local latest-host lanes pass at the clean implementation commit. Retain their exact SDK/CLI, host locks/trees, tarball identities, fork receipt, and actual CLI stdout JSONL in a public-safe artifact. The packed consumer type check also passes.
- The Bun/gh-based pstack watcher is NOT RUN because neither executable nor a guest GitHub credential surface exists here. The supported built-in integration supplies exact-head CI and complete paginated reviews, discussions, inline comments, and review threads. Drive mode uses those actual GitHub facts. Do not claim a fabricated watcher READY event.
- The initial head's Actions resolve, compatibility, and extras checks pass. Pi Durable and Cursor reviews are still pending as this evidence-only update is prepared. A pending review is not a clean review.
- No external review finding has been published at this point. Recheck all review surfaces after the evidence push and before completion.
