// Offline native contracts run as an ordinary ESM consumer of the selected package.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostIndex, hostRoot } from "./compat-host.mjs";

/** @param {{ root: string, name: string, base: string }} options */
async function linkPackage({ root, name, base }) {
  const manifest = findPackageJSON(name, base);
  assert.ok(
    manifest !== undefined && manifest !== "",
    `${name} must be installed in the selected graph`,
  );
  const target = join(root, "node_modules", name);
  await mkdir(dirname(target), { recursive: true });
  await symlink(dirname(manifest), target, "junction");
}

/** @param {string} root @returns {Promise<void>} */
function executeConsumer(root) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, "probe/run.ts")], {
      cwd: root,
      env: { ...process.env, PI_PACKAGE_DIR: hostRoot, PI_CODING_AGENT_DIR: join(root, "agent") },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        accept();
      } else {
        reject(new Error(`Native consumer exited with ${String(code)} (${String(signal)})`));
      }
    });
  });
}

/** @param {string} packageRoot */
export async function verifyNativeTools(packageRoot) {
  const root = await mkdtemp(join(tmpdir(), "mcp-native-contracts-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await cp(new URL("./native-compat/", import.meta.url), join(root, "probe"), {
      recursive: true,
    });
    await copyFile(new URL("./compat-host.mjs", import.meta.url), join(root, "compat-host.mjs"));
    const target = join(root, "node_modules/@fitchmultz/pi-mcp-adapter");
    await mkdir(dirname(target), { recursive: true });
    await symlink(resolve(packageRoot), target, "junction");
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
      await linkPackage({ root, name, base: pathToFileURL(hostIndex).href });
    }
    for (const name of ["@modelcontextprotocol/core", "zod"]) {
      await linkPackage({
        root,
        name,
        base: pathToFileURL(join(resolve(packageRoot), "dist/index.js")).href,
      });
    }
    await executeConsumer(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node scripts/compat-native-tools.mjs <package-root>\nOffline native SDK/MCP contract smoke. Example: node scripts/compat-native-tools.mjs .\nExit codes: 0 passed, 1 contract failure, 2 invalid arguments.",
    );
  } else if (process.argv[2] === undefined || process.argv[2] === "") {
    process.exitCode = 2;
  } else {
    await verifyNativeTools(process.argv[2]);
  }
}
