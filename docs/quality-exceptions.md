# Quality exceptions

`quality-exceptions.json` binds each site to its file, native rule, named AST scope, child path, node kind, operation text and enclosing conditions. A changed selector requires review with the affected implementation. The inventory verifies scope, not the quality argument. `check:directives` checks attachment and rejects copied, replaced, duplicated and stale directives. Native Oxlint still checks every unaffected operation and reports unused directives.

## QX-001: Observe the native transport in place

- **Finding:** Oxlint 1.90.0, `eslint/no-param-reassign` with `props: true`, reports the `transport.send` assignment in `wrapTransportWithMcpTrace`. Only that assignment in `mcp-trace.ts` is authorized.
- **Contract:** MCP client 2.3.1 requires the base stdio transport's own prototype to contain `_dispose` before it can create a disposable sibling for version negotiation. Its `dist/index.mjs:2872-2884` documents and implements that test. The same package detects stdio through the `stderr` and `pid` accessors at `:2590-2597`. Protocol cancellation reads `hasPerRequestStream` in `dist/src-WCy6ifGf.mjs:6169`. Tracing must retain those contracts, the native send receiver, callbacks and the original send error.
- **Comparison:** A separate `Transport` decorator can own its methods and forward `start`, `send`, `close` and callback slots. It cannot preserve the exact native prototype contract. A clone or a generic decorator therefore changes negotiation even if it implements the public `Transport` interface. An alias of the parameter merely conceals the same mutation and is not an alternative. The retained implementation changes only the native callback member and forwards through the original bound send.
- **Adjustment:** One next-line directive, one rule, at the `transport.send` member selected by the inventory. The assignment remains explicit. Other mutations, including other transport members, remain checked.
- **Evidence:** `__tests__/runtime/server-manager-legacy-handshake.test.ts` owns the real stdio contract. With tracing enabled and disabled, it verifies two native processes, successful classic initialization, both processes' exit and actual trace bytes. `__tests__/runtime/mcp-trace.test.ts` drives both directions through linked SDK transports, including a throwing observer and a failed trace writer. Exception-scope and native-rule controls are in `__tests__/quality/directive-policy.test.ts`.
- **Remaining protection and review:** There is no file-wide or name-based allowance. Revisit when the SDK supports transport observation directly or changes its prototype and cancellation contracts. Qualification results are recorded with the adopting change.

### Delegating comparison

The comparison uses the same installed client and `__tests__/fixtures/legacy-no-discover-server.mjs` as the native stdio test. The server exits when it receives `server/discover`. `Client` selects `versionNegotiation: { mode: "auto" }`, with a 1,000 ms connect timeout.

The alternative forwards the public stdio operations and callback slots. Its `send` method has its own owner, so observation there does not require parameter reassignment:

```js
class DelegatingTransport {
  constructor(native) {
    this.native = native;
  }
  start() {
    return this.native.start();
  }
  send(message, options) {
    return this.native.send(message, options);
  }
  close() {
    return this.native.close();
  }
  get onmessage() {
    return this.native.onmessage;
  }
  set onmessage(handler) {
    this.native.onmessage = handler;
  }
  get onerror() {
    return this.native.onerror;
  }
  set onerror(handler) {
    this.native.onerror = handler;
  }
  get onclose() {
    return this.native.onclose;
  }
  set onclose(handler) {
    this.native.onclose = handler;
  }
  get stderr() {
    return this.native.stderr;
  }
  get pid() {
    return this.native.pid;
  }
  get sessionId() {
    return this.native.sessionId;
  }
}
```

The native transport reaches classic initialization and `tools/list`, using two child processes. This decorator is rejected with `the disposable sibling probe requires the SDK's base StdioClientTransport`, after one child process exits. Both runs verify that every child has exited. Adding tracing to the decorator does not change the prototype check that causes this failure.

## QX-009: Forward the recorded persistence failure

- **Finding:** Oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/only-throw-error` at `McpTraceWriter.flush`'s stored failure. Options are `allowThrowingAny: false`, `allowThrowingUnknown: false` and `allowRethrowing: true`. Native rethrow permission applies to the immediate catch variable, not this recorded value.
- **Contract:** Ordinary tracing isolates persistence failures from MCP calls. A strict flush must report the original failure, preserving its identity, subtype and cause. JavaScript promises can reject with non-Error values, so the recorded value is accurately `unknown`.
- **Comparison:** `throw new Error(String(this.persistenceError))` changes the value, identity, subtype and cause. Narrowing to `Error` before throwing changes non-Error rejections. The direct throw preserves the API contract without a forwarding helper.
- **Adjustment:** One next-line directive at `throw this.persistenceError` inside the strict-flush failure condition. No other throw is authorized by this record.
- **Evidence:** The trace writer failure case asserts that ordinary flush succeeds and strict flush rejects with the exact captured failure. Replacing the throw with `throw new Error(String(this.persistenceError))` fails that identity assertion. The directive-policy suite runs native Oxlint on accepted and neighboring unguarded operations for both exceptions. It checks exit status, rule, file and location, plus copied, same-count replacement, changed-condition and duplicate directives.
- **Remaining protection and review:** Other throw sites retain the full native rule; immediate catch-variable rethrows retain the native allowance. Revisit if strict flush changes failure ownership or the installed rule recognizes stored rethrows. Qualification results are recorded with the adopting change.
