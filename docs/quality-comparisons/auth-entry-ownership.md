# Auth-entry URL ownership

`saveAuthEntry` borrows a readonly input record. A non-empty URL produces a shallow
copy for persistence; the function does not change the caller's record. The secure
write and legacy plaintext cleanup retain their order.

`updateTokens` and `updateClientInfo` own their mutable records and finish with the
save call. Neither reads the record afterward. The other production callers pass
no URL and do not need a mutation. This helper is not exported by either package
entrypoint. Its observable input mutation is not a requirement of these consumers.

The native save/read test in `mcp-auth.test.ts` supplies a frozen record, requires
that its URL stays absent, and checks the full stored record with the requested
URL. It fails on an attempted parameter write. Existing token/client-information
replacement, issuer isolation, migration and native storage tests remain active.

This implementation needs no parameter-mutation exception. The input, stored
credential contents and caller-visible behavior are checked independently rather
than treating a historical mutation as a compatibility requirement.
