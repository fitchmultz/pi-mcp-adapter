import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const bundlePath = process.env.MCP_TEST_BRIDGE_BUNDLE;
if (bundlePath === undefined) {
  throw new Error("Missing bridge bundle path");
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@modelcontextprotocol/ext-apps/app-bridge") {
      return { url: pathToFileURL(bundlePath).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
