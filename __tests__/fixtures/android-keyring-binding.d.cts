// Ambient declaration for the Android-only optional native binding exercised by
// android-keyring-probe.mjs. The package is installed only in Android/Termux
// graphs (os/cpu-restricted optional dependency of @napi-rs/keyring), so
// TypeScript cannot resolve it on macOS/Linux; runtime resolution is verified
// on Android by mcp-auth-storage.test.ts.
declare module "@napi-rs/keyring-android-arm64" {
  const binding: Record<string, unknown>;
  export = binding;
}
