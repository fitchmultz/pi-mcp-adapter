/** Child process that binds the real callback server, then must exit without an explicit stop. */
import { ensureCallbackServer } from "../../mcp-callback-server.ts";

await ensureCallbackServer({ callbackHost: "127.0.0.1" });
console.log("callback-bound");
