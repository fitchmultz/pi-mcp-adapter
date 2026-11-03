#!/usr/bin/env node
import { build } from "esbuild";

await build({
  stdin: {
    // The native app-bridge API plus the Zod and core bindings the host page shares.
    contents: [
      'export * from "@modelcontextprotocol/ext-apps/app-bridge";',
      'export { EmptyResultSchema } from "@modelcontextprotocol/core";',
      'export { z } from "zod";',
    ].join("\n"),
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: process.argv[2] ?? "app-bridge.bundle.js",
});
