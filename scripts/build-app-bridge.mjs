#!/usr/bin/env node
import { build } from "esbuild";

await build({
  stdin: {
    contents: 'export { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: process.argv[2] ?? "app-bridge.bundle.js",
});
