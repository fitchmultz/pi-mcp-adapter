# Quality exceptions

`quality-exceptions.json` binds each site-based exception to its file, native rule, named AST scope, child path, node kind, operation text and enclosing conditions. A changed selector requires review with the affected implementation. The inventory verifies scope, not the quality argument. `check:directives` checks attachment and rejects copied, replaced, duplicated and stale directives. Native Oxlint still checks every unaffected operation and reports unused directives.

## QX-001: Observe the native transport in place

- **Finding:** Oxlint 1.90.0, `eslint/no-param-reassign` with `props: true`, reports the `transport.send` assignment in `wrapTransportWithMcpTrace`. Only that assignment in `mcp-trace.ts` is authorized.
- **Contract:** MCP client 2.4.0 requires the base stdio transport's own prototype to contain `_dispose` before it can create a disposable sibling for version negotiation. Its `dist/public-CvV4ZHkX.mjs:2490-2505` documents and implements that test. The same package detects stdio through the `stderr` and `pid` accessors at `dist/public-CvV4ZHkX.mjs:2211-2218`. Protocol cancellation reads `hasPerRequestStream` in `dist/src-CeKsbNLO.mjs:6180`. Tracing must retain those contracts, the native send receiver, callbacks and the original send error.
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

## QX-007: Read initialized capabilities on native legacy stdio

- **Finding:** Oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/no-deprecated` at `server.server.getClientCapabilities()` in the named `reportClientCapabilities` callback in `__tests__/fixtures/oauth-cross-app-stdio.ts`. There are no rule options.
- **Contract:** Stdio defaults to legacy version negotiation in `McpServerManager.createClient` (`server-manager.ts:783`). Its client capabilities belong to `initialize`, not a per-request envelope. MCP server 2.4.0 documents that distinction in `dist/mcp-BCJHyo7l.d.mts:3066-3075`. Its accessor returns the actual initialized value in `dist/mcp-oHn3ureC.mjs:1211-1213`. The fixture uses the current `McpServer` API and native stdio transport. It must report the capabilities actually received, so the parent can verify that stdio does not advertise enterprise authorization or resolve an IdP source.
- **Comparison:** The recommended per-request context can validate modern capabilities without a deprecated call:

  ```ts
  const envelope = z.record(z.string(), z.unknown()).parse(context.mcpReq.envelope);
  const capabilities = ClientCapabilitiesSchema.parse(
    envelope["io.modelcontextprotocol/clientCapabilities"],
  );
  ```

  This callback passes the compiler and native lint. Through a real default stdio connection, the tool returns `isError: true` because the envelope is `undefined`. Returning empty capabilities instead would let the negative capability assertion pass without observing the initialized client. Intercepting initialization would replace or wrap the SDK's protocol handler instead of reading its public value.

- **Adjustment:** One next-line directive at the native accessor call, bound to the named callback and exact initialized-capability declaration. Other deprecated SDK operations remain checked.
- **Evidence:** The parent cross-app suite runs the standalone fixture through `McpServerManager`, parses its actual tool response with `ClientCapabilitiesSchema`, checks absent enterprise extensions, and verifies that the command marker and IdP request history stay empty. The separate shutdown fixture checks the native cancelled call and uncaught-exception result in its own process. The directive-policy suite qualifies this exact native accessor shape and requires an adjacent unapproved `getClientVersion()` call to fail with the native deprecation diagnostic and location.
- **Remaining protection and review:** The fixture asserts that initialized capabilities exist before serializing them. Compiler checks retain the native `McpServer` receiver, and all other safety and deprecation checks remain active. The operation inventory rejects copied, replaced, duplicated and stale directives. Revisit when stdio uses per-request envelopes or the SDK supplies a nondeprecated accessor for the supported initialize-based contract.

## QX-009: Forward the recorded persistence failure

- **Finding:** Oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/only-throw-error` at `McpTraceWriter.flush`'s stored failure. Options are `allowThrowingAny: false`, `allowThrowingUnknown: false` and `allowRethrowing: true`. Native rethrow permission applies to the immediate catch variable, not this recorded value.
- **Contract:** Ordinary tracing isolates persistence failures from MCP calls. A strict flush must report the original failure, preserving its identity, subtype and cause. JavaScript promises can reject with non-Error values, so the recorded value is accurately `unknown`.
- **Comparison:** `throw new Error(String(this.persistenceError))` changes the value, identity, subtype and cause. Narrowing to `Error` before throwing changes non-Error rejections. The direct throw preserves the API contract without a forwarding helper.
- **Adjustment:** One next-line directive at `throw this.persistenceError` inside the strict-flush failure condition. No other throw is authorized by this record.
- **Evidence:** The trace writer failure case asserts that ordinary flush succeeds and strict flush rejects with the exact captured failure. Replacing the throw with `throw new Error(String(this.persistenceError))` fails that identity assertion. The directive-policy suite runs native Oxlint on accepted and neighboring unguarded operations for both exceptions. It checks exit status, rule, file and location, plus copied, same-count replacement, changed-condition and duplicate directives.
- **Remaining protection and review:** Other throw sites retain the full native rule; immediate catch-variable rethrows retain the native allowance. Revisit if strict flush changes failure ownership or the installed rule recognizes stored rethrows. Qualification results are recorded with the adopting change.

## QX-010: Observe native MCP callbacks

- **Finding:** Oxlint 1.90.0 reports `unicorn/prefer-add-event-listener` at `connection.client.onerror` in the named `observesLateSseError` HTTP test callback. There are no rule options.
- **Contract:** The installed MCP client 2.4.0 inherits the public `Protocol.onerror?: (error: Error) => void` callback (`node_modules/@modelcontextprotocol/client/dist/index-BCNZS4Ap.d.mts:2099`). The protocol invokes that callback directly (`dist/src-CeKsbNLO.mjs:5890-5892`). It is not an `EventTarget`. The receiver comes from `McpServerManager.connect`, whose client is a native SDK subclass with the SDK's private members, not an unverified structural stand-in.
- **Comparison:** The prescribed `connection.client.addEventListener("error", handler)` cannot observe this SDK: the member does not exist. A real `new Client({ name: "callback-contract", version: "1" })` reports `addEventListener` absent and `onerror` present. Removing the callback observation would drop the existing assertion that a stream can fail after delivering its complete result without replaying the completed call. A separate event target would not receive the SDK's callback and would need the same assignment to bridge it.
- **Transport contract:** `retainsCancelledCallbackTail` in `__tests__/runtime/callback-http-lifetime.test.ts` observes the actual connected transport's `onmessage`, then forwards the message and extra information to the original callback. MCP client 2.4.0 declares this callback in `dist/index-BCNZS4Ap.d.mts:1762` and on `StreamableHTTPClientTransport` in `dist/index.d.mts:2410`. Neither interface has `addEventListener`. The HTTP test waits for a real `notifications/cancelled` dispatch before closing the transport. Removing that observation loses the distinction between a cancelled callback tail and an ordinary pending callback.
- **Adjustment:** One next-line directive at each of the two inventoried native callback members. The transport site is bound to the named cancellation test and the exact `transport.onmessage` assignment. No DOM, AbortSignal or unlisted callback site is allowed.
- **Evidence:** The error test delivers a complete result, sends a later UI notification, destroys the same SSE stream, and requires exactly one native error and one tool invocation. The cancellation test delivers sampling and elicitation callbacks and cancellation over real HTTP and SSE, verifies dispatch, and holds native close until the delayed handler completes. The directive-policy suite exercises both actual SDK receiver types, named-function-expression attachment and neighboring native event-listener violations.
- **Remaining protection and review:** Native lint still checks every other callback assignment. Compiler checks retain the actual SDK receiver and callback argument types. The inventory rejects changed, copied and duplicate operations; review establishes the receiver's provenance. Revisit if the SDK adds a native event-listener API or the rule recognizes the SDK contract.

## QX-011: Send invalid in-memory options to the real validation boundary

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-unsafe-type-assertion` at `invalid as unknown as ServerEntry` in the named `rejectsInvalidProtocolOptions` test callback. There are no rule options.
- **Contract and type flow:** The test deliberately supplies an unsupported protocol string, a string retry flag and a string issuer-metadata flag to the public, typed in-memory connection path. Its table owns these invalid values. The assertion is used only as the argument to `fixture.connect`, which forwards the definition directly to `McpServerManager.connect`. `createConnection` calls `validateServerProtocolConfig` before importing the transport runtime or creating a connection (`server-manager.ts:425-426`). Each case must reject with a validation error and leave the real HTTP server's received-request history empty. No result of the asserted type is consumed as trusted configuration.
- **Comparison:** Constructing a valid `ServerEntry` cannot exercise invalid runtime input. Validating the test value first, or routing it through the JSON loader, would test a different boundary and could pass after the manager's own validation was removed. Broadening the fixture or production API to accept unchecked configuration would export the negative-test escape to ordinary callers.
- **Adjustment:** One next-line directive at the assertion inside the named negative test. The fixture and production signatures stay typed. No general unsafe-assertion allowance is added.
- **Evidence:** Removing only `validateServerProtocolConfig(definition)` makes all three existing cases fail at the expected rejection: the native connection proceeds instead. Restoring that call makes the cases pass with zero HTTP requests. The directive-policy suite checks this rule's accepted site and a neighboring unchecked assertion, including native diagnostic identity, file, location and exit status.
- **Remaining protection and review:** All production configuration and other test assertions retain the rule. The unchecked values are confined to this negative boundary, and the runtime rejection plus no-network assertion guards the essential assumption. The inventory binds the directive to the exact argument expression; compiler and review checks protect its surrounding flow. Revisit when the public connection boundary or validation ownership changes.

## QX-012: Exercise mutation of the supplied configuration snapshot

- **Finding:** Oxlint 1.90.0 reports `eslint/no-param-reassign`, with `props: true`, at `config.mcpServers.docs.env.ORIGINAL` in the named `transformsSuppliedConfig` test callback.
- **Contract:** `createMcpAdapter` supplies `transformConfig` with a cloned configuration and clones its returned value. A host may mutate that supplied object and return shared host-owned settings without changing the caller's configuration or sharing subsequent runtime edits. The lifecycle test exercises that host callback through the native Pi SDK, checks registration before initialization, and verifies isolation across startup, reload and new-session contexts.
- **Comparison:** The straightforward compliant hook copies its input before changing it:

  ```ts
  const transformed = structuredClone(config);
  assert(transformed.mcpServers.docs?.env !== undefined);
  transformed.mcpServers.docs.env.ORIGINAL = "transformed";
  return { ...transformed, settings: sharedSettings };
  ```

  That hook protects itself from a missing adapter-side input clone. It cannot prove that another host can safely mutate the object the adapter supplies. Removing mutation or mutating a separate fixture has the same loss. Aliasing the parameter would conceal the operation instead of preserving the check.

- **Adjustment:** One next-line directive at the exact member assignment in the named callback. The preceding assertion establishes that the configured server and environment exist. No production mutation, other callback, or other configuration member is authorized.
- **Evidence:** The existing parameterized lifecycle test owns input and returned-value isolation. Removing only the input `cloneMcpConfig(runtimeConfig)` at the `transformConfig` call in `index.ts` makes `vitest run __tests__/index-lifecycle.test.ts -t 'snapshot=false'` fail. The second and third captured inputs incorrectly contain `ORIGINAL: "transformed"`. The return-value clone remains intact. With that same broken adapter, the compliant local-copy callback above passes the focused test, typecheck and native lint. It therefore loses the input-isolation regression. Restoring the production and test files restores their exact original bytes. The directive-policy suite qualifies the named callback against the canonical `McpConfig` type and verifies that an adjacent unapproved settings assignment still produces the native parameter-mutation diagnostic.
- **Remaining protection and review:** Compiler checks retain the canonical callback and configuration contracts. All other parameter writes retain native lint. The operation inventory rejects copied, replaced, duplicated and stale directives. Revisit if the hook's mutation/ownership contract changes or the native rule gains an equally precise declaration-qualified allowance.

## QX-016: Retain original methods for receiver-preserving delay spies

- **Finding:** Oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/unbound-method` at the captures of `McpOAuthProvider.prototype.tokens`, `McpOAuthProvider.prototype.saveTokens` and `Response.prototype.json`. The rule has no options. Only the three named variable initializers in `__tests__/runtime/callback-http-lifetime.test.ts` are authorized.
- **Contract:** The tests delay native token reads, token persistence and response-body reads at distinct shutdown boundaries. They then call the captured original with the real invocation's receiver and arguments. The provider forwarders use `apply(this, args)` inside spies with `this: McpOAuthProvider`. The body reader uses `call(this)` with `this: Response` and treats the parsed result as `unknown`. Provider identity, issuer binding and stored credentials must remain those of the active connection. A replacement response or separately constructed provider cannot exercise that contract.
- **Comparison:** A compliant spy can reset itself, invoke the original through the receiver, and reinstall its delay implementation:

  ```ts
  const tokens = vi.spyOn(McpOAuthProvider.prototype, "tokens");
  tokens.mockImplementation(async function readTokens(this: McpOAuthProvider, ...args) {
    if (!entered && f.methods.includes("notifications/initialized")) {
      entered = true;
      await gate.promise;
    }
    tokens.mockReset();
    const result = this.tokens(...args);
    tokens.mockImplementation(readTokens);
    return result;
  });
  ```

  The compared persistence spy uses `this.saveTokens(...args)` between the same reset and reinstall. The compared body spy captures `const body: Promise<unknown> = this.json()` between its reset and reinstall, then returns that promise. All three pass the compiler, native lint and the same 20 real HTTP tests. This alternative changes shared spy state on every forwarded call, clears its call history and re-enters the spy to reach the original. Capturing the original once leaves the spy state alone and makes the receiver-preserving call explicit. The exception avoids that extra mock lifecycle without replacing native work.

- **Adjustment:** One next-line directive at each inventoried original-method capture. No unbound invocation or other capture is allowed. Each original remains local to the test and is called only with the explicitly typed native receiver.
- **Evidence:** `vitest run __tests__/runtime/callback-http-lifetime.test.ts` passes all 20 cases. The disposable compliant comparison runs the same 20 cases with the substitutions above and also passes. Both variants pass root typecheck and native lint. The tests assert that close waits for delayed work, no call is replayed, and actual token persistence has the expected result. The directive-policy suite checks each native capture and requires adjacent unapproved captures to fail at their own source line. Copied, changed and duplicate variable-initializer sites are rejected.
- **Remaining protection and review:** Other method references retain the native rule. Compiler checks retain each original method's signature and each spy's receiver. Real HTTP and stored-token assertions verify forwarding. The inventory authorizes the capture, not arbitrary later calls, so review must retain the explicit receiver at every use. Revisit if Vitest exposes an original-method call API that preserves the receiver without resetting shared mock state, or the rule recognizes this local capture-and-call flow.

## QX-017: Preserve the supported MCP sampling bridge

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-deprecated` for the SDK's `CreateMessageRequest`, `CreateMessageResult`, `ModelPreferences`, `SamplingMessage` and `SamplingMessageContentBlock` types. MCP client 2.4.0 marks these declarations deprecated under SEP-2577 in `dist/index-BCNZS4Ap.d.mts:600-646`. This is an intentional protocol deprecation, not a checker false positive.
- **Contract:** The same SDK declarations retain sampling in the specification for at least twelve months after protocol version 2026-07-28. The adapter already advertises and handles remote `sampling/createMessage` callbacks through the host's model registry, with model selection, request and response approval, cancellation and unsupported-feature errors. Removing this bridge changes supported MCP behavior. The MCP server does not own the host's configured provider credentials, model selection or approval UI.
- **Comparison:** The SDK recommends migrating the caller to direct provider APIs. That migration changes the external MCP server; it is not a replacement operation available to this adapter for an unchanged remote sampling callback. A disposable real HTTP comparison sends the same callback with and without the configured bridge. The configured native client returns the actual model-registry response. The client without the bridge returns JSON-RPC `-32601`. Disabling sampling therefore does not preserve the existing operation. Deriving the same types from the SDK's schemas is not a compliant alternative: `@modelcontextprotocol/core/dist/schemas-DBHuY3cl.d.mts:3923-3929` marks `CreateMessageRequestSchema` deprecated for the same reason. Reconstructing the shape through aliases, unions or removed annotations would hide the same deprecated feature instead of assessing it.
- **Adjustment:** The native `no-deprecated` rule remains an error. Its `allow` option permits only the five named types above, with declaration origin `@modelcontextprotocol/client`, in `sampling-handler.ts` and `__tests__/runtime/sampling-handler.test.ts`. There are no site directives or allowances for SDK methods, schemas, other symbols, other packages or other files. `check:policy` verifies the exact scope, names and package qualifier and requires this record.
- **Evidence:** The 13 model-selection, approval, conversion and unsupported-feature cases use a real isolated Pi `ModelRegistry`, with typed spies only for provider output and controlled model/auth availability. The disposable comparison uses `createCallbackHttpFixture`, a native `McpServerManager`, real HTTP/SSE delivery and that same registry. Both comparison cases pass. The existing callback-lifetime suite owns native sampling cancellation and drain. Native qualification controls in `__tests__/quality/policy.test.ts` exercise all five accepted types in both scopes, same-named wrong-origin types, an unlisted SDK deprecation, a copied use outside the two-file scope and policy expansion.
- **Remaining protection and review:** The allowance loses deprecation diagnostics for these five native types at any use within the two named files. It does not permit unchecked values or disable typing, async safety, complexity, framework or unrelated deprecation rules. Compiler checks retain the actual native request, response and registry contracts. Runtime tests retain the supported callback behavior. Review must reject unrelated uses of the permitted sampling types. Revisit when the supported sampling contract changes, a shared nondeprecated SDK replacement becomes available, or the dependency changes its declarations.

### HTTP compatibility comparison

The disposable comparison creates an isolated native Pi context, takes a real model from its registry, and spies on provider completion to return synthetic text. It uses the maintained callback HTTP fixture with `legacy: true` and `inbound: true`. The compared connection setup is:

```ts
if (configured) {
  manager.setSamplingConfig({
    autoApprove: true,
    modelRegistry: native.context.modelRegistry,
    getCurrentModel: () => model,
    getSignal,
  });
}
await manager.connect(fixture.name, fixture.definition);
const response = await fixture.callback("sampling/createMessage", samplingRequest).response;
```

With `configured: true`, the reply contains `result.content` equal to `{ type: "text", text: "Synthetic compatibility response" }`. With `configured: false`, the same wire callback returns `error.code: -32601`. No external provider API is called, and this comparison does not claim that migrating an external MCP server to direct provider APIs preserves the old callback contract.
