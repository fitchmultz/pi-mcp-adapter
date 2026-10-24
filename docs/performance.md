# Plain-output paging

`readMcpResult` previously decoded and iterated the complete plain-output artifact for every page, including EOF requests. A private sparse index now supplies UTF-16 totals and byte checkpoints. Readers validate its device, inode, size, nanosecond mtime and ctime against an open source descriptor before using it. Platforms without no-follow support also require the index path to match its canonical target. The text file remains authoritative.

Writers build the index from actual persisted UTF-8 bytes after closing their output. Old or externally changed files rebuild it on demand. Missing, corrupt or unwritable metadata does not make the text unreadable. Invalid UTF-8 retains Node's nonfatal replacement decoding, but cannot use the byte index and can require another full scan. A change observed during a read produces a retryable read error rather than mixed revisions.

Checkpoints are about one MiB apart. The table coarsens for multi-GiB artifacts to stay within 4,096 entries, so seek distance is not universally one MiB. Index buffers are bounded at 256 KiB plus one byte. No full rendered history is cached, and the plain text format, JSON selectors, tool schemas and authorization rules are unchanged.

## Measured result

On Debian Linux x64 with two CPUs, Node 24.22.1, npm 12.2.0, official Pi 1.4.0 and TypeBox 1.3.27, the first 12,000-character **registered native gateway turn** for a 64 MiB artifact fell from **703.3 ms to 16.0 ms**, a 44.1× reduction. This turn includes synthetic model responses, native host processing and session persistence. It does not measure a provider request, inference cost or worker startup latency.

The baseline is `dde7b2867567344153562149eec508d3487e10ad`. Both source snapshots use the same SDK graph; the harness records exact source and build identities. Each cell below is the median of five fixed baseline-first A/B pairs, with minimum–maximum in parentheses. Processes run serially, not in randomized order. Writers and whole-file input hashes warm the OS page cache before the first reader call. “First” and “reopened” do not mean an OS-cold disk.

| Artifact | Helper first page, before → after (ms) | Native gateway first turn, before → after (ms) |
| --- | --- | --- |
| 1 MiB | 39.5 (35.9–42.2) → 3.53 (3.08–4.66) | 41.2 (38.3–47.1) → 13.9 (12.9–14.9) |
| 16 MiB | 215.5 (204.5–227.3) → 5.55 (3.49–7.69) | 208.8 (192.3–276.6) → 14.4 (13.6–15.9) |
| 64 MiB | 678.9 (631.2–733.3) → 3.76 (3.43–5.55) | 703.3 (633.0–864.6) → 16.0 (14.3–16.0) |

The helper median was about 97% of the native-turn median before the change and 24% after it. These are independent-run ratios, not an additive latency decomposition. Separate read-region CPU profiles identify the original full-file character loop as the main cost. After the change, filesystem waits, bounded copying and native schema/transcript processing account for the remaining work.

Reopened native arbitrary-offset reads of the 64 MiB file fell from 648.0 ms (599.8–700.6) to 15.3 ms (11.3–16.6). The first read after a same-size edit with exactly restored mtime still pays to rebuild: 649.7 ms (638.4–696.9) became 112.4 ms (104.1–123.1). These are separate cases, not pooled with indexed reads.

The work moves once, not for free. The 64 MiB helper writer rose from 162.0 ms (154.3–178.6) to 284.2 ms (269.7–299.7). Its new streaming scan prepares later readers, including other processes. Read-only derivative storage can force repeated rebuilds. The periodic ASCII/LF performance corpus is the issue's generated fixture, not a claim about every text distribution or the installed macOS runtime.

## Work and correctness checks

A separate untimed helper probe observed the following first-page work on the 64 MiB fixture:

| Work | Before | After |
| --- | ---: | ---: |
| Successful observed filesystem-read bytes | 67,108,864 | 66,944 |
| UTF-16 units visited by string iteration | 67,108,864 | 12,001 |
| Visible Buffer allocation calls | 1,026 | 3 |
| Bytes requested by those Buffer calls | 67,174,407 | 66,952 |

The candidate reads 65,536 source bytes plus its 1,408-byte index. A distant seek observed 853,376 bytes instead of 67,108,864. The index has 65 checkpoints on this fixture. These are logical read and allocation-request counters, not physical disk traffic, total JavaScript allocation, retained heap or RSS. Decoder and Buffer hooks are process-wide; helper probes isolate the reader from native framework work. Separate sampled-heap profiles include collected objects and support allocation attribution, not a peak-memory claim.

The matched run checked 660 timed pages with zero errors, matching complete input and normalized output hashes. It also checked worker-backed `tools.readResult` outside the gateway timer and verified 540 native tool results in 90 retained session JSONL files. Changed-file scenarios use separate artifacts, leaving first/reopen inputs and before/after index snapshots intact.

Regression tests cover nonuniform Unicode across checkpoints, surrogate rejection, malformed UTF-8, caps, concurrent and reopened reads, same-size/restored-mtime edits, replacement, in-flight changes, private roots and symlinks. A sparse artifact above four GiB exercises coarsening and offsets beyond 32 bits without a multi-GiB string. Behavioral mutants that disable indexing, ctime invalidation, surrogate checks, metadata bounds or no-follow reads fail those checks. JSON paging remains covered by its existing tests.

## Reproducer

The [Node harness](../scripts/benchmark-output-pages.mjs) retains generated inputs, compiled/source/SDK hashes, raw measurements, index snapshots and native session JSONL. Both builds must use the same coherent SDK graph. The recorded run selected official 1.4.0 with the existing [host-selection helpers](https://github.com/fitchmultz/.github/blob/9b08d65d70a01c74c4e01477ccf9473e86be33ee/scripts/hosts.mjs); plain `npm ci` alone selects the locked development snapshot instead.

From that prepared checkout:

```bash
baseline=$(mktemp -d)
git archive dde7b2867567344153562149eec508d3487e10ad | tar -x -C "$baseline"
ln -s "$PWD/node_modules" "$baseline/node_modules"
(cd "$baseline" && npm run build)
npm run build
node scripts/benchmark-output-pages.mjs \
	--baseline "$baseline" --output "$(mktemp -d)"
```

`--consumer helper` runs the micro path alone. `--work --rounds 1 --sizes 64` records untimed public-filesystem, decoder, iteration and Buffer counters. `--profile --rounds 1 --sizes 64` records CPU profiles with read-region spans that exclude verification and inspector setup/teardown. Instrumented rows have no reported read latency. Each run requires a fresh evidence directory and preserves earlier attempts.
