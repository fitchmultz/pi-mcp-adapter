# Auth-entry URL ownership comparison

QX-020 preserves `saveAuthEntry`'s update to the supplied mutable record. The
comparison uses the actual helper and persistence code, not a replacement store.

## Compliant alternative

Replace the conditional parameter assignment in `saveAuthEntry` with a shallow
copy, leaving the secure write and plaintext cleanup unchanged:

```ts
const storedEntry =
  serverUrl !== undefined && serverUrl.length > 0 ? { ...entry, serverUrl } : entry;
writeSecureAuthEntry(serverName, storedEntry);
removeLegacyAuthEntry(serverName, options);
```

This alternative passes the root compiler and fully strict native lint. It is a
reasonable implementation when the API borrows an input record instead of
updating it. A mutation through an alias or `Object.assign` would not resolve the
ownership decision.

## Observed difference

On Node 24.22.2, Oxlint 1.90.0, oxlint-tsgolint 7.0.2005 and TypeScript 7.0.2,
a disposable native probe runs both complete modules against the memory store.
Each input is `{ tokens: { accessToken: "fixture" } }`; each save receives
`"https://example.com/mcp"` as its URL.

| Observation                          | Selected implementation | Compliant copy |
| ------------------------------------ | ----------------------- | -------------- |
| Supplied entry's `serverUrl`         | Provided URL            | Absent         |
| Persisted entry read through the API | Equal                   | Equal          |
| Root compiler                        | Pass                    | Pass           |
| Native lint without a directive      | Parameter mutation      | Pass           |

The probe asserts both argument states and deep equality of the persisted
records. It removes its synthetic credentials and temporary plaintext directory.
The comparison establishes an observable mutation difference, not a broken
external consumer or a performance result.

The native save/read case now starts without `serverUrl` and asserts that the
save updates the supplied entry. Its persisted-record equality assertion remains.
This gives the retained mutable-helper contract a direct regression check.
