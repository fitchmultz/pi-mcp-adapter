# Full acceptance-wiring qualification

## Inputs

The complete acceptance command was qualified at commit
`19acb10c09df0daea44db2406a3e86caa491a9d1`, tree
`7cf83de8c10cde68876df194210b07bbb8164272`, in a separate clean worktree.
The runtime was Node 24.22.2 with the declared npm 12.2.0. Root and example
installs used `npm ci --ignore-scripts --no-audit --no-fund`.

The installed tools were Oxlint 1.90.0, oxlint-tsgolint 7.0.2005, Oxfmt 0.76.0,
TypeScript 7.0.2 and oxc-parser 0.157.0. The root lockfile SHA-256 was
`a89b9e7250d7d39f00598078f1bc0699a0c72657df252ad02475702a45e2a622`.

Every control ran the actual `npm run check`, without replacing commands,
filtering diagnostics, selecting fewer tests or changing its failure handling.
The acceptance runner, compiler launcher, build scripts and test configuration
were unchanged.

## Independent failures

Each row was a separate disposable mutation, restored before the next row.
The TypeScript controls used a temporary
`__tests__/fixtures/quality-gate-control.ts`, which entered the root compiler,
native lint and formatter coverage automatically. Vitest did not execute this
fixture as a test module.

| Control       | Mutation                                                                                              | Required finding                                                | Failed stage    | Aggregate exit |
| ------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------- | -------------: |
| Lint          | `debugger;`                                                                                           | `eslint(no-debugger)` in the temporary fixture                  | `lint`          |              1 |
| Semantic lint | `Promise.resolve();`                                                                                  | `typescript(no-floating-promises)` in the temporary fixture     | `lint`          |              1 |
| Compiler      | `export const compilerFailure: string = 0;`                                                           | TS2322 at line 1 of the temporary fixture                       | `typecheck:all` |              1 |
| Formatter     | `export const formattingFault=1` without its semicolon                                                | Native Oxfmt formatting failure for the temporary fixture       | `format:check`  |              1 |
| Test          | Change the expected HTTP status from 200 to 201 in `__tests__/auth/mcp-callback-success-page.test.ts` | The real callback returns 200, failing the assertion at line 20 | `test:vitest`   |              1 |
| Policy        | Add a comment-only root `.prettierignore`                                                             | `Unclassified nested quality configuration: .prettierignore`    | `check:policy`  |              1 |

Only the named stage failed in each run. Both builds, every other quality
stage, Vitest, Node OAuth and conformance still ran and passed where they were
not the deliberately failing stage. In the compiler control, the root project
failed while build, handwritten declarations and example projects still ran
and passed. Tests also ran and passed after that compiler failure.

The policy control is independent of source filtering: its comment-only ignore
file omits no source, so native formatting, lint, compilation and tests still
pass. Separate normal policy tests cover actual ignored source and policy
downgrades.

## Restored acceptance

After all six controls, Git status was clean and the original lockfile hash
was unchanged. The complete `npm run check` exited 0 with all required stages
passing: example and root builds, formatting, full native lint, four compiler
projects, directive and policy checks, both explicit generator freshness
checks, 1,931 Vitest tests in 129 files, 90 Node OAuth tests and all 26 protocol
conformance scenarios.

The mutation descriptions, command output, diagnostic locations, per-stage
exits and restored result were retained with the adoption evidence. These
controls qualify failure propagation. They do not replace source review,
exception comparisons, supported-host qualification, packed-consumer checks or
required hosted CI.
