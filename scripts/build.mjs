#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the Pi extension manifest loads.
 * Responsibilities: Remove stale dist output, run TypeScript emit, and copy runtime
 * assets that modules resolve as dist-relative siblings at runtime.
 * Usage: `npm run build`; also invoked by scripts/prepare.mjs during install lifecycles.
 */

import { execFile as execFileCallback } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const tscPath = join(process.cwd(), "node_modules", ".bin", `tsc${binSuffix}`);

// Runtime siblings resolved relative to the compiled module directory
// (mcp-auth.ts, mcp-code.ts, ui-server.ts).
const RUNTIME_ASSETS = ["mcp-keyring-helper.cjs", "mcp-script-worker.mjs", "app-bridge.bundle.js"];

async function main() {
	await rm(join(process.cwd(), "dist"), { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	const options = process.platform === "win32" ? { shell: true } : {};
	try {
		const { stderr, stdout } = await execFile(tscPath, ["-p", "tsconfig.build.json"], {
			...options,
			cwd: process.cwd(),
			maxBuffer: 10 * 1024 * 1024,
		});
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	} catch (error) {
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		throw error;
	}
	for (const asset of RUNTIME_ASSETS) {
		await copyFile(join(process.cwd(), asset), join(process.cwd(), "dist", asset));
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
