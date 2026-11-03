import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { causeChainContains } from "./credential-store-errors.ts";
import type { AuthSecretStore } from "./keyring-store.ts";

const KEYRING_RECOVERY_DISABLED_ENV = "PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY";
const KEYRING_RECOVERY_KEYCTL_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL";
const KEYRING_RECOVERY_NODE_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE";
const KEYRING_RECOVERY_HELPER_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER";
const TEST_LINUX_KEYRING_RECOVERY_ENV = "PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY";
const KEYRING_RECOVERY_TIMEOUT_MS = 10_000;

type KeyringRecoveryOperation = "read" | "write" | "remove";

export function shouldAttemptLinuxKeyringRecovery(error: unknown): boolean {
  if (process.env[KEYRING_RECOVERY_DISABLED_ENV] === "1") {
    return false;
  }
  const enabled =
    process.platform === "linux" || process.env[TEST_LINUX_KEYRING_RECOVERY_ENV] === "1";
  return enabled && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i);
}

function configuredCommand(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value !== undefined && value !== "" ? value : fallback;
}

function runLinuxKeyringRecoveryOperation(
  operation: KeyringRecoveryOperation,
  account: string,
  payload: string | undefined,
  service: string,
): string | undefined {
  const keyctl = configuredCommand(KEYRING_RECOVERY_KEYCTL_ENV, "keyctl");
  const node = configuredCommand(KEYRING_RECOVERY_NODE_ENV, "node");
  const helperOverride = process.env[KEYRING_RECOVERY_HELPER_ENV]?.trim();
  const helper =
    helperOverride !== undefined && helperOverride !== ""
      ? helperOverride
      : fileURLToPath(new URL("./mcp-keyring-helper.cjs", import.meta.url));
  const request = JSON.stringify({ operation, service, account, payload });
  const result = spawnSync(keyctl, ["session", "-", node, helper], {
    input: `${request}\n`,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: KEYRING_RECOVERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Linux keyring recovery helper could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `Linux keyring recovery helper failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return readRecoveryResponse(operation, result.stdout);
}

function readRecoveryResponse(
  operation: KeyringRecoveryOperation,
  output: string,
): string | undefined {
  let response: unknown;
  try {
    response = JSON.parse(output.trim());
  } catch (error) {
    throw new Error("Linux keyring recovery helper returned invalid JSON", { cause: error });
  }
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("Linux keyring recovery helper returned an invalid response");
  }
  if (!response.ok) {
    const error = "error" in response ? response.error : undefined;
    const hasMessage = Boolean(error);
    throw new Error(hasMessage ? String(error) : "Linux keyring recovery helper failed");
  }
  return operation === "read" ? readRecoveredPassword(response) : undefined;
}

function readRecoveredPassword(response: object): string | undefined {
  if (!("found" in response) || response.found !== true) {
    return undefined;
  }
  if (!("value" in response) || typeof response.value !== "string") {
    throw new Error("Linux keyring recovery helper returned an invalid read response");
  }
  return response.value;
}

export function linuxKeyringRecoveryAuthSecretStore(service: string): AuthSecretStore {
  return {
    read(account) {
      return runLinuxKeyringRecoveryOperation("read", account, undefined, service);
    },
    write(account, payload) {
      runLinuxKeyringRecoveryOperation("write", account, payload, service);
    },
    remove(account) {
      runLinuxKeyringRecoveryOperation("remove", account, undefined, service);
    },
  };
}
