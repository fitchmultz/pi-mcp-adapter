# Quality exceptions

`quality-exceptions.json` binds each site-based exception to its file, native rule, named AST scope, child path, node kind, operation text and enclosing conditions. Function-signature sites compare the exact function header before its AST body. A changed selector requires review with the affected implementation. The inventory verifies scope, not the quality argument. `check:directives` checks attachment and rejects copied, replaced, duplicated and stale directives. Native Oxlint still checks every unaffected operation and reports unused directives.

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

- **Finding:** Oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/no-deprecated` at the initialized capability getter in the named `reportClientCapabilities` functions in `__tests__/fixtures/oauth-cross-app-stdio.ts` and `__tests__/runtime/fixtures/elicitation-server.mjs`. There are no rule options. Both receivers are the native protocol owned by a current `McpServer`.
- **Contract:** Stdio defaults to legacy version negotiation in `McpServerManager.createClient` (`server-manager.ts:783`). Its client capabilities belong to `initialize`, not a per-request envelope. MCP server 2.4.0 documents that distinction in `dist/mcp-BCJHyo7l.d.mts:3066-3075`. Its accessor returns the actual initialized value in `dist/mcp-oHn3ureC.mjs:1211-1213`. The fixture uses the current `McpServer` API and native stdio transport. The fixtures must report the capabilities actually received. The OAuth parent verifies that stdio does not advertise enterprise authorization or resolve an IdP source. The elicitation parent verifies form support in both Pi modes, URL support only in TUI mode, and actual form and URL callback replies.
- **Comparison:** The recommended per-request context can validate modern capabilities without a deprecated call:

  ```ts
  const envelope = z.record(z.string(), z.unknown()).parse(context.mcpReq.envelope);
  const capabilities = ClientCapabilitiesSchema.parse(
    envelope["io.modelcontextprotocol/clientCapabilities"],
  );
  ```

  This callback passes the compiler and native lint. Through a real default stdio connection, the OAuth tool returns `isError: true` because the envelope is `undefined`. The elicitation fixture uses low-level protocol handlers to retain thrown JSON-RPC errors. Substituting the same validated per-request implementation there passes native lint and the root compiler, but both existing TUI/RPC capability cases reject with `Invalid input: expected record, received undefined`. Restoring the accessor passes all 24 handler and SDK cases. Returning empty capabilities instead would let the negative capability assertion pass without observing the initialized client. Intercepting initialization would replace or wrap the SDK's protocol handler instead of reading its public value.

- **Adjustment:** One next-line directive at each of the two inventoried native accessor calls, bound to the named function and exact initialized-capability declaration. Other deprecated SDK operations remain checked.
- **Evidence:** The parent cross-app suite runs the standalone fixture through `McpServerManager`, parses its actual tool response with `ClientCapabilitiesSchema`, checks absent enterprise extensions, and verifies that the command marker and IdP request history stay empty. The separate shutdown fixture checks the native cancelled call and uncaught-exception result in its own process. The elicitation SDK suite owns actual form replies, form-only versus URL capability advertisement, URL completion deduplication, and -32042 handling through proxy/direct tools, resources and UI resources. The directive-policy suite qualifies both native accessor shapes and requires adjacent unapproved `getClientVersion()` calls to fail with the native deprecation diagnostic and location.
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

## QX-013: Preserve the primary native keyring load failure

- **Finding:** Oxlint 1.90.0 reports `eslint/preserve-caught-error` at the nested fallback failure in `keyring-store.ts:loadKeyringEntryClass`. The rule has no configured options.
- **Contract:** The synchronous default loader runs before the absolute-path fallback. Its original error and cause chain retain the published loader's binding diagnostics. The fallback detail belongs in the combined message, while the primary loader error remains the cause. `mcp-auth.test.ts` enforces that identity through the real Node module loader. `credential-store-errors.ts:causeChainContains` traverses these native causes for operator diagnostics.
- **Comparison:** Changing the inner constructor to `{ cause: fallbackError }` and removing the unused outer catch binding removes the native preserve-caught-error finding. The root compiler passes. The unchanged `preserves loader failures and tries the Linux musl binding after gnu` case fails with `original loader error was not preserved in the cause chain`. Restoring the primary cause passes that case. The two separate native assertion findings belong to QX-018 and remain visible during this rule-specific comparison. An `AggregateError` retaining the primary cause still produces this rule's finding; changing the error class alone does not resolve it.
- **Adjustment:** One next-line directive on the combined error construction, bound to the named loader and exact throw statement in `quality-exceptions.json`.
- **Verification:** Run `PI_MCP_ADAPTER_TEST_AUTH_STORE=memory node --test --test-name-pattern='preserves loader failures' mcp-auth.test.ts`, `npm run lint:credential-runtime`, `npm run check:directives` and the directive-policy suite. Its accepted nested-catch case preserves the primary cause; an adjacent unapproved caught-error replacement must retain the native diagnostic. Copied, replaced and duplicate operations are rejected by the inventory checker.
- **Remaining protection and review:** Automatic enforcement of the most recently caught error as this one cause is lost. The primary error remains an actual cause, fallback detail remains in the message, the constructor type remains checked, and all other error-preservation sites remain linted. The real loader test enforces the chosen cause identity. Revisit when the loading strategy or native rule changes.

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
- **Dependency qualification:** With Vitest 5.1.0, the selected implementation and the disposable reset-and-reinstall comparison each pass all 20 real HTTP cases, native lint and the root compiler. `@vitest/spy/dist/index.d.ts:198-204` and `dist/index.js:74-77` retain `getMockImplementation()` as the configured mock implementation, not the captured original. `dist/index.js:195-212` shows that `mockReset()` still clears call history before restoring the default implementation. The comparison's extra shared mock lifecycle remains.
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

<a id="qx-018-type-the-two-lazy-native-keyring-loads"></a>

## QX-018: Type the enumerated native keyring loads

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-unsafe-type-assertion` at two synchronous `createRequire` results in `keyring-store.ts`. The rule has no configured options.
- **Scope and contract:** Only the literal `@napi-rs/keyring` package load and the resolved, enumerated platform binding load are covered. `KeyringModule` is `Pick<typeof keyring, "Entry">` from the installed package. Keyring 2.1.2's `index.d.ts:97-196` owns the constructor and password/delete methods. Its `index.js:702-705` exports the native binding and its `Entry` directly. The fallback uses the same published platform package and binary naming contract shown by that loader. The loader and constructor caches remain module-owned and lazy: importing a value eagerly would fail all adapter startup on an unsupported native platform, while an asynchronous import changes the synchronous storage API.
- **Type flow and assumptions:** Node's synchronous `require` result has type `any`. Each assertion supplies only the known module's published type; no external credential payload is cast, and no predicate claims to validate constructor signatures. Production calls use the module's own `createRequire`, not an injected general loader. The fallback's path comes from the fixed native target mapping and `require.resolve`. This decision relies on the installed native package and platform binary honoring their published declarations, as ordinary statically imported dependencies do. It does not establish safety for arbitrary substituted module exports.
- **Comparison:** The [complete cast-free adapter](quality-comparisons/keyring-entry.md) passes native lint and the root compiler, performs actual native credential round trips and rejects an invalid constructor and invalid password result. It introduces an opaque native handle, a facade class and reflective dispatch with result checks on every operation. The selected assertions preserve native instances and ordinary typed method calls without reimplementing the published API's runtime contract. The comparison records the concrete code and verification; this decision is not based only on brevity.
- **Adjustment:** Three next-line directives, each inventoried by its named function, exact operation and rule. Two are in `keyring-store.ts`; the third is the standalone helper's resolved native binary load described below. There is no file-wide or module-wide allowance.
- **Verification:** A direct macOS arm64 probe writes through the published package constructor, reads and removes through the independently resolved native binary, and verifies absence through the package constructor. The cast-free alternative passes both entrypoints and rejects malformed controls. The directive-policy suite qualifies each accepted load and an adjacent unknown-to-module assertion that must still fail native lint. A wrong package/binary operation, copied directive and duplicate directive fail inventory verification. Run `npm run lint:credential-runtime`, `npm run check:directives`, `npm run typecheck` and the directive-policy suite.
- **Remaining protection and review:** These three native module assertions receive no automatic runtime shape validation. Exact operation identity, native declaration imports, pinned dependency/lockfile cohorts, platform and fallback tests, and real native round trips constrain the assumption. All other unsafe assertions remain checked. The fallback target mapping is reviewed implementation, not a generic loader or a claim that the inventory proves dependency correctness. No physical Windows, FreeBSD or Linux credential store was exercised by the local macOS probe. Revisit when keyring's version, exports, binding contract or synchronous import options change.

### Standalone recovery helper

`mcp-keyring-helper.cjs` runs as CommonJS in a fresh Linux keyring session. Its ordinary literal `require("@napi-rs/keyring")` receives declaration inference without an assertion or directive. Only the fallback's resolved `.node` require needs QX-018. Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports the native `typescript/no-unsafe-type-assertion` diagnostic. Its installed schema declares no rule options. The assertion supplies `Pick<typeof import("@napi-rs/keyring"), "Entry">` directly at the require call, not at an upstream unknown variable. The inventory selects the asserted require call within the ReturnStatement's `.Entry` receiver. It binds the loader, resolved package directory and binary suffix. The directive sits immediately above that call because the native diagnostic attaches there, not to the outer return.

The value comes from `createRequire(__filename)`, `require.resolve` and the helper's existing enumerated Linux suffixes. Keyring 2.1.2's `index.d.ts:96-196` declares the constructor, string-or-null read, void write and boolean delete. Its `index.js:318-334` loads the arm64 GNU binding; `index.js:701-705` exports the native binding and Entry directly. No credential payload is asserted. JSON request fields are validated before construction, and write payload validation retains its original position after construction. The receiver stays the actual native Entry.

The complete compliant adapter in the comparison above also applies to this standalone boundary. A checked CommonJS version uses a private unknown handle, `Reflect.construct`, receiver-preserving `Reflect.apply` and validation of all three method results. Both implementations pass the canonical compiler and production native lint. The adapter adds 67 source lines and a facade to the imported 147-line helper, changes its internal return contract to a three-method interface and adds adapter-specific errors. A function-only guard would not establish construction or method-result types. The chosen assertion instead trusts the installed binary's published declaration, under the same dependency assumption as the package's direct export. There is no measured performance claim.

Matched baseline, selected and compliant helper processes passed ordinary-load and forced-Linux-suffix protocol probes on Node 24.22.2 with the real macOS arm64 native binary. The checks cover newline-terminated JSON, status and stderr, invalid input, malformed JSON, the existing 1,048,576 UTF-16-code-unit input limit, Unicode write/readback, removal and absent readback. Each native round trip uses a newly generated isolated credential and independently verifies its removal. Forced suffix selection exercises the helper algorithm with a genuine native receiver, not Linux storage semantics. No real Linux or Android hardware is qualified by this comparison.

The existing directive-policy owner reads the actual helper and inventory. Its controls qualify native accepted attachment, require the unsafe-assertion diagnostic for an adjacent unknown value, require native unused-directive rejection, and reject wrong-file, wrong-function, changed-module with unchanged directive count, duplicate and stale directives. All unaffected unsafe checks remain enabled. Automatic runtime shape validation at this one native load is lost. The binary origin, published declaration, locked dependency cohort, native protocol and operation inventory constrain that trust; the inventory does not prove arbitrary substituted bindings safe. Revisit on native package, loader, declaration, suffix mapping or rule changes.

## QX-019: Preserve native Node test registration

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-floating-promises` for Node suite and test registrations. The qualified declarations are `@types/node` 24.19.1 on Node 24.22.2. The standard's `checkThenables: true`, `ignoreIIFE: false` and `ignoreVoid: false` remain active.
- **Scope and contract:** Only `mcp-auth.test.ts`, `mcp-auth-flow.test.ts`, `mcp-callback-server.test.ts` and `mcp-oauth-provider.test.ts` at repository root. The allowed declaration origin is `node:test`, with local import names `nodeIt` and `nodeDescribe`. The installed `test.d.ts:124-132` describes completion Promises and exports `it` as the native test function. Node owns registration, execution and failed-test reporting. Section 6.4 of the adopted standard requires preserving module evaluation and hook timing. No context subtest or asynchronous work created by a test body is authorized by this decision.
- **Comparison:** The [matched actual-suite comparison](quality-comparisons/node-registrations.md) awaits all 122 registrations and makes the 32 suite callbacks asynchronous. Both forms pass the same 90 cases, and the awaited form passes native lint without an allowance and the root compiler. In all four real files, that alternative moves the first existing hook before module end. Synchronous registration has module end before the first hook. The adjustment preserves existing scheduling and avoids changing every suite's asynchronous structure solely for lint. The comparison makes no product-regression or performance claim.
- **Adjustment:** A native `allowForKnownSafeCalls` entry for those two declaration-qualified imports in the exact four root files. `excludeFiles: ["**/*/*"]` keeps same-basename nested files outside the allowance. Other floating-Promise options and the empty safe-Promise-type list are unchanged. No shorthand, wildcard or file-wide rule disable is enabled.
- **Verification:** The installed-linter control suite passes all six required controls. It checks both forms at top level and inside suites, and requires the exact diagnostic, file, line and failing exit for context subtests, same-named local and wrong-module functions, floating body work, unrelated work and out-of-scope files. Native lint checks all actual registrations. The policy checker requires this record and the exact configuration; its suite rejects expanded scope. Run `npm run lint:node-oauth`, `npm run typecheck`, `npm run test:oauth` and the quality suites.
- **Remaining protection and review:** Context methods still produce floating-work diagnostics. Native declaration matching does not establish runtime context: a direct imported registration called inside a running test can still match. Such bodies must use context methods and own subtest Promises. Review must retain that distinction in these four files. Revisit on Node declaration, Oxlint identity-matching, import-form, scheduling or scope changes.

## QX-020: Preserve the supplied auth entry's URL update

- **Finding:** Oxlint 1.90.0 reports `eslint/no-param-reassign` with `props: true` on `entry.serverUrl = serverUrl` in `mcp-auth.ts`.
- **Scope and contract:** The exported source helper `saveAuthEntry` updates its mutable argument when given a non-empty `serverUrl`, then persists it. `updateTokens` and `updateClientInfo` pass their owned mutable records to this helper. The migration preserves the helper's caller-visible update rather than silently changing its ownership contract. This is not a claim that the helper is a published package entrypoint or that an external consumer depends on that mutation.
- **Comparison:** The [actual copy comparison](quality-comparisons/auth-entry-ownership.md) passes the root compiler and fully strict native lint without an allowance. Both implementations persist equal records. The copy leaves the supplied entry's URL absent, while the selected implementation updates it. Preserving that observable behavior is the correctness reason for this exception. No performance advantage or external-consumer failure is claimed.
- **Adjustment:** One next-line directive, bound to `saveAuthEntry`, the exact `entry.serverUrl` assignment target and its non-empty-URL condition in `quality-exceptions.json`.
- **Verification:** The existing native save/read case supplies an entry without a URL and asserts the argument update and persisted result. The directive-policy suite verifies accepted attachment, rejects copied, replaced and duplicate operations, and requires a neighboring parameter mutation to retain its native diagnostic. Run `npm run lint:credential-runtime`, `npm run lint:node-oauth`, `npm run check:directives`, `npm run typecheck`, `npm run test:oauth` and the directive-policy suite.
- **Remaining protection and review:** Automatic rejection of this one parameter-property assignment is lost. The compiler checks the property and value types, the inventory binds the assignment and condition, and the native test checks the chosen mutation contract. Every other parameter mutation remains linted. Revisit if the helper's ownership contract or the native rule changes.

## QX-021: Load the declared Zod API outside cached startup

- **Finding:** Oxlint 1.90.0 with oxlint-tsgolint 7.0.2005 reports `typescript/no-unsafe-type-assertion` on the synchronous `require("zod")` result in `auth-record-types.ts`.
- **Scope and contract:** Only the literal installed Zod module load in `createAuthRecordSchemas` is covered. Zod 4.6.7's `package.json:60-65` maps import and require entrypoints to the same `index.d.cts` declaration. Its `index.cjs:29-33` exports the declared `z` namespace. Credentials remain a synchronous API, and cached extension startup must load neither Zod nor the MCP SDK. Zod is an existing runtime dependency, including for the standalone migration CLI.
- **Comparison:** The [static-import counterpart](quality-comparisons/auth-record-schema-loading.md) passes the root compiler and native lint without this exception. Its real native startup case fails because it loads 95 Zod modules before the first MCP call. The same counterpart passes all five storage-isolation cases after validation preserves the original JSON object. An asynchronous import changes the storage API. A second handwritten validator would repeat the persisted-field contract instead of using the canonical schemas.
- **Adjustment and type flow:** One next-line directive on the exact namespace declaration. The assertion supplies the installed module's published type, as a static import would. It does not assert a credential value. Structural schemas validate parsed JSON before it becomes `AuthEntry`; no coercions, defaults or transforms establish a different output shape. The guard retains the original object so explicit migration preserves serialized property order.
- **Verification:** The directive-policy suite checks accepted attachment and an adjacent unknown-to-Zod assertion that must fail native lint. Copied, changed-module and duplicate operations fail inventory verification. The native startup test exercises source loading, cached surfaces and the first real stdio call. Storage tests reject malformed records before migration and retain raw redirect recovery. Run `npm run lint:credential-runtime`, `npm run check:directives`, `npm run typecheck` and the startup, auth and directive-policy suites.
- **Remaining protection and review:** Runtime validation of the installed Zod module's exports is not added. The assumption is that the fixed dependency honors its declarations, as for ordinary imports; arbitrary substituted loaders are not established safe. Exact operation identity, dependency locks, native startup and real credential cases constrain this boundary. Every other unsafe assertion remains checked. Revisit on Zod declaration, export, schema-transform, loader or synchronous storage-contract changes.

## QX-022: Preserve the published positional filtering API

- **Finding:** Oxlint 1.90.0 reports `eslint/max-params` on `tool-names.ts:isToolAllowed`. The production maximum is four parameters; the function has five. The installed `configuration_schema.json:13153-13194` exposes the maximum and `this` counting options, not a public-API allowance. The unsuppressed native invocation exits 1 with this diagnostic at the function name.
- **Scope and contract:** `public-types.ts` exports `types.ts`, which exports `tool-names.ts`. The package's `/types` export therefore exposes `isToolAllowed(toolName, serverName, prefix, includeTools?, excludeTools?)`. `search-ranking.ts`, `resource-tools.ts`, `tool-metadata.ts` and `ui-server.ts` pass both positional filters. The fifth argument must continue to exclude matching tools. No claim is made that an external consumer relies on `Function.length`, but this change also preserves its value of five.
- **Comparison:** The straightforward compliant alternative groups the filters:

  ```ts
  export function optionsAlternative(
    toolName: string,
    serverName: string,
    prefix: ToolPrefix,
    filters?: { includeTools?: unknown; excludeTools?: unknown },
  ): boolean {
    return (
      isToolIncluded(toolName, serverName, prefix, filters?.includeTools) &&
      !isToolExcluded(toolName, serverName, prefix, filters?.excludeTools)
    );
  }
  ```

  This implementation has four parameters and uses the same filtering owners. The canonical compiler accepts the current public call and the alternative's object call, but reports TS2554 for an unchanged five-position call to the alternative. An actual JavaScript call with the old positions also changes behavior: `("write", "docs", "server", ["write"], ["write"])` returns false now and true with the options implementation. Migrating internal callers alone does not preserve the exported package contract. A rest tuple preserves TypeScript call syntax but hides the same five conceptual parameters and changes native arity. It is not the chosen alternative.

- **Adjustment:** One next-line directive for `eslint/max-params` on the exported `isToolAllowed` declaration. `quality-exceptions.json` inventories only this complete declaration, including its exact signature and filtering body. The existing AST checker selects its `ExportNamedDeclaration`, so the directive attaches before `export` without widening the allowed comment-to-operation gap. No other function or signature is authorized.
- **Verification:** `npm run lint:config-runtime`, `npm run check:directives`, `npm run lint:quality`, `npm run typecheck`, `npm run typecheck:all`, the focused config and filtering suites, and `vitest run __tests__/quality/directive-policy.test.ts` qualify the selected implementation. The policy suite checks native accepted and unsuppressed cases, an unapproved five-parameter neighbor, native unused-disable detection, wrong file, wrong function, same-count signature replacement, wrong rule, wrong decision, duplication and a missing directive. The packed consumer verifies the public entrypoints; the adoption evidence additionally executes the packed predicate with all five positions and compiles valid and invalid positional consumers.
- **Remaining protection and review:** The parameter-count diagnostic is lost only for this inventoried declaration. Other structural and safety rules remain active, as does `max-params` on every neighbor. The compiler checks the public signature, and runtime tests retain include/exclude outcomes. The AST inventory establishes operation identity, not API compatibility by itself. Revisit on a public API change, a native rule change, or a supported migration that can preserve existing positional consumers without hiding arity.

## QX-025: Implement Pi's five-position tool callback

- **Finding:** Oxlint 1.90.0 reports `eslint/max-params` with `max: 4` on the returned `execute` function in `createDirectToolExecutor`. The native rule counts all five callback parameters, including the unused update slot.
- **Contract:** Installed Pi 1.5.0 declares `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` in `dist/core/extensions/types.d.ts:533`. The executor needs the fifth context for the configured `beforeExecute` hook. Its type is derived from `ToolDefinition<TUnsafe<Record<string, unknown>>, Record<string, unknown>>["execute"]`, matching the TypeBox schema used by `tool-loader.ts`. No callback signature is duplicated. Native contexts come from Pi's runner, including its required tool-execution capabilities.
- **Comparison:** Internal `executeCall`, `executeSearch`, `executeConnect` and `runToolCall` use cohesive request objects and need no exception. These helpers are not package exports. For the native callback, the straightforward compliant alternative is `async function execute(request: { toolCallId: string; params: Record<string, unknown>; signal: AbortSignal | undefined; ctx: Parameters<DirectToolExecute>[4] })`. Assigning this function to `ToolDefinition.execute` fails with TS2322 because Pi supplies a string first, not a request object. Omitting the fourth slot makes that slot the context and loses the actual fifth context. A rest tuple or `arguments` would conceal the same imposed positions rather than improve the interface.
- **Adjustment:** One next-line directive for one rule on the named returned `execute` callback in `direct-tools.ts`. The existing AST inventory binds its exact signature. Signature selection ends at the native function body's start, so body maintenance does not require copying the implementation into policy data.
- **Verification:** `__tests__/quality/directive-policy.test.ts` qualifies native acceptance, neighboring five-parameter rejection, copied and same-count replaced signatures, duplicates, missing directives and native unused directives. Compiler comparisons verify the real executor's SDK assignment and reject the object-argument alternative. The focused direct-tool suites retain real SDK calls, native request options, cancellation and hook context forwarding. Run `npm run lint:proxy-runtime`, `npm run lint:quality`, `npm run check:directives`, `npm run check:policy`, `npm run typecheck:all` and the focused suites.
- **Remaining protection and review:** Parameter-count detection is lost only on this inventoried callback signature. Other structural, typing, asynchronous and assertion rules remain active, as does `max-params` on adjacent functions. The inventory establishes operation identity, not SDK correctness. Compiler assignment and native execution establish the SDK relationship. Revisit when Pi changes callback positions, context requirements or the linter's callback handling. The independent finisher reviews the imported implementation, then performs a separate critical pass over the finished change. Both sessions use the same model family.
