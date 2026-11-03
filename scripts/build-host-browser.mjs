#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const check = process.argv[2] === "--check";
const outfile = check ? "host-browser.bundle.js" : (process.argv[2] ?? "host-browser.bundle.js");
const result = await build({
  entryPoints: ["host-browser-entry.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  // The host page's import map resolves these to the cached app-bridge.bundle.js asset.
  external: [
    "@modelcontextprotocol/ext-apps/app-bridge",
    "@modelcontextprotocol/ext-apps",
    "@modelcontextprotocol/core",
    "zod",
  ],
  supported: { "inline-script": true },
  outfile,
  write: !check,
});

if (check) {
  const generated = result.outputFiles?.[0];
  if (generated === undefined) {
    throw new Error("Host browser generation produced no output");
  }
  const committed = await readFile(outfile);
  if (!committed.equals(generated.contents)) {
    throw new Error("host-browser.bundle.js is stale; run npm run build:browser");
  }
}
