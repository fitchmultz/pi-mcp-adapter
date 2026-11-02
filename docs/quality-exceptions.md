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

## QX-010: Observe the native MCP client's error callback

- **Finding:** Oxlint 1.90.0 reports `unicorn/prefer-add-event-listener` at `connection.client.onerror` in the named `observesLateSseError` HTTP test callback. There are no rule options.
- **Contract:** The installed MCP client 2.3.1 inherits the public `Protocol.onerror?: (error: Error) => void` callback (`node_modules/@modelcontextprotocol/client/dist/index-B-4n9P0J.d.mts:2116`). The protocol invokes that callback directly (`dist/src-WCy6ifGf.mjs:5879-5880`). It is not an `EventTarget`. The receiver comes from `McpServerManager.connect`, whose client is a native SDK subclass with the SDK's private members, not an unverified structural stand-in.
- **Comparison:** The prescribed `connection.client.addEventListener("error", handler)` cannot observe this SDK: the member does not exist. A real `new Client({ name: "callback-contract", version: "1" })` reports `addEventListener` absent and `onerror` present. Removing the callback observation would drop the existing assertion that a stream can fail after delivering its complete result without replaying the completed call. A separate event target would not receive the SDK's callback and would need the same assignment to bridge it.
- **Adjustment:** One next-line directive for the native callback member in the named test. No DOM, AbortSignal, other client member or other test site is allowed.
- **Evidence:** The existing real HTTP test delivers a complete result, sends a later UI notification, destroys the same SSE stream, and requires exactly one native error and one tool invocation. The directive-policy suite exercises the actual SDK receiver, named-function-expression attachment and a neighboring native event-listener violation.
- **Remaining protection and review:** Native lint still checks every other callback assignment. Compiler checks retain the actual SDK receiver and callback argument types. The inventory rejects changed, copied and duplicate operations; review establishes the receiver's provenance. Revisit if the SDK adds a native event-listener API or the rule recognizes the SDK contract.

## QX-011: Send invalid in-memory options to the real validation boundary

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-unsafe-type-assertion` at `invalid as unknown as ServerEntry` in the named `rejectsInvalidProtocolOptions` test callback. There are no rule options.
- **Contract and type flow:** The test deliberately supplies an unsupported protocol string, a string retry flag and a string issuer-metadata flag to the public, typed in-memory connection path. Its table owns these invalid values. The assertion is used only as the argument to `fixture.connect`, which forwards the definition directly to `McpServerManager.connect`. `createConnection` calls `validateServerProtocolConfig` before importing the transport runtime or creating a connection (`server-manager.ts:425-426`). Each case must reject with a validation error and leave the real HTTP server's received-request history empty. No result of the asserted type is consumed as trusted configuration.
- **Comparison:** Constructing a valid `ServerEntry` cannot exercise invalid runtime input. Validating the test value first, or routing it through the JSON loader, would test a different boundary and could pass after the manager's own validation was removed. Broadening the fixture or production API to accept unchecked configuration would export the negative-test escape to ordinary callers.
- **Adjustment:** One next-line directive at the assertion inside the named negative test. The fixture and production signatures stay typed. No general unsafe-assertion allowance is added.
- **Evidence:** Removing only `validateServerProtocolConfig(definition)` makes all three existing cases fail at the expected rejection: the native connection proceeds instead. Restoring that call makes the cases pass with zero HTTP requests. The directive-policy suite checks this rule's accepted site and a neighboring unchecked assertion, including native diagnostic identity, file, location and exit status.
- **Remaining protection and review:** All production configuration and other test assertions retain the rule. The unchecked values are confined to this negative boundary, and the runtime rejection plus no-network assertion guards the essential assumption. The inventory binds the directive to the exact argument expression; compiler and review checks protect its surrounding flow. Revisit when the public connection boundary or validation ownership changes.
