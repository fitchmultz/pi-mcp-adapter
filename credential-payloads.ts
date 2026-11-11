import { createHash } from "node:crypto";
import type { AuthEntry, AuthIdentity } from "./auth-record-types.ts";
import { OAuthCredentialStoreError } from "./credential-store-errors.ts";
import type { AuthSecretStore } from "./keyring-store.ts";

const AUTH_SECRET_CHUNK_SIZE = 1800;
const AUTH_CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked";

interface AuthEntryChunkManifest {
  [AUTH_CHUNK_MANIFEST_KEY]: 1;
  chunkCount: number;
  chunkDigest: string;
}

interface CredentialPayload {
  payload: string;
  source: string;
}

export function getAuthEntryAccount(identity: AuthIdentity): string {
  if (typeof identity.serverName !== "string" || typeof identity.serverUrl !== "string") {
    throw new Error("MCP credential identity requires a server name and exact URL");
  }
  return `v2-sha256-${createHash("sha256")
    .update(JSON.stringify([identity.serverName, identity.serverUrl]), "utf8")
    .digest("hex")}`;
}

export function getLegacyAuthEntryAccount(serverName: unknown): string {
  if (typeof serverName !== "string") {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

export function parseJsonPayload(serverName: string, payload: string, source: string): unknown {
  try {
    const value: unknown = JSON.parse(payload);
    return value;
  } catch (error) {
    throw new Error(`Failed to parse OAuth credentials for ${serverName} from ${source}`, {
      cause: error,
    });
  }
}

function isChunkCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isChunkDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

function isAuthEntryChunkManifest(value: unknown): value is AuthEntryChunkManifest {
  if (typeof value !== "object" || value === null || !(AUTH_CHUNK_MANIFEST_KEY in value)) {
    return false;
  }
  return (
    value[AUTH_CHUNK_MANIFEST_KEY] === 1 &&
    "chunkCount" in value &&
    isChunkCount(value.chunkCount) &&
    "chunkDigest" in value &&
    isChunkDigest(value.chunkDigest)
  );
}

function getAuthEntryChunkAccount(
  account: string,
  manifest: AuthEntryChunkManifest,
  index: number,
): string {
  return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function getAuthEntryChunkAccounts(account: string, manifest: AuthEntryChunkManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) =>
    getAuthEntryChunkAccount(account, manifest, index),
  );
}

function readChunkManifestFromPayload(
  serverName: string,
  payload: string,
  source: string,
): AuthEntryChunkManifest | undefined {
  const parsed = parseJsonPayload(serverName, payload, source);
  return isAuthEntryChunkManifest(parsed) ? parsed : undefined;
}

function readExistingChunkManifest(
  store: AuthSecretStore,
  serverName: string,
  account: string,
): AuthEntryChunkManifest | undefined {
  try {
    const payload = store.read(account);
    return payload === undefined
      ? undefined
      : readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
  } catch {
    return undefined;
  }
}

function removeChunkPayloads(
  store: AuthSecretStore,
  account: string,
  manifest: AuthEntryChunkManifest,
): void {
  for (const chunkAccount of getAuthEntryChunkAccounts(account, manifest)) {
    store.remove(chunkAccount);
  }
}

function tryRemoveChunkPayloads(
  store: AuthSecretStore,
  account: string,
  manifest: AuthEntryChunkManifest | undefined,
): void {
  if (!manifest) {
    return;
  }
  try {
    removeChunkPayloads(store, account, manifest);
  } catch {
    // Stale chunk cleanup must not hide a successful credential write.
  }
}

function createChunkManifest(payload: string): AuthEntryChunkManifest {
  return {
    [AUTH_CHUNK_MANIFEST_KEY]: 1,
    chunkCount: Math.ceil(payload.length / AUTH_SECRET_CHUNK_SIZE),
    chunkDigest: createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16),
  };
}

function readChunkedAuthPayload(
  store: AuthSecretStore,
  serverName: string,
  account: string,
  manifest: AuthEntryChunkManifest,
): string {
  const chunks = getAuthEntryChunkAccounts(account, manifest).map((chunkAccount) => {
    try {
      const chunk = store.read(chunkAccount);
      if (chunk === undefined) {
        throw new Error(`Missing OAuth credential chunk ${chunkAccount} for ${serverName}`);
      }
      return chunk;
    } catch (error) {
      throw new OAuthCredentialStoreError(
        `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
        "read",
        error,
      );
    }
  });
  return chunks.join("");
}

export function writeSecureAuthEntryToStore(
  store: AuthSecretStore,
  serverName: string,
  account: string,
  entry: AuthEntry,
): void {
  const payload = JSON.stringify(entry);
  const previousManifest = readExistingChunkManifest(store, serverName, account);
  const manifest =
    payload.length > AUTH_SECRET_CHUNK_SIZE ? createChunkManifest(payload) : undefined;

  try {
    if (manifest) {
      for (let index = 0; index < manifest.chunkCount; index++) {
        const chunk = payload.slice(
          index * AUTH_SECRET_CHUNK_SIZE,
          (index + 1) * AUTH_SECRET_CHUNK_SIZE,
        );
        store.write(getAuthEntryChunkAccount(account, manifest, index), chunk);
      }
      store.write(account, JSON.stringify(manifest));
    } else {
      // Compact: multiline secrets corrupt gnome-keyring plaintext (GKeyFile) collections.
      store.write(account, payload);
    }
    if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
      tryRemoveChunkPayloads(store, account, previousManifest);
    }
  } catch (error) {
    tryRemoveChunkPayloads(store, account, manifest);
    throw new OAuthCredentialStoreError(
      `Failed to write OAuth credentials for ${serverName} to the OS secure credential store`,
      "write",
      error,
    );
  }
}

export function readSecureAuthPayloadFromStore(
  store: AuthSecretStore,
  serverName: string,
  account: string,
): CredentialPayload | undefined {
  let payload: string | undefined;
  try {
    payload = store.read(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
      "read",
      error,
    );
  }

  if (payload === undefined) {
    return undefined;
  }
  const manifest = readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
  return manifest
    ? {
        payload: readChunkedAuthPayload(store, serverName, account, manifest),
        source: "OS secure credential store chunks",
      }
    : { payload, source: "OS secure credential store" };
}

export function removeAuthEntryFromStore(
  store: AuthSecretStore,
  serverName: string,
  account: string,
): void {
  try {
    const payload = store.read(account);
    const manifest =
      payload === undefined
        ? undefined
        : readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
    if (manifest) {
      removeChunkPayloads(store, account, manifest);
    }
    store.remove(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the OS secure credential store`,
      "remove",
      error,
    );
  }
}
