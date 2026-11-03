# Node registration ownership

[QX-019](../quality-exceptions.md#qx-019-preserve-native-node-test-registration) covers the two declaration-qualified registration imports in the four root OAuth suites. Node owns their execution and failure reporting. Context subtests and work created by test bodies still need normal Promise ownership.

## Compliant comparison

The existing registration form is synchronous:

```ts
nodeDescribe("mcp-auth", () => {
  before(() => {
    // Prepare the isolated credential directory.
  });
  nodeDescribe("getAuthEntry", () => {
    nodeIt("should return undefined for non-existent entry", () => {
      assert.strictEqual(getAuthEntry("non-existent"), undefined);
    });
  });
});
```

Awaiting every registration clears `no-floating-promises`, but requires asynchronous suite callbacks:

```ts
await nodeDescribe("mcp-auth", async () => {
  before(() => {
    // Prepare the isolated credential directory.
  });
  await nodeDescribe("getAuthEntry", async () => {
    await nodeIt("should return undefined for non-existent entry", () => {
      assert.strictEqual(getAuthEntry("non-existent"), undefined);
    });
  });
});
```

The comparison applies that change to all 32 suites and 90 test registrations in the actual four files. It preserves the test bodies and assertions. Each variant adds only two observation points: a marker at module end and a marker at the first existing `before` or `beforeEach` hook.

On Node 24.22.2, both variants pass all 90 cases. The awaited variant also passes root compiler checking and full native lint without a registration allowance. The observations differ in every file:

| Registration form                      | Observed order                  |
| -------------------------------------- | ------------------------------- |
| Existing synchronous registration      | Module end, then the first hook |
| Awaited registration with async suites | First hook, then module end     |

This is a real module-evaluation change, not a failure of those 90 tests. The comparison establishes the scheduling difference and the extra asynchronous suite structure. It does not claim an observed product regression or a performance difference. The adopted standard requires preserving Node's registration and hook timing instead of changing scheduling solely for lint.

The disposable copies run with `PI_MCP_ADAPTER_TEST_AUTH_STORE=memory node --test --test-concurrency=1` and the four copied filenames. Compiler checking uses `node scripts/tsc.mjs --noEmit`; the awaited files use `oxlint --deny-warnings`. Copies and captured output are retained in the adoption evidence, not shipped as duplicate tests.

## Retained checks

`__tests__/quality/node-registration-lint.test.ts` invokes the installed Oxlint with the actual root configuration, TypeScript project and Node declarations. It verifies both imported forms at top level and inside suites. It requires exact `typescript(no-floating-promises)` findings for context subtests, local and wrong-module functions with the same names, floating work inside a test, unrelated floating work, and files outside the four-root-file scope. It also checks same-basename files in nested directories.

`check:policy` requires the exact origin, names, files and unchanged Promise options. The policy suite rejects an expanded scope and a missing exception record.

Declaration identity does not prove calling context. A direct `nodeIt` or `nodeDescribe` import called from a running test body can still match this allowance. Such bodies must use context methods and own their subtest Promises. Review must preserve that distinction. No shorthand registrations, safe Promise types or general floating-work exemption are enabled.
