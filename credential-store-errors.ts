export class OAuthCredentialStoreError extends Error {
  readonly code = "OAUTH_CREDENTIAL_STORE_UNAVAILABLE";
  readonly operation: "read" | "write" | "remove";

  constructor(message: string, operation: "read" | "write" | "remove", cause: unknown) {
    super(
      isAndroidKeyringLoadFailure(cause)
        ? `${message}. Android/Termux: @napi-rs/keyring could not load a native binding. Persistent OAuth requires a supported platform with an OS credential store; no plaintext fallback is used.`
        : message,
      { cause },
    );
    this.operation = operation;
    this.name = "OAuthCredentialStoreError";
  }
}

export function causeChainContains(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while ((typeof current === "object" && current !== null) || typeof current === "function") {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const values: readonly unknown[] = [
      Reflect.get(current, "name"),
      Reflect.get(current, "message"),
      Reflect.get(current, "code"),
    ];
    if (values.some((value) => typeof value === "string" && pattern.test(value))) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

function isAndroidKeyringLoadFailure(error: unknown): boolean {
  return (
    process.platform === "android" &&
    causeChainContains(error, /^Failed to load @napi-rs\/keyring;/)
  );
}

export function formatOAuthCredentialStoreUnavailable(error: OAuthCredentialStoreError): string {
  if (isAndroidKeyringLoadFailure(error)) {
    return error.message;
  }
  if (
    process.platform === "linux" &&
    causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i)
  ) {
    return "OAuth credential store unavailable: the Linux session keyring may be revoked. Start Pi from a fresh login/keyring session and retry.";
  }
  return "OAuth credential store unavailable. Configure or unlock the OS credential store and retry.";
}
