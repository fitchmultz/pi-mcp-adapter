# Native keyring boundary comparison

The selected loader trusts two published native module entrypoints. Its constructor and method types come from `@napi-rs/keyring`, not a locally invented declaration. The normal package exports the native binding's `Entry` directly. The fallback resolves an enumerated platform package and loads that package's native binary.

A cast-free alternative must validate an unknown constructor and each method result. This complete adapter uses the same three published methods as the credential store:

```ts
import type * as keyring from "@napi-rs/keyring";

type EntryOperations = Pick<keyring.Entry, "getPassword" | "setPassword" | "deleteCredential">;
type EntryConstructor = new (service: string, account: string) => EntryOperations;

/** A cast-free alternative to trusting the installed native module's declarations. */
export function checkedEntryConstructor(module: unknown): EntryConstructor {
  if (typeof module !== "object" || module === null || !("Entry" in module)) {
    throw new TypeError("Expected the native Entry export");
  }
  const constructor = module.Entry;
  if (typeof constructor !== "function") {
    throw new TypeError("Expected a native Entry constructor");
  }
  const nativeConstructor = constructor;
  return class CheckedEntry {
    private readonly handle: unknown;

    constructor(service: string, account: string) {
      this.handle = Reflect.construct(nativeConstructor, [service, account]);
    }

    private invoke(methodName: keyof EntryOperations, args: readonly unknown[]): unknown {
      const handle = this.handle;
      if (typeof handle !== "object" || handle === null) {
        throw new TypeError("Expected a native Entry instance");
      }
      const method: unknown = Reflect.get(handle, methodName);
      if (typeof method !== "function") {
        throw new TypeError(`Expected native Entry.${methodName}`);
      }
      const result: unknown = Reflect.apply(method, handle, args);
      return result;
    }

    getPassword(): string | null {
      const result = this.invoke("getPassword", []);
      if (typeof result !== "string" && result !== null) {
        throw new TypeError("Expected a native password string or null");
      }
      return result;
    }

    setPassword(password: string): void {
      const result = this.invoke("setPassword", [password]);
      if (result !== undefined) {
        throw new TypeError("Expected a void native password write");
      }
    }

    deleteCredential(): boolean {
      const result = this.invoke("deleteCredential", []);
      if (typeof result !== "boolean") {
        throw new TypeError("Expected a native credential deletion boolean");
      }
      return result;
    }
  };
}
```

Using the adapter also changes the internal constructor's result type to `EntryOperations` instead of the full native `Entry`. Every credential operation creates the extra facade, and every native method call goes through reflective dispatch and result validation. The selected loader keeps the actual native instance and its ordinary method calls. No performance claim is made.

## Verification

The comparison was compiled in the root project and checked with `oxlint --deny-warnings keyring-boundary-comparison.ts`. Both pass. The initial captured constructor needed a refined local constant for TypeScript's nested class; the code above is the corrected, qualified version.

On Node 24.22.2, macOS arm64 and keyring 2.1.2, both the package constructor and the independently resolved native binary passed real synthetic credential write/read/delete round trips through this adapter. Invalid constructor metadata and a password method returning a number reject with the adapter's expected errors. The direct constructors also passed a cross-entrypoint round trip: the package writes a synthetic secret, the resolved binary reads and deletes it, and the package observes absence. All synthetic credentials were removed.

These checks establish the local native API and the alternative's validation, not physical execution on every supported operating system. Published declarations, the native loader source, the existing platform child-process tests and selected-host CI cover the remaining stated contracts. Revisit [QX-018](../quality-exceptions.md#qx-018-type-the-two-lazy-native-keyring-loads) when the native package, exports or available synchronous import facilities change.
