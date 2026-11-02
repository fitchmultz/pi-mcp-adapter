import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

function escapeInlineCss(/** @type {string} */ css) {
  return css.replace(/<\/style/gi, "<\\/style");
}

function escapeInlineJs(/** @type {string} */ js) {
  // Escape both closing and opening script tags to prevent HTML parser issues
  return js.replace(/<\/script/gi, "<\\/script").replace(/<script/gi, "\\x3cscript");
}

async function bundleUi() {
  const appResult = await build({
    entryPoints: [path.join(srcDir, "ui", "app.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    minify: true,
    target: ["es2022"],
  });

  const css = await readFile(path.join(srcDir, "ui", "app.css"), "utf-8");
  const template = await readFile(path.join(srcDir, "ui", "index.html"), "utf-8");
  const bundle = appResult.outputFiles[0];
  if (!bundle) {
    throw new Error("The interactive visualizer UI bundle was not produced");
  }
  const js = escapeInlineJs(bundle.text);
  // Use function replacers to avoid $& $` $' special replacement patterns in the content
  const html = template
    .replace("/*__INLINE_CSS__*/", () => escapeInlineCss(css))
    .replace("/*__INLINE_JS__*/", () => js);

  await writeFile(path.join(distDir, "app.html"), html, "utf-8");
}

async function bundleServer() {
  await build({
    entryPoints: [path.join(srcDir, "server.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(distDir, "server.js"),
    target: ["node24"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  });
}

await mkdir(distDir, { recursive: true });
await Promise.all([bundleUi(), bundleServer()]);
