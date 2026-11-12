import { registerHooks } from "node:module";
import { mkdirSync, readSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { dirname } from "node:path";

// Even a broken fixture resolution must never reach the user's native keyring.
process.dlopen = () => {
  throw new Error("Native credential access forbidden in the storage-lock fixture");
};
delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@napi-rs/keyring") {
      return nextResolve(
        fileURLToPath(new URL("./android-keyring-test-binding.cjs", import.meta.url)),
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const auth = await import("../../mcp-auth.ts");
const identity = {
  serverName: "shared-credential-name",
  serverUrl: process.argv[3] ?? "https://first.invalid/mcp",
};
const other = { ...identity, serverUrl: "https://second.invalid/mcp" };
const action = process.argv[2];

async function verifyHttpReads(): Promise<void> {
  const { McpServerManager } = await import("../../server-manager.ts");
  const { MachineHttpServer, machineJson, machineMessageSchema, machineResult, readMachineBody } =
    await import("./oauth-machine-wire.ts");
  const methods: string[] = [];
  const token = "x".repeat(5000);
  const http = new MachineHttpServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const message = machineMessageSchema.parse(JSON.parse(await readMachineBody(request)));
    methods.push(message.method);
    if (!("id" in message)) {
      response.writeHead(202).end();
      return;
    }
    machineJson(response, {
      jsonrpc: "2.0",
      id: message.id,
      result: machineResult(message.method, "concurrent-read", "authorized"),
    });
  });
  const manager = new McpServerManager();
  try {
    const url = `${await http.listen()}/mcp`;
    auth.saveAuthEntry({ ...identity, serverUrl: url }, { tokens: { accessToken: token } });
    writeSync(1, `${JSON.stringify({ url })}\n`);
    assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1);
    const connection = await manager.connect(identity.serverName, { url, auth: "oauth" });
    const first = await connection.client.callTool({ name: "echo", arguments: {} });
    const second = await connection.client.callTool({ name: "echo", arguments: {} });
    writeSync(1, JSON.stringify({ first, second, methods }));
  } finally {
    await manager.closeAll();
    await http.close();
  }
}

try {
  if (action === "http") {
    await verifyHttpReads();
    process.exit(0);
  } else if (action === "legacy-source") {
    auth.removeAuthEntry(identity);
    const path = auth.getAuthEntryFilePath(identity.serverName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        serverUrl: identity.serverUrl,
        tokens: { accessToken: "legacy-token" },
      }),
    );
    writeSync(1, JSON.stringify({ path }));
    process.exit(0);
  } else if (action === "seed") {
    auth.saveAuthEntry(identity, {
      tokens: { accessToken: "x".repeat(5000), refreshToken: "refresh" },
      clientInfo: { clientId: "first-client" },
      codeVerifier: "verifier",
      oauthState: "state",
      futureMetadata: { kept: true },
    });
    auth.saveAuthEntry(other, {
      tokens: { accessToken: "second-token" },
      clientInfo: { clientId: "second-client" },
    });
  } else if (action === "clear") {
    auth.clearCodeVerifier(identity);
  } else if (action === "update") {
    auth.updateTokens(identity, { accessToken: "updated-token" });
  } else if (action === "client") {
    auth.updateClientInfo(identity, { clientId: "updated-client" });
  } else if (action === "logout") {
    auth.clearAllCredentials(identity);
  } else if (action === "migrate") {
    auth.migrateLegacyAuthEntry(identity);
  } else if (action === "inspect") {
    writeSync(1, JSON.stringify(auth.inspectAuthForUrl(identity)));
    process.exit(0);
  } else if (action !== "read") {
    throw new Error(`Unknown credential worker action: ${action ?? "missing"}`);
  }
  writeSync(
    1,
    JSON.stringify({ entry: auth.getAuthEntry(identity), other: auth.getAuthEntry(other) }),
  );
} catch (error) {
  if (!(error instanceof auth.OAuthCredentialStoreError)) {
    throw error;
  }
  let cause: unknown = error;
  while (cause instanceof Error) {
    console.error(cause.message);
    cause = cause.cause;
  }
  writeSync(
    1,
    JSON.stringify({
      error: {
        code: error.code,
        operation: error.operation,
        message: auth.formatOAuthCredentialStoreUnavailable(error),
      },
    }),
  );
  process.exitCode = 1;
}
