# Auth-record schema loading comparison

The credential API is synchronous. Cached extension startup does not load Zod
or the MCP SDK. QX-021 keeps those contracts while using canonical Zod schemas.

## Static-import counterpart

The counterpart uses the same structural schemas and inferred record types, but
imports Zod normally:

```ts
import { z } from "zod";

const tokens = z.looseObject({
  accessToken: z.string(),
  refreshToken: z.string().exactOptional(),
  expiresAt: z.number().exactOptional(),
  scope: z.string().exactOptional(),
  issuer: z.string().exactOptional(),
});
```

Client information and the complete entry use the same construction. The guard
validates without replacing the original parsed object:

```ts
export function isAuthEntry(value: unknown): value is AuthEntry {
  return authEntrySchema.safeParse(value).success;
}
```

This avoids changing JSON property order during explicit credential migration.
Returning Zod's parsed copy changed the persisted bytes and failed the existing
storage-isolation assertion. That assertion remains unchanged.

## Actual comparison

On Node 24.22.2, Zod 4.6.7, Oxlint 1.90.0, oxlint-tsgolint 7.0.2005 and
TypeScript 7.0.2, the complete static-import counterpart passes the root compiler
and native credential lint. All five existing storage-isolation cases pass.
The existing native startup case fails at `startupZodModules`, which contains
95 modules instead of an empty array. The case loads the real source extension,
uses its cached metadata and performs the first real stdio call.

The selected implementation creates those schemas on the first credential
validation through Node's synchronous `createRequire`. Its only assertion types
the literal installed module from its own declaration. Input JSON is still
unknown until the structural schemas validate it.

This is a module-loading contract comparison, not a startup speedup measurement.
