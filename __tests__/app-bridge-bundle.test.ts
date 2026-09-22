import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("reproduces the committed standalone bridge with the host's Apps v2 API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "app-bridge-bundle-"));
  try {
    const output = join(dir, "app-bridge.mjs");
    execFileSync(process.execPath, [join(root, "scripts/build-app-bridge.mjs"), output], { cwd: root });
    expect(readFileSync(output, "utf8")).toBe(readFileSync(join(root, "app-bridge.bundle.js"), "utf8"));
    const { AppBridge, PostMessageTransport } = await import(/* @vite-ignore */ pathToFileURL(output).href);
    expect(typeof PostMessageTransport).toBe("function");
    const bridge = new AppBridge(null, { name: "pi", version: "1.0.0" }, {
      serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {},
    }, { hostContext: {} });
    for (const method of ["connect", "sendToolInput", "sendToolResult", "sendToolCancelled", "notification", "setHostContext", "teardownResource"]) {
      expect(typeof bridge[method], method).toBe("function");
    }
    for (const handler of ["oncalltool", "onmessage", "onupdatemodelcontext", "ondownloadfile", "onrequestdisplaymode", "onopenlink", "oninitialized", "onsizechange"]) {
      const callback = async () => ({});
      bridge[handler] = callback;
      expect(bridge[handler], handler).toBe(callback);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
