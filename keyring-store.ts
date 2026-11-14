import type * as keyring from "@napi-rs/keyring";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { hash } from "node:crypto";
import { withStorageLock } from "./storage-lock.ts";
import { OAuthCredentialStoreError } from "./credential-store-errors.ts";

const require = createRequire(import.meta.url);
const TEST_AUTH_STORE_ENV = "PI_MCP_ADAPTER_TEST_AUTH_STORE";

type KeyringEntryConstructor = typeof keyring.Entry;
type KeyringModule = Pick<typeof keyring, "Entry">;

export interface AuthSecretStore {
  read: (account: string) => string | undefined;
  write: (account: string, payload: string) => void;
  remove: (account: string) => void;
}

let KeyringEntryClass: KeyringEntryConstructor | undefined;
const memoryAuthEntries = new Map<string, string>();

/** One name's legacy source and URL-scoped records share an OS-user lock. */
export function withAuthSecretLock<T>(
  service: string,
  legacyAccount: string,
  action: OAuthCredentialStoreError["operation"],
  operation: () => T,
): T {
  const backend = process.env[TEST_AUTH_STORE_ENV];
  if (backend === "memory" || backend === "unavailable" || backend === "keyrevoked") {
    // These stores are process-local; they share no keyring records with other processes.
    return operation();
  }
  const key = hash("sha256", JSON.stringify([service, legacyAccount]), "hex");
  const lockPath = join(homedir(), ".fitch-mcp-adapter", "locks", `${key}.sqlite`);
  const acquisition = { entered: false };
  try {
    return withStorageLock(
      lockPath,
      () => {
        acquisition.entered = true;
        return operation();
      },
      action === "read" ? "read" : "write",
    );
  } catch (error) {
    if (acquisition.entered) {
      throw error;
    }
    throw new OAuthCredentialStoreError(
      "Failed to acquire the shared OAuth credential lock",
      action,
      error,
    );
  }
}

function memoryAuthSecretStore(service: string): AuthSecretStore {
  return {
    read(account) {
      return memoryAuthEntries.get(`${service}\0${account}`);
    },
    write(account, payload) {
      memoryAuthEntries.set(`${service}\0${account}`, payload);
    },
    remove(account) {
      memoryAuthEntries.delete(`${service}\0${account}`);
    },
  };
}

function keyringAuthSecretStore(service: string): AuthSecretStore {
  return {
    read(account) {
      return getKeyringEntry(account, service).getPassword() ?? undefined;
    },
    write(account, payload) {
      getKeyringEntry(account, service).setPassword(payload);
    },
    remove(account) {
      getKeyringEntry(account, service).deleteCredential();
    },
  };
}

const unavailableAuthSecretStore: AuthSecretStore = {
  read() {
    throw new Error("simulated secure credential store unavailable");
  },
  write() {
    throw new Error("simulated secure credential store unavailable");
  },
  remove() {
    throw new Error("simulated secure credential store unavailable");
  },
};

function createKeyRevokedTestError(): Error {
  return new Error("Couldn't access platform storage: KeyRevoked", {
    cause: new Error("KeyRevoked"),
  });
}

const keyRevokedAuthSecretStore: AuthSecretStore = {
  read() {
    throw createKeyRevokedTestError();
  },
  write() {
    throw createKeyRevokedTestError();
  },
  remove() {
    throw createKeyRevokedTestError();
  },
};

export function getAuthSecretStore(service: string): AuthSecretStore {
  if (process.env[TEST_AUTH_STORE_ENV] === "memory") {
    return memoryAuthSecretStore(service);
  }
  if (process.env[TEST_AUTH_STORE_ENV] === "unavailable") {
    return unavailableAuthSecretStore;
  }
  if (process.env[TEST_AUTH_STORE_ENV] === "keyrevoked") {
    return keyRevokedAuthSecretStore;
  }
  return keyringAuthSecretStore(service);
}

function getKeyringEntry(account: string, service: string): keyring.Entry {
  try {
    KeyringEntryClass ??= loadKeyringEntryClass();
    return new KeyringEntryClass(service, account);
  } catch (error) {
    throw new Error(
      "OAuth secure credential storage is unavailable. Configure the OS credential store and retry authentication.",
      { cause: error },
    );
  }
}

function loadKeyringEntryClass(): KeyringEntryConstructor {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-018: the lazy published module owns this native Entry declaration.
    return (require("@napi-rs/keyring") as KeyringModule).Entry;
  } catch (loaderError) {
    try {
      return loadKeyringNativeBindingFallback(process.platform, process.arch).Entry;
    } catch (fallbackError) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- QX-013: retain the primary loader cause and include fallback detail in the message.
      throw new Error(
        `Failed to load @napi-rs/keyring; absolute-path native binding fallback also failed: ${formatErrorMessage(fallbackError)}`,
        {
          cause: loaderError,
        },
      );
    }
  }
}

function loadKeyringNativeBindingFallback(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): KeyringModule {
  const targets = getKeyringNativeBindingTargets(platform, arch);
  if (targets.length === 0) {
    throw new Error(`Unsupported @napi-rs/keyring native binding target: ${platform}-${arch}`);
  }

  let lastError: unknown;
  for (const target of targets) {
    try {
      const packageJsonPath = require.resolve(`${target.packageName}/package.json`);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-018: this resolved platform binding exports the published native Entry class.
      return require(join(dirname(packageJsonPath), target.bindingFile)) as KeyringModule;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getKeyringNativeBindingTargets(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): { packageName: string; bindingFile: string }[] {
  return getKeyringNativeBindingSuffixes(platform, arch).map((suffix) => ({
    packageName: `@napi-rs/keyring-${suffix}`,
    bindingFile: `keyring.${suffix}.node`,
  }));
}

const nativeSuffixes: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, readonly string[]>>>
> = {
  darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
  win32: { arm64: ["win32-arm64-msvc"], x64: ["win32-x64-msvc"], ia32: ["win32-ia32-msvc"] },
  linux: {
    arm64: ["linux-arm64-gnu", "linux-arm64-musl"],
    arm: ["linux-arm-gnueabihf"],
    riscv64: ["linux-riscv64-gnu"],
    x64: ["linux-x64-gnu", "linux-x64-musl"],
  },
  freebsd: { x64: ["freebsd-x64"] },
};

function getKeyringNativeBindingSuffixes(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): readonly string[] {
  return nativeSuffixes[platform]?.[arch] ?? [];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
