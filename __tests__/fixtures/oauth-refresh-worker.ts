import { createRequire, registerHooks } from "node:module";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// Never touch the host's native keyring during cross-process tests.
process.dlopen = () => {
  throw new Error("Native credential access forbidden in oauth-refresh-worker");
};
delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

const bindingPath = fileURLToPath(new URL("./android-keyring-test-binding.cjs", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@napi-rs/keyring") {
      return nextResolve(bindingPath, context);
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const fakeKeyring: unknown = require(bindingPath);
assert(
  typeof fakeKeyring === "object" && fakeKeyring !== null && "Entry" in fakeKeyring,
  "Missing Entry export in fake native keyring",
);
const entryCtor: unknown = Reflect.get(fakeKeyring, "Entry");
assert(typeof entryCtor === "function", "Expected Entry constructor");
const entryProto: unknown = Reflect.get(entryCtor, "prototype");
assert(typeof entryProto === "object" && entryProto !== null, "Missing Entry.prototype");
const originalGetPassword: unknown = Reflect.get(entryProto, "getPassword");
assert(typeof originalGetPassword === "function", "Missing Entry.prototype.getPassword");

let passwordReads = 0;
Reflect.set(entryProto, "getPassword", function getPasswordTracked(this: unknown): unknown {
  passwordReads += 1;
  const result: unknown = Reflect.apply(originalGetPassword, this, []);
  return result;
});

const { McpServerManager } = await import("../../server-manager.ts");
const auth = await import("../../mcp-auth.ts");

const mode = process.argv[2] ?? "refresh";
const url = process.argv[3];
const workerId = process.argv[4] ?? "worker";
const serverName = process.argv[5] ?? "shared-refresh";
assert(url !== undefined && url !== "", "Missing MCP server URL");

const manager = new McpServerManager();
try {
  const connection = await manager.connect(serverName, { url, auth: "oauth" });
  if (mode === "cache") {
    const readsAfterConnect = passwordReads;
    const results: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await connection.client.callTool({ name: "echo", arguments: { index } }));
    }
    writeSync(
      1,
      JSON.stringify({
        ok: true,
        readsAfterConnect,
        readsAfterCalls: passwordReads,
        results,
      }),
    );
  } else {
    writeSync(1, `${JSON.stringify({ ready: true, workerId })}\n`);
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
      process.stdin.once("end", () => resolve());
      process.stdin.resume();
    });
    const result = await connection.client.callTool({
      name: "echo",
      arguments: { worker: workerId },
    });
    const stored = auth.getAuthForUrl({ serverName, serverUrl: url })?.tokens;
    writeSync(1, JSON.stringify({ ok: true, workerId, result, stored }));
  }
} finally {
  await manager.closeAll();
}
